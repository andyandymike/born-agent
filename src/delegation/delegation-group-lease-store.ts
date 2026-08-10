import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  ProcessIdentityProbe,
  ProcessIdentityProbeResult,
} from "../sessions/process-identity.js";
import { parseStrictJson } from "../system/strict-json.js";
import { DelegationError } from "./delegation-errors.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"));

const delegationGroupLeaseContentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  repositoryId: sha256,
  sessionId: uuid,
  groupId: uuid,
  parentActorId: uuid,
  parentRunId: uuid,
  graphBindingSha256: sha256.nullable(),
  ownerKind: z.enum(["foreground", "phase19_background_worker"]),
  ownerPid: z.number().int().positive(),
  ownerProcessStartIdentity: z.string().min(1).max(512),
  ownerBackgroundOperationId: uuid.nullable(),
  nonceSha256: sha256,
  acquiredAt: timestamp,
  updatedAt: timestamp,
  state: z.enum(["active", "reconciliation_required", "released"]),
  releaseReason: z.enum(["terminal", "cancelled", "reconciled"]).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.ownerKind === "phase19_background_worker") !== (value.ownerBackgroundOperationId !== null)) {
    context.addIssue({
      code: "custom",
      message: "background delegation ownership requires one exact Phase 19 operation",
    });
  }
  if ((value.state === "released") !== (value.releaseReason !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a released delegation group may carry a release reason",
    });
  }
});

export const delegationGroupLeaseRecordSchema = delegationGroupLeaseContentSchema.extend({
  leaseSha256: sha256,
}).strict().superRefine((value, context) => {
  const { leaseSha256, ...content } = value;
  if (sha256Canonical(content) !== leaseSha256) {
    context.addIssue({ code: "custom", message: "delegation group lease hash mismatch" });
  }
});

export type DelegationGroupLeaseRecordV1 = Readonly<z.infer<typeof delegationGroupLeaseRecordSchema>>;

function record(content: unknown): DelegationGroupLeaseRecordV1 {
  const parsed = delegationGroupLeaseContentSchema.parse(content);
  return Object.freeze(delegationGroupLeaseRecordSchema.parse({
    ...parsed,
    leaseSha256: sha256Canonical(parsed),
  }));
}

function revise(
  current: DelegationGroupLeaseRecordV1,
  changes: Partial<Omit<DelegationGroupLeaseRecordV1, "leaseSha256">>,
): DelegationGroupLeaseRecordV1 {
  const content: Record<string, unknown> = { ...current };
  Reflect.deleteProperty(content, "leaseSha256");
  return record({ ...content, ...changes });
}

