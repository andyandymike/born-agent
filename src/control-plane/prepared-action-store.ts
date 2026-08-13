import { createHmac } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import { preparedActionV1Schema, type PreparedActionV1 } from "./application-protocol.js";
import type { ControlOperationJournal } from "./control-operation-journal.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import { createPrivateJsonIfAbsent, isMissing, readBoundedPrivateJson } from "./durable-control-file.js";

const recordSchema = z.object({
  prepareIdempotencyKeySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  prepared: preparedActionV1Schema,
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  requestIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
}).strict().superRefine((value, context) => {
  const { recordSha256, ...content } = value;
  if (sha256Canonical(content) !== recordSha256) {
    context.addIssue({ code: "custom", message: "prepared action record hash mismatch" });
  }
});

export type PreparedActionRecordV1 = Readonly<z.infer<typeof recordSchema>>;

function uuidFromHmac(key: Uint8Array, value: unknown): string {
  const bytes = createHmac("sha256", key).update(sha256Canonical(value), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PreparedActionStore {
  constructor(
    private readonly integrityKey: Uint8Array,
    private readonly paths: ControlStatePaths,
  ) {
    if (integrityKey.byteLength !== 32) throw new TypeError("prepared action key must be 32 bytes");
  }

  preparedActionId(principalId: string, prepareIdempotencyKey: string): string {
    return uuidFromHmac(this.integrityKey, {
      kind: "prepared_action",
      prepare_idempotency_key: prepareIdempotencyKey,
      principal_id: principalId,
      schema_version: 1,
    });
  }

  prepareIdempotencyKeySha256(principalId: string, key: string): string {
    return sha256Canonical({ key, namespace: `prepare:${principalId}`, schema_version: 1 });
  }

  async create(input: {
    readonly prepareIdempotencyKey: string;
    readonly prepared: PreparedActionV1;
    readonly requestIdentitySha256: string;
  }): Promise<{ readonly created: boolean; readonly record: PreparedActionRecordV1 }> {
    const expectedId = this.preparedActionId(input.prepared.principalId, input.prepareIdempotencyKey);
    if (expectedId !== input.prepared.preparedActionId) {
      throw new ApplicationControlError("control_prepared_action_mismatch", "prepared action ID is not Host-derived");
    }
    const content = {
      prepareIdempotencyKeySha256: this.prepareIdempotencyKeySha256(
        input.prepared.principalId,
        input.prepareIdempotencyKey,
      ),
      prepared: input.prepared,
      requestIdentitySha256: input.requestIdentitySha256,
      schemaVersion: 1 as const,
    };
    const record = Object.freeze(recordSchema.parse({ ...content, recordSha256: sha256Canonical(content) }));
    const target = join(this.paths.prepareRoot, `${input.prepared.preparedActionId}.json`);
    const result = await createPrivateJsonIfAbsent({ paths: this.paths, target, value: record });
    if (result === "created") return Object.freeze({ created: true, record });
    const existing = await this.read(input.prepared.preparedActionId);
    if (existing === null) {
      throw new ApplicationControlError("control_operation_corrupt", "prepared action disappeared after create conflict");
    }
    if (existing.requestIdentitySha256 !== input.requestIdentitySha256) {
      throw new ApplicationControlError("control_idempotency_conflict", "prepare idempotency key is bound to another request");
    }
    return Object.freeze({ created: false, record: existing });
  }

  async read(preparedActionId: string): Promise<PreparedActionRecordV1 | null> {
    if (!z.string().uuid().safeParse(preparedActionId).success) {
      throw new ApplicationControlError("control_prepared_action_not_found", "prepared action ID is invalid");
    }
    try {
      return Object.freeze(recordSchema.parse(
        await readBoundedPrivateJson(join(this.paths.prepareRoot, `${preparedActionId}.json`), 128 * 1024),
      ));
    } catch (error) {
      if (isMissing(error) || isMissing((error as ErrorOptions).cause)) return null;
      if (error instanceof ApplicationControlError) throw error;
      throw new ApplicationControlError("control_operation_corrupt", "prepared action record is corrupt", { cause: error });
    }
  }

  async claimProjection(
    preparedActionId: string,
    journal: ControlOperationJournal,
    now: Date,
  ): Promise<Readonly<{
    acceptedOperationRecordSha256: string | null;
    claimedOperationId: string | null;
    preparedActionId: string;
    preparedActionSha256: string;
    state: "unclaimed" | "claimed" | "consumed" | "blocked_unknown_effect" | "rejected_known_not_started";
  }>> {
    const record = await this.read(preparedActionId);
    if (record === null) {
      throw new ApplicationControlError("control_prepared_action_not_found", "prepared action does not exist");
    }
    const operation = await journal.findByPreparedAction(preparedActionId);
    if (operation === null) {
      return Object.freeze({
        acceptedOperationRecordSha256: null,
        claimedOperationId: null,
        preparedActionId,
        preparedActionSha256: record.prepared.preparedActionSha256,
        state: "unclaimed",
      });
    }
    const state = operation.state === "completed"
      ? "consumed"
      : operation.state === "blocked_unknown_effect"
        ? "blocked_unknown_effect"
        : ["blocked_stale", "failed_internal", "rejected_known_not_started"].includes(operation.state)
          ? "rejected_known_not_started"
          : "claimed";
    void now;
    return Object.freeze({
      acceptedOperationRecordSha256: operation.recordSha256,
      claimedOperationId: operation.operationId,
      preparedActionId,
      preparedActionSha256: record.prepared.preparedActionSha256,
      state,
    });
  }
}

