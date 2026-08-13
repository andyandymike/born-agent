import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { currentProcessIdentity, type ProcessIdentity } from "../sessions/process-identity.js";
import { ApplicationControlError } from "./application-errors.js";
import type {
  ApplicationActionTargetV1,
  ArtifactReferenceV1,
  ExpectedResourceVersionV1,
  ProjectionIdentityV1,
  ResourceScopeV1,
} from "./application-protocol.js";
import { withControlFileLock } from "./control-file-lock.js";
import {
  assertControlOperationRecordTransition,
  assertControlOperationTransition,
  controlOperationRecordV1Schema,
  createControlOperationRecord,
  type ControlOperationOwnerClaimV1,
  type ControlOperationRecordV1,
  type ControlOperationStateV1,
  type DurableRecordReferenceV1,
} from "./control-operation-schema.js";
import { reconcileControlOperationDriver } from "./control-operation-reconciler.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import { createPrivateJsonIfAbsent, readBoundedPrivateJson } from "./durable-control-file.js";

const indexSchema = z.object({
  indexSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  indexValueSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(["prepared_action", "idempotency"]),
  operationId: z.string().uuid(),
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
}).strict().superRefine((value, context) => {
  const { indexSha256, ...content } = value;
  if (sha256Canonical(content) !== indexSha256) {
    context.addIssue({ code: "custom", message: "operation index hash mismatch" });
  }
});

export interface AcceptControlOperationInputV1 {
  readonly actionKind: string;
  readonly idempotencyKey: string;
  readonly idempotencyNamespace: string;
  readonly preparedActionId: string;
  readonly preparedActionSha256: string;
  readonly requestIdentitySha256: string;
  readonly target: ApplicationActionTargetV1;
}

export interface AcceptControlOperationResultV1 {
  readonly created: boolean;
  readonly operation: ControlOperationRecordV1;
}

export interface ControlOperationDriverClaimV1 {
  readonly claimEpoch: number;
  readonly operationId: string;
  readonly processStartIdentitySha256: string;
}

export type AcquireControlOperationDriverResultV1 =
  | Readonly<{
      claim: ControlOperationDriverClaimV1;
      kind: "acquired";
      operation: ControlOperationRecordV1;
      reconcileOnly: boolean;
      takeover: boolean;
    }>
  | Readonly<{ kind: "busy"; operation: ControlOperationRecordV1 }>
  | Readonly<{ kind: "blocked_unknown_effect"; operation: ControlOperationRecordV1 }>
  | Readonly<{ kind: "terminal"; operation: ControlOperationRecordV1 }>;

export interface ControlOperationJournalOptionsV1 {
  readonly driverLeaseMs?: number;
  readonly now?: () => Date;
  readonly processIdentity?: ProcessIdentity;
}

type ControlOperationUpdatePatchV1 = Readonly<{
  domainRecordRefs?: readonly DurableRecordReferenceV1[];
  errorCode?: string | null;
  ownerClaim?: ControlOperationOwnerClaimV1 | null;
  primaryDomainRecord?: DurableRecordReferenceV1 | null;
  resolvedResourceScope?: ResourceScopeV1 | null;
  resolvedResourceVersion?: ExpectedResourceVersionV1 | null;
  resultArtifact?: ArtifactReferenceV1 | null;
  resultProjectionIdentity?: ProjectionIdentityV1 | null;
  state: ControlOperationStateV1;
  underlyingOperationRefs?: readonly DurableRecordReferenceV1[];
}>;

type ClaimedControlOperationUpdatePatchV1 = Omit<ControlOperationUpdatePatchV1, "ownerClaim">;