function revisionName(revision: number): string {
  return `${String(revision).padStart(8, "0")}.json`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isProvenDead(observation: ProcessIdentityProbeResult): boolean {
  return observation === "missing" || observation === "different";
}

/**
 * Repository-scoped append-only CAS for one exact delegation coordinator.
 * An exclusive revision create is the cross-process winner decision; session
 * events describe the result but are not used as the mutual-exclusion lock.
 */
export class DelegationGroupLeaseStore {
  private constructor(
    private readonly directory: string,
    readonly repositoryId: string,
  ) {}

  static async create(input: {
    readonly repositoryId: string;
    readonly root: string;
  }): Promise<DelegationGroupLeaseStore> {
    if (!/^[a-f0-9]{64}$/u.test(input.repositoryId)) {
      throw new DelegationError("delegation_child_protocol_invalid", "delegation repository identity is invalid");
    }
    const directory = resolve(
      input.root,
      "delegations",
      "repositories",
      "v1",
      input.repositoryId,
      "group-lease",
    );
    await mkdir(directory, { recursive: true });
    return new DelegationGroupLeaseStore(directory, input.repositoryId);
  }

  static async openExisting(input: {
    readonly repositoryId: string;
    readonly root: string;
  }): Promise<DelegationGroupLeaseStore> {
    const store = await DelegationGroupLeaseStore.create(input);
    try {
      const metadata = await lstat(store.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease path is unsafe");
      }
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease path is unavailable", { cause: error });
    }
    return store;
  }

  static async listExisting(root: string): Promise<readonly DelegationGroupLeaseStore[]> {
    const directory = resolve(root, "delegations", "repositories", "v1");
    let names: readonly string[];
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegation repository lease root is unsafe");
      }
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "delegation repository lease root is unavailable", { cause: error });
    }
    const stores: DelegationGroupLeaseStore[] = [];
    for (const repositoryId of [...names].sort()) {
      if (!/^[a-f0-9]{64}$/u.test(repositoryId)) continue;
      stores.push(await DelegationGroupLeaseStore.openExisting({ repositoryId, root }));
    }
    return Object.freeze(stores);
  }

  async read(): Promise<DelegationGroupLeaseRecordV1 | null> {
    let names: readonly string[];
    try {
      names = (await readdir(this.directory))
        .filter((name) => /^[0-9]{8}\.json$/u.test(name))
        .sort();
    } catch (error) {
      if (isMissing(error)) return null;
      throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease journal is unavailable", { cause: error });
    }
    const latest = names.at(-1);
    if (latest === undefined) return null;
    let handle;
    try {
      handle = await open(join(this.directory, latest), "r");
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > 32 * 1024) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease revision is not a bounded regular file");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease changed while being read");
      }
      return Object.freeze(delegationGroupLeaseRecordSchema.parse(parseStrictJson(bytes.toString("utf8"))));
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "delegation group lease revision is corrupt", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async acquire(input: {
    readonly acquiredAt: string;
    readonly graphBindingSha256: string | null;
    readonly groupId: string;
    readonly nonceSha256: string;
    readonly ownerBackgroundOperationId: string | null;
    readonly ownerKind: "foreground" | "phase19_background_worker";
    readonly ownerPid: number;
    readonly ownerProcessStartIdentity: string;
    readonly parentActorId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
  }): Promise<DelegationGroupLeaseRecordV1> {
    const current = await this.read();
    if (current !== null && current.state !== "released") {
      throw new DelegationError("delegation_lease_busy", "repository already has an active or unreconciled delegation group");
    }
    const next = record({
      ...input,
      repositoryId: this.repositoryId,
      releaseReason: null,
      revision: (current?.revision ?? 0) + 1,
      schemaVersion: 1,
      state: "active",
      updatedAt: input.acquiredAt,
    });
    await this.#createRevision(next);
    return next;
  }

  async takeover(input: {
    readonly effectsReconciled: boolean;
    readonly expectedLeaseSha256: string;
    readonly newNonceSha256: string;
    readonly newOwnerBackgroundOperationId: string | null;
    readonly newOwnerKind: "foreground" | "phase19_background_worker";
    readonly newOwnerPid: number;
    readonly newOwnerProcessStartIdentity: string;
    readonly now: string;
    readonly ownerProbe: ProcessIdentityProbe;
  }): Promise<DelegationGroupLeaseRecordV1> {
    const current = await this.read();
    if (current === null || current.state !== "active" || current.leaseSha256 !== input.expectedLeaseSha256) {
      throw new DelegationError("delegation_lease_busy", "delegation group takeover lost its exact durable lease CAS");
    }
    const observation = await input.ownerProbe.probe({
      pid: current.ownerPid,
      startIdentity: current.ownerProcessStartIdentity,
    });
    if (!isProvenDead(observation) || !input.effectsReconciled) {
      throw new DelegationError("delegation_effect_reconciliation_required", "delegation takeover requires proven owner death and reconciled child effects");
    }
    const next = revise(current, {
      nonceSha256: input.newNonceSha256,
      ownerBackgroundOperationId: input.newOwnerBackgroundOperationId,
      ownerKind: input.newOwnerKind,
      ownerPid: input.newOwnerPid,
      ownerProcessStartIdentity: input.newOwnerProcessStartIdentity,
      revision: current.revision + 1,
      updatedAt: input.now,
    });
    await this.#createRevision(next);
    return next;
  }

  async release(input: {
    readonly effectsReconciled: boolean;
    readonly expectedLeaseSha256: string;
    readonly now: string;
    readonly reason: "terminal" | "cancelled" | "reconciled";
  }): Promise<DelegationGroupLeaseRecordV1> {
    const current = await this.read();
    if (current === null || current.state !== "active" || current.leaseSha256 !== input.expectedLeaseSha256) {
      throw new DelegationError("delegation_lease_busy", "delegation group release lost its exact durable lease CAS");
    }
    if (!input.effectsReconciled) {
      throw new DelegationError("delegation_effect_reconciliation_required", "delegation group cannot release while child effects are unresolved");
    }
    const next = revise(current, {
      releaseReason: input.reason,
      revision: current.revision + 1,
      state: "released",
      updatedAt: input.now,
    });
    await this.#createRevision(next);
    return next;
  }

  async markReconciliationRequired(input: {
    readonly expectedLeaseSha256: string;
    readonly now: string;
  }): Promise<DelegationGroupLeaseRecordV1> {
    const current = await this.read();
    if (current === null || current.state !== "active" || current.leaseSha256 !== input.expectedLeaseSha256) {
      throw new DelegationError("delegation_lease_busy", "delegation reconciliation marker lost its exact durable lease CAS");
    }
    const next = revise(current, {
      revision: current.revision + 1,
      state: "reconciliation_required",
      updatedAt: input.now,
    });
    await this.#createRevision(next);
    return next;
  }

  async #createRevision(value: DelegationGroupLeaseRecordV1): Promise<void> {
    let handle;
    try {
      handle = await open(join(this.directory, revisionName(value.revision)), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      throw new DelegationError("delegation_lease_busy", "delegation group lease CAS was won by another process", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