function revisionName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.json`;
}

function idempotencyKeySha256(namespace: string, key: string): string {
  return sha256Canonical({ idempotency_key: key, namespace, schema_version: 1 });
}

export class ControlOperationJournal {
  readonly driverHeartbeatIntervalMs: number;
  private readonly driverLeaseMs: number;
  private readonly now: () => Date;
  private readonly processStartIdentitySha256: string;
  private readonly indexRoot: string;

  constructor(
    private readonly paths: ControlStatePaths,
    options: ControlOperationJournalOptionsV1 = {},
  ) {
    this.indexRoot = join(paths.operationRoot, "indexes");
    this.driverLeaseMs = options.driverLeaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.driverLeaseMs) || this.driverLeaseMs < 100) {
      throw new TypeError("control operation driver lease must be at least 100 ms");
    }
    this.driverHeartbeatIntervalMs = Math.max(25, Math.floor(this.driverLeaseMs / 3));
    this.now = options.now ?? (() => new Date());
    const identity = options.processIdentity ?? currentProcessIdentity();
    this.processStartIdentitySha256 = sha256Canonical({
      process_start_identity: identity.startIdentity,
      schema_version: 1,
    });
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.indexRoot,
      join(this.indexRoot, "prepared"),
      join(this.indexRoot, "idempotency"),
    ]) {
      await mkdir(directory, { mode: 0o700, recursive: true });
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ApplicationControlError("control_operation_corrupt", "operation index path is unsafe");
      }
    }
  }

  async accept(input: AcceptControlOperationInputV1): Promise<AcceptControlOperationResultV1> {
    await this.initialize();
    const preparedLock = sha256Canonical({ kind: "prepared_action_claim", prepared_action_id: input.preparedActionId });
    return withControlFileLock({ keySha256: preparedLock, paths: this.paths }, async () => {
      const preparedWinner = await this.findByPreparedAction(input.preparedActionId);
      if (preparedWinner !== null) {
        if (preparedWinner.preparedActionSha256 !== input.preparedActionSha256) {
          throw new ApplicationControlError("control_prepared_action_mismatch", "prepared action ID is bound to another hash");
        }
        return Object.freeze({ created: false, operation: preparedWinner });
      }
      const keySha256 = idempotencyKeySha256(input.idempotencyNamespace, input.idempotencyKey);
      const idempotencyLock = sha256Canonical({ kind: "idempotency", key_sha256: keySha256 });
      return withControlFileLock({ keySha256: idempotencyLock, paths: this.paths }, async () => {
        const idempotencyWinner = await this.findByIdempotency(input.idempotencyNamespace, keySha256);
        if (idempotencyWinner !== null) {
          if (idempotencyWinner.requestIdentitySha256 !== input.requestIdentitySha256) {
            throw new ApplicationControlError("control_idempotency_conflict", "idempotency key is bound to a different request identity");
          }
          return Object.freeze({ created: false, operation: idempotencyWinner });
        }
        const operation = createControlOperationRecord({
          actionKind: input.actionKind,
          domainRecordRefs: [],
          errorCode: null,
          idempotencyKeySha256: keySha256,
          idempotencyNamespace: input.idempotencyNamespace,
          operationId: randomUUID(),
          operationRevision: 1,
          ownerClaim: null,
          preparedActionId: input.preparedActionId,
          preparedActionSha256: input.preparedActionSha256,
          previousOperationRecordSha256: null,
          primaryDomainRecord: null,
          requestIdentitySha256: input.requestIdentitySha256,
          resolvedResourceScope: null,
          resolvedResourceVersion: null,
          resultArtifact: null,
          resultProjectionIdentity: null,
          state: "accepted",
          target: input.target,
          underlyingOperationRefs: [],
        });
        await this.createInitial(operation);
        await this.writeIndex("prepared_action", sha256Canonical(input.preparedActionId), operation);
        await this.writeIndex("idempotency", keySha256, operation);
        return Object.freeze({ created: true, operation });
      });
    });
  }

  /**
   * Acquire the only durable driver for one operation. An expired post-dispatch
   * owner is reconciled to unknown before this method returns; it is never
   * handed to a replacement executor.
   */
  async acquireDriver(
    operationId: string,
    options: Readonly<{ readonly allowPostDispatchReconcile?: boolean }> = {},
  ): Promise<AcquireControlOperationDriverResultV1> {
    const lockKey = sha256Canonical({ kind: "operation", operation_id: operationId });
    return withControlFileLock({ keySha256: lockKey, paths: this.paths }, async () => {
      const history = await this.readHistory(operationId);
      const current = history.at(-1);
      if (current === undefined) {
        throw new ApplicationControlError("control_operation_not_found", "operation does not exist");
      }
      const now = this.now();
      const reconciliation = reconcileControlOperationDriver(current, now, options);
      if (reconciliation.kind === "terminal") {
        return Object.freeze({ kind: "terminal", operation: current });
      }
      if (reconciliation.kind === "busy") {
        return Object.freeze({ kind: "busy", operation: current });
      }
      if (reconciliation.kind === "block_unknown_effect") {
        const blocked = await this.appendRevisionLocked(current, {
          errorCode: "control_driver_owner_lost_after_dispatch",
          ownerClaim: null,
          state: "blocked_unknown_effect",
        });
        return Object.freeze({ kind: "blocked_unknown_effect", operation: blocked });
      }
      const previousEpoch = history.reduce(
        (maximum, record) => Math.max(maximum, record.ownerClaim?.claimEpoch ?? 0),
        0,
      );
      if (previousEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new ApplicationControlError("control_operation_corrupt", "operation driver epoch is exhausted");
      }
      const durableClaim: ControlOperationOwnerClaimV1 = Object.freeze({
        acquiredAt: now.toISOString(),
        claimEpoch: previousEpoch + 1,
        expiresAt: new Date(now.getTime() + this.driverLeaseMs).toISOString(),
        processStartIdentitySha256: this.processStartIdentitySha256,
      });
      const claimed = await this.appendRevisionLocked(current, {
        ownerClaim: durableClaim,
        state: current.state,
      });
      const claim = Object.freeze({
        claimEpoch: durableClaim.claimEpoch,
        operationId,
        processStartIdentitySha256: durableClaim.processStartIdentitySha256,
      });
      return Object.freeze({
        claim,
        kind: "acquired",
        operation: claimed,
        reconcileOnly: current.state === "domain_append_started" ||
          (current.state === "domain_records_linked" && current.resultArtifact === null),
        takeover: reconciliation.takeover || previousEpoch > 0,
      });
    });
  }

  async renewDriver(claim: ControlOperationDriverClaimV1): Promise<ControlOperationRecordV1> {
    return this.withClaimedOperation(claim, async (current) => {
      if (current.ownerClaim === null) return current;
      const expiresAt = new Date(this.now().getTime() + this.driverLeaseMs).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(current.ownerClaim.expiresAt)) return current;
      return this.appendRevisionLocked(current, {
        ownerClaim: Object.freeze({ ...current.ownerClaim, expiresAt }),
        state: current.state,
      });
    });
  }

  async updateClaimed(input: {
    readonly claim: ControlOperationDriverClaimV1;
    readonly patch: ClaimedControlOperationUpdatePatchV1;
  }): Promise<ControlOperationRecordV1> {
    return this.withClaimedOperation(input.claim, async (current) => {
      assertControlOperationTransition(current.state, input.patch.state);
      const terminal = [
        "blocked_stale",
        "blocked_unknown_effect",
        "completed",
        "failed_internal",
        "rejected_known_not_started",
      ].includes(input.patch.state);
      const ownerClaim = terminal || current.ownerClaim === null
        ? null
        : Object.freeze({
            ...current.ownerClaim,
            expiresAt: new Date(this.now().getTime() + this.driverLeaseMs).toISOString(),
          });
      return this.appendRevisionLocked(current, { ...input.patch, ownerClaim });
    });
  }

  /**
   * Drop a pre-dispatch lease. If the driver exits after dispatch began, the
   * durable operation is made unknown instead of becoming executable again.
   * A complete linked result is the sole exception: a later driver may only
   * advance result_built/completed and cannot invoke the domain owner again.
   */
  async releaseDriver(
    claim: ControlOperationDriverClaimV1,
    options: Readonly<{ readonly allowPostDispatchReconcile?: boolean }> = {},
  ): Promise<ControlOperationRecordV1> {
    return this.withClaimedOperation(claim, async (current) => {
      if (current.ownerClaim === null) return current;
      if (current.state === "domain_records_linked") {
        const primaryIsLinked = current.primaryDomainRecord !== null &&
          current.domainRecordRefs.some((reference) =>
            reference.recordId === current.primaryDomainRecord?.recordId &&
            reference.recordSha256 === current.primaryDomainRecord.recordSha256
          );
        if (
          primaryIsLinked &&
          current.resolvedResourceScope !== null &&
          current.resolvedResourceVersion !== null &&
          (current.resultArtifact !== null || options.allowPostDispatchReconcile === true)
        ) {
          return this.appendRevisionLocked(current, { ownerClaim: null, state: current.state });
        }
      }
      if (
        current.state === "domain_append_started" &&
        options.allowPostDispatchReconcile === true
      ) {
        // PHASE21: an action-specific reconciler is the only safe way to
        // release this post-dispatch prefix without inventing a terminal or
        // permitting execute to run again. The next driver is reconcile-only.
        return this.appendRevisionLocked(current, { ownerClaim: null, state: current.state });
      }
      if (current.state === "domain_append_started" || current.state === "domain_records_linked") {
        return this.appendRevisionLocked(current, {
          errorCode: "control_driver_stopped_after_dispatch",
          ownerClaim: null,
          state: "blocked_unknown_effect",
        });
      }
      return this.appendRevisionLocked(current, { ownerClaim: null, state: current.state });
    });
  }

  async read(operationId: string): Promise<ControlOperationRecordV1 | null> {
    return (await this.readHistory(operationId)).at(-1) ?? null;
  }

  private async readHistory(operationId: string): Promise<readonly ControlOperationRecordV1[]> {
    if (!z.string().uuid().safeParse(operationId).success) {
      throw new ApplicationControlError("control_operation_not_found", "operation ID is invalid");
    }
    const directory = join(this.paths.operationRoot, operationId);
    let names: string[];
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ApplicationControlError("control_operation_corrupt", "operation journal path is unsafe");
      }
      names = (await readdir(directory)).filter((name) => /^[0-9]{12}\.json$/u.test(name)).sort();
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    if (names.length === 0) return Object.freeze([]);
    const history: ControlOperationRecordV1[] = [];
    let previous: ControlOperationRecordV1 | null = null;
    for (let index = 0; index < names.length; index += 1) {
      const revision = index + 1;
      if (names[index] !== revisionName(revision)) {
        throw new ApplicationControlError("control_operation_corrupt", "operation revisions are not contiguous");
      }
      let record: ControlOperationRecordV1;
      try {
        record = controlOperationRecordV1Schema.parse(
          await readBoundedPrivateJson(join(directory, names[index]!), 1024 * 1024),
        );
      } catch (error) {
        throw new ApplicationControlError("control_operation_corrupt", "operation revision is corrupt", { cause: error });
      }
      if (
        record.operationId !== operationId ||
        record.operationRevision !== revision ||
        record.previousOperationRecordSha256 !== previous?.recordSha256 && !(previous === null && record.previousOperationRecordSha256 === null)
      ) {
        throw new ApplicationControlError("control_operation_corrupt", "operation revision chain is inconsistent");
      }
      if (previous !== null) assertControlOperationRecordTransition(previous, record);
      previous = Object.freeze(record);
      history.push(previous);
    }
    return Object.freeze(history);
  }

  async list(): Promise<readonly ControlOperationRecordV1[]> {
    await this.initialize();
    const names = (await readdir(this.paths.operationRoot)).filter((name) => z.string().uuid().safeParse(name).success).sort();
    if (names.length > 10_000) {
      throw new ApplicationControlError("control_operation_corrupt", "operation journal exceeds its hard bound");
    }
    const records: ControlOperationRecordV1[] = [];
    for (const name of names) {
      const record = await this.read(name);
      if (record !== null) records.push(record);
    }
    return Object.freeze(records);
  }

  async update(input: {
    readonly expectedRecordSha256: string;
    readonly operationId: string;
    readonly patch: ControlOperationUpdatePatchV1;
  }): Promise<ControlOperationRecordV1> {
    const lockKey = sha256Canonical({ kind: "operation", operation_id: input.operationId });
    return withControlFileLock({ keySha256: lockKey, paths: this.paths }, async () => {
      const current = await this.read(input.operationId);
      if (current === null) {
        throw new ApplicationControlError("control_operation_not_found", "operation does not exist");
      }
      if (current.recordSha256 !== input.expectedRecordSha256) {
        throw new ApplicationControlError("control_operation_busy", "operation compare-and-swap lost ownership");
      }
      if (current.ownerClaim !== null) {
        throw new ApplicationControlError("control_operation_busy", "operation has a durable driver owner");
      }
      if (input.patch.ownerClaim !== undefined && input.patch.ownerClaim !== null) {
        throw new ApplicationControlError("control_operation_busy", "driver claims require acquireDriver");
      }
      assertControlOperationTransition(current.state, input.patch.state);
      return this.appendRevisionLocked(current, input.patch);
    });
  }

  private async withClaimedOperation<T>(
    claim: ControlOperationDriverClaimV1,
    operation: (current: ControlOperationRecordV1) => Promise<T>,
  ): Promise<T> {
    const lockKey = sha256Canonical({ kind: "operation", operation_id: claim.operationId });
    return withControlFileLock({ keySha256: lockKey, paths: this.paths }, async () => {
      const current = await this.read(claim.operationId);
      if (current === null) {
        throw new ApplicationControlError("control_operation_not_found", "operation does not exist");
      }
      if (current.ownerClaim === null) {
        if ([
          "blocked_stale",
          "blocked_unknown_effect",
          "completed",
          "failed_internal",
          "rejected_known_not_started",
        ].includes(current.state)) {
          return operation(current);
        }
        throw new ApplicationControlError("control_operation_busy", "operation driver claim is no longer current");
      }
      if (
        current.ownerClaim.claimEpoch !== claim.claimEpoch ||
        current.ownerClaim.processStartIdentitySha256 !== claim.processStartIdentitySha256
      ) {
        throw new ApplicationControlError("control_operation_busy", "operation is owned by another durable driver");
      }
      return operation(current);
    });
  }

  private async appendRevisionLocked(
    current: ControlOperationRecordV1,
    patch: Partial<ControlOperationUpdatePatchV1> & Pick<ControlOperationUpdatePatchV1, "state">,
  ): Promise<ControlOperationRecordV1> {
    const currentContent = { ...current } as { recordSha256?: string } &
      Omit<ControlOperationRecordV1, "recordSha256">;
    delete currentContent.recordSha256;
    const next = createControlOperationRecord({
      ...currentContent,
      ...patch,
      domainRecordRefs: [...(patch.domainRecordRefs ?? current.domainRecordRefs)],
      operationRevision: current.operationRevision + 1,
      previousOperationRecordSha256: current.recordSha256,
      underlyingOperationRefs: [...(patch.underlyingOperationRefs ?? current.underlyingOperationRefs)],
    });
    assertControlOperationRecordTransition(current, next);
    const result = await createPrivateJsonIfAbsent({
      paths: this.paths,
      target: join(this.paths.operationRoot, current.operationId, revisionName(next.operationRevision)),
      value: next,
    });
    if (result !== "created") {
      throw new ApplicationControlError("control_operation_busy", "operation revision already exists");
    }
    const committed = await this.read(current.operationId);
    if (committed?.recordSha256 !== next.recordSha256) {
      throw new ApplicationControlError("control_operation_corrupt", "operation update readback mismatch");
    }
    return committed;
  }

  async findByPreparedAction(preparedActionId: string): Promise<ControlOperationRecordV1 | null> {
    const indexed = await this.readIndex("prepared_action", sha256Canonical(preparedActionId));
    if (indexed !== null) return indexed;
    const matches = (await this.list()).filter((record) => record.preparedActionId === preparedActionId);
    if (matches.length > 1) {
      throw new ApplicationControlError("control_operation_corrupt", "prepared action has more than one operation winner");
    }
    if (matches[0] !== undefined) {
      await this.writeIndex("prepared_action", sha256Canonical(preparedActionId), matches[0]);
    }
    return matches[0] ?? null;
  }

  private async findByIdempotency(
    namespace: string,
    keySha256: string,
  ): Promise<ControlOperationRecordV1 | null> {
    const indexed = await this.readIndex("idempotency", keySha256);
    if (indexed !== null) return indexed;
    const matches = (await this.list()).filter(
      (record) => record.idempotencyNamespace === namespace && record.idempotencyKeySha256 === keySha256,
    );
    if (matches.length > 1) {
      throw new ApplicationControlError("control_operation_corrupt", "idempotency key has more than one operation winner");
    }
    if (matches[0] !== undefined) await this.writeIndex("idempotency", keySha256, matches[0]);
    return matches[0] ?? null;
  }

  private async createInitial(operation: ControlOperationRecordV1): Promise<void> {
    const directory = join(this.paths.operationRoot, operation.operationId);
    await mkdir(directory, { mode: 0o700, recursive: false });
    const result = await createPrivateJsonIfAbsent({
      paths: this.paths,
      target: join(directory, revisionName(1)),
      value: operation,
    });
    if (result !== "created") {
      throw new ApplicationControlError("control_operation_busy", "operation accepted record already exists");
    }
    const readback = await this.read(operation.operationId);
    if (readback?.recordSha256 !== operation.recordSha256) {
      throw new ApplicationControlError("control_operation_corrupt", "accepted operation readback mismatch");
    }
  }

  private async readIndex(
    kind: "prepared_action" | "idempotency",
    valueSha256: string,
  ): Promise<ControlOperationRecordV1 | null> {
    const directory = kind === "prepared_action" ? "prepared" : "idempotency";
    try {
      const index = indexSchema.parse(
        await readBoundedPrivateJson(join(this.indexRoot, directory, `${valueSha256}.json`), 8 * 1024),
      );
      if (index.kind !== kind || index.indexValueSha256 !== valueSha256) {
        throw new ApplicationControlError("control_operation_corrupt", "operation index identity mismatch");
      }
      const history = await this.readHistory(index.operationId);
      const record = history.at(-1) ?? null;
      if (record === null) {
        throw new ApplicationControlError("control_operation_corrupt", "operation index target is missing");
      }
      // PHASE21: indexes are immutable first-winner facts and may validly lag
      // the current revision. Their stored hash must nevertheless name one
      // exact record in this operation's verified history chain.
      if (!history.some((candidate) => candidate.recordSha256 === index.recordSha256)) {
        throw new ApplicationControlError(
          "control_operation_corrupt",
          "operation index record is outside the target history chain",
        );
      }
      return record;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      if (error instanceof ApplicationControlError) throw error;
      throw new ApplicationControlError("control_operation_corrupt", "operation index is corrupt", { cause: error });
    }
  }

  private async writeIndex(
    kind: "prepared_action" | "idempotency",
    valueSha256: string,
    operation: ControlOperationRecordV1,
  ): Promise<void> {
    const content = {
      indexValueSha256: valueSha256,
      kind,
      operationId: operation.operationId,
      recordSha256: operation.recordSha256,
      schemaVersion: 1 as const,
    };
    const index = indexSchema.parse({ ...content, indexSha256: sha256Canonical(content) });
    const directory = kind === "prepared_action" ? "prepared" : "idempotency";
    const target = join(this.indexRoot, directory, `${valueSha256}.json`);
    const result = await createPrivateJsonIfAbsent({ paths: this.paths, target, value: index });
    if (result === "exists") {
      const existing = indexSchema.parse(await readBoundedPrivateJson(target, 8 * 1024));
      if (existing.operationId !== operation.operationId) {
        throw new ApplicationControlError("control_operation_corrupt", "operation index has conflicting winners");
      }
    }
  }
}

export function controlIdempotencyKeySha256(namespace: string, key: string): string {
  return idempotencyKeySha256(namespace, key);
}
