import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../system/strict-json.js";
import { BackgroundError } from "./background-errors.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import {
  backgroundHandoffRecordSchema,
  backgroundHandoffRevisionV2Schema,
  backgroundLaunchRecordSchema,
  backgroundTerminalReceiptSchema,
  createBackgroundHandoffRevisionV2,
  graphWorkerCancelControlSchema,
  graphWorkerHeartbeatSchema,
  type BackgroundHandoffRecordV1,
  type BackgroundHandoffRevisionV2,
  type BackgroundLaunchRecordV1,
  type BackgroundTerminalReceiptV1,
  type GraphWorkerCancelControlV1,
  type GraphWorkerHeartbeatV1,
} from "./background-schema.js";

const MAX_RECORD_BYTES = 64 * 1024;
const HANDOFF_V2_REVISION_NAME = /^revision-(\d{12})\.json$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const workerFailureDiagnosticSchema = z.object({
  code: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u),
  observedAt: z.string().datetime({ offset: true }),
  phase: z.enum(["bootstrap", "worker_owned"]),
  schemaVersion: z.literal(1),
  workerId: z.string().uuid(),
}).strict();

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new BackgroundError("worker_reconciliation_required", "worker state path contains a non-directory or reparse boundary");
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (creationError) {
        if (!isCode(creationError, "EEXIST")) {
          throw new BackgroundError("worker_reconciliation_required", "worker state directory could not be created", { cause: creationError });
        }
      }
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new BackgroundError("worker_reconciliation_required", "worker state directory was replaced while being created");
      }
    }
  }
}

async function existingDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new BackgroundError("worker_reconciliation_required", "worker state path is not a plain existing directory");
    }
  } catch (error) {
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("worker_reconciliation_required", "worker state directory is unavailable", { cause: error });
  }
}

async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > MAX_RECORD_BYTES) {
      throw new BackgroundError("worker_reconciliation_required", "worker operation record is unsafe");
    }
    return schema.parse(parseStrictJson(await readFile(path, "utf8")));
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("worker_reconciliation_required", "worker operation record is invalid", { cause: error });
  }
}

async function readPublishedHandoffRevision(
  path: string,
  candidates: string,
): Promise<BackgroundHandoffRevisionV2> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_RECORD_BYTES) {
      throw new BackgroundError("worker_reconciliation_required", "published handoff revision is unsafe");
    }
    const parsed = backgroundHandoffRevisionV2Schema.parse(parseStrictJson(await readFile(path, "utf8")));
    if (metadata.nlink !== 2) {
      throw new BackgroundError("worker_reconciliation_required", "published handoff revision has an ambiguous hard-link identity");
    }
    const candidate = await lstat(join(candidates, `${parsed.recordSha256}.json`));
    if (
      !candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 2 ||
      candidate.dev !== metadata.dev || candidate.ino !== metadata.ino || candidate.size !== metadata.size
    ) {
      throw new BackgroundError("worker_reconciliation_required", "published handoff revision is not linked to its exact durable candidate");
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("worker_reconciliation_required", "published handoff revision is invalid", { cause: error });
  }
}

async function exclusiveRecord(path: string, value: unknown): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new BackgroundError(isCode(error, "EEXIST") ? "worker_handoff_conflict" : "worker_reconciliation_required", "worker operation record could not be created", { cause: error });
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: unknown) => {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  });
}

async function readHandoffCandidate(path: string): Promise<BackgroundHandoffRevisionV2 | null> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || ![1, 2].includes(metadata.nlink) ||
      metadata.size < 1 || metadata.size > MAX_RECORD_BYTES
    ) {
      throw new BackgroundError("worker_reconciliation_required", "handoff candidate is unsafe");
    }
    return Object.freeze(backgroundHandoffRevisionV2Schema.parse(parseStrictJson(await readFile(path, "utf8"))));
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("worker_reconciliation_required", "handoff candidate is invalid", { cause: error });
  }
}

function revisionName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 999_999_999_999) {
    throw new BackgroundError("worker_protocol_mismatch", "handoff revision is outside its durable filename range");
  }
  return `revision-${String(revision).padStart(12, "0")}.json`;
}

async function replaceRecord(directory: string, name: string, nonce: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}.${nonce}.tmp`);
  const target = join(directory, name);
  await exclusiveRecord(temporary, value);
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new BackgroundError("worker_reconciliation_required", "worker operation record could not be atomically replaced", { cause: error });
  }
}

export interface BackgroundOperationPathsV1 {
  readonly controls: string;
  readonly handoff: string;
  readonly handoffV2: string;
  readonly handoffV2Candidates: string;
  readonly heartbeat: string;
  readonly launch: string;
  readonly logs: string;
  readonly operation: string;
  readonly receipts: string;
}

export type BackgroundHandoffV2FaultPointV1 = "candidate_durable" | "revision_published";

export interface BackgroundHandoffAuthorityV1 {
  readonly handoff: BackgroundHandoffRecordV1;
  readonly protocol: "v1" | "v2";
  readonly revision: number | null;
  readonly revisionSha256: string;
  readonly transitionId: string | null;
}

export interface BackgroundHandoffInspectionV1 {
  readonly authority: BackgroundHandoffAuthorityV1 | null;
  readonly legacyLockPath: string;
  readonly legacyLockPresent: boolean;
}

export interface BackgroundOperationStoreOptionsV1 {
  readonly onHandoffV2FaultPoint?: (point: BackgroundHandoffV2FaultPointV1) => Promise<void> | void;
}

export class BackgroundOperationStore {
  private constructor(
    readonly root: string,
    readonly paths: BackgroundOperationPathsV1,
    private readonly options: BackgroundOperationStoreOptionsV1,
  ) {}

  static async create(input: {
    readonly operationId: string;
    readonly options?: BackgroundOperationStoreOptionsV1;
    readonly repositoryId: string;
    readonly root: string;
  }): Promise<BackgroundOperationStore> {
    if (!/^[a-f0-9]{64}$/u.test(input.repositoryId) || !/^[0-9a-f-]{36}$/u.test(input.operationId)) {
      throw new BackgroundError("worker_protocol_mismatch", "worker operation identity is invalid");
    }
    const root = resolve(input.root);
    await safeDirectory(root);
    const repository = join(root, input.repositoryId);
    await safeDirectory(repository);
    const operation = join(repository, input.operationId);
    await safeDirectory(operation);
    const controls = join(operation, "controls");
    const receipts = join(operation, "receipts");
    const logs = join(operation, "logs");
    await safeDirectory(controls);
    await safeDirectory(receipts);
    await safeDirectory(logs);
    const handoffV2 = join(operation, "handoff-v2");
    return new BackgroundOperationStore(root, Object.freeze({
      controls,
      handoff: join(operation, "handoff.json"),
      handoffV2,
      handoffV2Candidates: join(handoffV2, "candidates"),
      heartbeat: join(operation, "heartbeat.json"),
      launch: join(operation, "launch.json"),
      logs,
      operation,
      receipts,
    }), input.options ?? {});
  }

  static async openExisting(input: {
    readonly operationId: string;
    readonly options?: BackgroundOperationStoreOptionsV1;
    readonly repositoryId: string;
    readonly root: string;
  }): Promise<BackgroundOperationStore> {
    if (!/^[a-f0-9]{64}$/u.test(input.repositoryId) || !/^[0-9a-f-]{36}$/u.test(input.operationId)) {
      throw new BackgroundError("worker_protocol_mismatch", "worker operation identity is invalid");
    }
    const root = resolve(input.root);
    const repository = join(root, input.repositoryId);
    const operation = join(repository, input.operationId);
    const controls = join(operation, "controls");
    const receipts = join(operation, "receipts");
    const logs = join(operation, "logs");
    for (const directory of [root, repository, operation, controls, receipts, logs]) await existingDirectory(directory);
    const handoffV2 = join(operation, "handoff-v2");
    return new BackgroundOperationStore(root, Object.freeze({
      controls,
      handoff: join(operation, "handoff.json"),
      handoffV2,
      handoffV2Candidates: join(handoffV2, "candidates"),
      heartbeat: join(operation, "heartbeat.json"),
      launch: join(operation, "launch.json"),
      logs,
      operation,
      receipts,
    }), input.options ?? {});
  }

  async createLaunch(record: BackgroundLaunchRecordV1): Promise<void> {
    await exclusiveRecord(this.paths.launch, backgroundLaunchRecordSchema.parse(record));
  }

  readLaunch(): Promise<BackgroundLaunchRecordV1 | null> {
    return readRecord(this.paths.launch, backgroundLaunchRecordSchema);
  }

  async createHandoff(record: BackgroundHandoffRecordV1): Promise<void> {
    if (await pathExists(this.paths.handoffV2)) {
      throw new BackgroundError("worker_reconciliation_required", "V1 handoff writer is forbidden after V2 initialization");
    }
    await exclusiveRecord(this.paths.handoff, backgroundHandoffRecordSchema.parse(record));
  }

  async createHandoffV2(input: Readonly<{
    handoff: BackgroundHandoffRecordV1;
    launch: BackgroundLaunchRecordV1;
    transitionId: string;
  }>): Promise<BackgroundHandoffAuthorityV1> {
    if (!SHA256.test(input.transitionId)) {
      throw new BackgroundError("worker_protocol_mismatch", "handoff transition identity is invalid");
    }
    if (await pathExists(this.paths.handoff)) {
      throw new BackgroundError("worker_reconciliation_required", "V2 handoff cannot coexist with legacy V1 authority");
    }
    await safeDirectory(this.paths.handoffV2);
    await safeDirectory(this.paths.handoffV2Candidates);
    const existing = await this.#readHandoffV2Authority();
    const launch = backgroundLaunchRecordSchema.parse(input.launch);
    const handoff = backgroundHandoffRecordSchema.parse(input.handoff);
    const revision = createBackgroundHandoffRevisionV2({
      handoff,
      launch,
      launchSha256: sha256Canonical(launch),
      previousRevisionSha256: null,
      revision: 0,
      transitionId: input.transitionId,
    });
    if (existing !== null) {
      if (
        existing.revision === 0 && existing.transitionId === input.transitionId &&
        existing.revisionSha256 === revision.recordSha256
      ) return existing;
      throw new BackgroundError("worker_handoff_conflict", "handoff V2 genesis already has different durable authority");
    }
    return this.#publishHandoffV2Revision(revision);
  }

  async inspectHandoff(): Promise<BackgroundHandoffInspectionV1> {
    const legacyLockPath = join(this.paths.operation, ".handoff.lock");
    return Object.freeze({
      authority: await this.readHandoffAuthority(),
      legacyLockPath,
      legacyLockPresent: await pathExists(legacyLockPath),
    });
  }

  async readHandoff(): Promise<BackgroundHandoffRecordV1 | null> {
    return (await this.readHandoffAuthority())?.handoff ?? null;
  }

  async readHandoffAuthority(): Promise<BackgroundHandoffAuthorityV1 | null> {
    const legacy = await readRecord(this.paths.handoff, backgroundHandoffRecordSchema);
    const v2 = await this.#readHandoffV2Authority();
    if (legacy !== null && v2 !== null) {
      throw new BackgroundError("worker_reconciliation_required", "V1 and V2 handoff authorities coexist");
    }
    if (v2 !== null) return v2;
    if (legacy === null) return null;
    return Object.freeze({
      handoff: Object.freeze(legacy),
      protocol: "v1",
      revision: null,
      revisionSha256: sha256Canonical(legacy),
      transitionId: null,
    });
  }

  async compareAndSwapHandoff(input: {
    readonly expectedOwner: BackgroundHandoffRecordV1["owner"];
    readonly expectedState: BackgroundHandoffRecordV1["state"];
    readonly next: BackgroundHandoffRecordV1;
    readonly nonce: string;
    readonly transitionId?: string;
  }): Promise<void> {
    const authority = await this.readHandoffAuthority();
    if (authority?.protocol === "v2") {
      if (input.transitionId === undefined || !SHA256.test(input.transitionId)) {
        throw new BackgroundError("worker_protocol_mismatch", "V2 handoff transition requires an exact durable transition identity");
      }
      const next = backgroundHandoffRecordSchema.parse(input.next);
      if (
        authority.transitionId === input.transitionId &&
        sha256Canonical(authority.handoff) === sha256Canonical(next)
      ) return;
      const current = authority.handoff;
      if (
        current.owner !== input.expectedOwner || current.state !== input.expectedState ||
        current.operationId !== next.operationId || current.workerId !== next.workerId ||
        current.workerNonceSha256 !== next.workerNonceSha256 || current.graphSha256 !== next.graphSha256 ||
        current.parentNonceSha256 !== next.parentNonceSha256
      ) {
        throw new BackgroundError("worker_handoff_conflict", "worker handoff V2 compare-and-swap lost ownership");
      }
      const genesis = await this.#readHandoffV2Genesis();
      const revision = createBackgroundHandoffRevisionV2({
        handoff: next,
        launch: null,
        launchSha256: genesis.launchSha256,
        previousRevisionSha256: authority.revisionSha256,
        revision: (authority.revision ?? -1) + 1,
        transitionId: input.transitionId,
      });
      await this.#publishHandoffV2Revision(revision);
      return;
    }
    const lock = join(this.paths.operation, ".handoff.lock");
    await exclusiveRecord(lock, { nonce: input.nonce });
    try {
      const current = await this.readHandoff();
      if (current === null || current.owner !== input.expectedOwner || current.state !== input.expectedState ||
          current.operationId !== input.next.operationId || current.workerId !== input.next.workerId ||
          current.workerNonceSha256 !== input.next.workerNonceSha256 || current.graphSha256 !== input.next.graphSha256) {
        throw new BackgroundError("worker_handoff_conflict", "worker handoff compare-and-swap lost ownership");
      }
      await replaceRecord(this.paths.operation, "handoff.json", input.nonce, backgroundHandoffRecordSchema.parse(input.next));
    } finally {
      await unlink(lock).catch(() => undefined);
    }
  }

  async #publishHandoffV2Revision(revision: BackgroundHandoffRevisionV2): Promise<BackgroundHandoffAuthorityV1> {
    const candidatePath = join(this.paths.handoffV2Candidates, `${revision.recordSha256}.json`);
    try {
      await exclusiveRecord(candidatePath, revision);
    } catch (error) {
      if (!(error instanceof BackgroundError) || error.code !== "worker_handoff_conflict") throw error;
      const existingCandidate = await readHandoffCandidate(candidatePath);
      if (existingCandidate?.recordSha256 !== revision.recordSha256) {
        throw new BackgroundError("worker_reconciliation_required", "handoff candidate path has different durable content");
      }
    }
    await this.options.onHandoffV2FaultPoint?.("candidate_durable");
    const target = join(this.paths.handoffV2, revisionName(revision.revision));
    try {
      await link(candidatePath, target);
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        throw new BackgroundError("worker_reconciliation_required", "handoff revision could not be atomically published", { cause: error });
      }
      const winner = await readPublishedHandoffRevision(target, this.paths.handoffV2Candidates);
      if (winner.transitionId !== revision.transitionId || winner.recordSha256 !== revision.recordSha256) {
        throw new BackgroundError("worker_handoff_conflict", "another handoff transition won the exact revision");
      }
    }
    await this.options.onHandoffV2FaultPoint?.("revision_published");
    const authority = await this.#readHandoffV2Authority();
    if (
      authority === null || authority.revision !== revision.revision ||
      authority.revisionSha256 !== revision.recordSha256 || authority.transitionId !== revision.transitionId
    ) {
      throw new BackgroundError("worker_reconciliation_required", "published handoff revision did not become the exact chain head");
    }
    return authority;
  }

  async #readHandoffV2Genesis(): Promise<BackgroundHandoffRevisionV2> {
    const genesis = await readPublishedHandoffRevision(
      join(this.paths.handoffV2, revisionName(0)),
      this.paths.handoffV2Candidates,
    );
    if (genesis.revision !== 0 || genesis.launch === null) {
      throw new BackgroundError("worker_reconciliation_required", "handoff V2 genesis is incomplete");
    }
    return genesis;
  }

  async #readHandoffV2Authority(): Promise<BackgroundHandoffAuthorityV1 | null> {
    let entries;
    try {
      entries = await readdir(this.paths.handoffV2, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new BackgroundError("worker_reconciliation_required", "handoff V2 directory is unavailable", { cause: error });
    }
    const revisions: { readonly name: string; readonly revision: number }[] = [];
    for (const entry of entries) {
      if (entry.name === "candidates" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const match = HANDOFF_V2_REVISION_NAME.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw new BackgroundError("worker_reconciliation_required", "handoff V2 directory contains an unknown authority entry");
      }
      revisions.push({ name: entry.name, revision: Number(match[1]) });
    }
    revisions.sort((left, right) => left.revision - right.revision);
    if (revisions.length === 0) return null;
    const transitionIds = new Set<string>();
    let previous: BackgroundHandoffRevisionV2 | null = null;
    let launchSha256: string | null = null;
    for (const [index, item] of revisions.entries()) {
      if (item.revision !== index || item.name !== revisionName(index)) {
        throw new BackgroundError("worker_reconciliation_required", "handoff V2 revision chain has a gap or duplicate identity");
      }
      const current = await readPublishedHandoffRevision(
        join(this.paths.handoffV2, item.name),
        this.paths.handoffV2Candidates,
      );
      if (
        current.revision !== index ||
        current.previousRevisionSha256 !== previous?.recordSha256 && !(index === 0 && current.previousRevisionSha256 === null)
      ) {
        throw new BackgroundError("worker_reconciliation_required", "handoff V2 revision chain is not hash linked");
      }
      if (transitionIds.has(current.transitionId)) {
        throw new BackgroundError("worker_reconciliation_required", "handoff V2 transition identity is duplicated in the chain");
      }
      transitionIds.add(current.transitionId);
      if (index === 0) launchSha256 = current.launchSha256;
      if (
        current.launchSha256 !== launchSha256 ||
        previous !== null && (
          current.handoff.operationId !== previous.handoff.operationId ||
          current.handoff.workerId !== previous.handoff.workerId ||
          current.handoff.workerNonceSha256 !== previous.handoff.workerNonceSha256 ||
          current.handoff.graphSha256 !== previous.handoff.graphSha256 ||
          current.handoff.parentNonceSha256 !== previous.handoff.parentNonceSha256
        )
      ) {
        throw new BackgroundError("worker_reconciliation_required", "handoff V2 chain identity drifted");
      }
      previous = current;
    }
    if (previous === null) return null;
    return Object.freeze({
      handoff: Object.freeze(backgroundHandoffRecordSchema.parse({ ...previous.handoff, schemaVersion: 1 })),
      protocol: "v2",
      revision: previous.revision,
      revisionSha256: previous.recordSha256,
      transitionId: previous.transitionId,
    });
  }

  async writeHeartbeat(record: GraphWorkerHeartbeatV1, nonce: string): Promise<void> {
    const validated = graphWorkerHeartbeatSchema.parse(record);
    const current = await readRecord(this.paths.heartbeat, graphWorkerHeartbeatSchema);
    if (current !== null && (current.workerId !== validated.workerId || current.sequence >= validated.sequence)) {
      throw new BackgroundError("worker_handoff_conflict", "worker heartbeat sequence or owner is stale");
    }
    await replaceRecord(this.paths.operation, "heartbeat.json", nonce, validated);
  }

  readHeartbeat(): Promise<GraphWorkerHeartbeatV1 | null> {
    return readRecord(this.paths.heartbeat, graphWorkerHeartbeatSchema);
  }

  async createCancel(control: GraphWorkerCancelControlV1): Promise<void> {
    await exclusiveRecord(join(this.paths.controls, `${control.requestId}.json`), graphWorkerCancelControlSchema.parse(control));
  }

  async createCancelIdempotent(control: GraphWorkerCancelControlV1): Promise<GraphWorkerCancelControlV1> {
    const validated = graphWorkerCancelControlSchema.parse(control);
    const existing = await this.readCancelEvidence(validated.requestId);
    if (existing !== null) {
      if (sha256Canonical(existing) !== sha256Canonical(validated)) {
        throw new BackgroundError("worker_handoff_conflict", "background cancel request identity already has different durable content");
      }
      return Object.freeze(existing);
    }
    try {
      await this.createCancel(validated);
      return Object.freeze(validated);
    } catch (error) {
      if (!(error instanceof BackgroundError) || error.code !== "worker_handoff_conflict") throw error;
      const raced = await this.readCancelEvidence(validated.requestId);
      if (raced === null || sha256Canonical(raced) !== sha256Canonical(validated)) throw error;
      return Object.freeze(raced);
    }
  }

  async readCancel(requestId: string): Promise<GraphWorkerCancelControlV1 | null> {
    return readRecord(join(this.paths.controls, `${requestId}.json`), graphWorkerCancelControlSchema);
  }

  async readCancelEvidence(requestId: string): Promise<GraphWorkerCancelControlV1 | null> {
    if (!/^[0-9a-f-]{36}$/u.test(requestId)) {
      throw new BackgroundError("worker_protocol_mismatch", "worker cancel request identity is invalid");
    }
    const active = await this.readCancel(requestId);
    const receiptNames = (await readdir(this.paths.receipts))
      .filter((name) => name.startsWith(`control-${requestId}-`) && name.endsWith(".json"))
      .sort();
    if (receiptNames.length > 1 || (active !== null && receiptNames.length > 0)) {
      throw new BackgroundError("worker_reconciliation_required", "background cancel has ambiguous durable evidence");
    }
    if (active !== null) return Object.freeze(active);
    if (receiptNames.length === 0) return null;
    const consumed = await readRecord(join(this.paths.receipts, receiptNames[0]!), graphWorkerCancelControlSchema);
    if (consumed === null || consumed.requestId !== requestId) {
      throw new BackgroundError("worker_reconciliation_required", "consumed background cancel evidence is incomplete");
    }
    return Object.freeze(consumed);
  }

  async listCancelControls(): Promise<readonly GraphWorkerCancelControlV1[]> {
    const names = (await readdir(this.paths.controls)).filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)).sort();
    const controls: GraphWorkerCancelControlV1[] = [];
    for (const name of names) {
      const control = await readRecord(join(this.paths.controls, name), graphWorkerCancelControlSchema);
      if (control !== null) controls.push(control);
    }
    return Object.freeze(controls);
  }

  async consumeCancel(control: GraphWorkerCancelControlV1, nonce: string): Promise<void> {
    const source = join(this.paths.controls, `${control.requestId}.json`);
    const target = join(this.paths.receipts, `control-${control.requestId}-${nonce}.json`);
    try {
      await rename(source, target);
    } catch (error) {
      throw new BackgroundError("worker_control_stale", "worker cancel control could not be consumed exactly once", { cause: error });
    }
  }

  async writeTerminalReceipt(receipt: BackgroundTerminalReceiptV1, nonce: string): Promise<{ readonly receiptRef: string; readonly receiptSha256: string }> {
    const validated = backgroundTerminalReceiptSchema.parse(receipt);
    const receiptSha256 = sha256Canonical(validated);
    const name = `terminal-${validated.workerId}.json`;
    await replaceRecord(this.paths.receipts, name, nonce, validated);
    return Object.freeze({ receiptRef: `receipts/${name}`, receiptSha256 });
  }

  readTerminalReceipt(workerId: string): Promise<BackgroundTerminalReceiptV1 | null> {
    if (!/^[0-9a-f-]{36}$/u.test(workerId)) {
      throw new BackgroundError("worker_protocol_mismatch", "worker receipt identity is invalid");
    }
    return readRecord(join(this.paths.receipts, `terminal-${workerId}.json`), backgroundTerminalReceiptSchema);
  }

  async writeFailureDiagnostic(input: z.infer<typeof workerFailureDiagnosticSchema>, nonce: string): Promise<void> {
    await replaceRecord(this.paths.logs, `failure-${input.workerId}.json`, nonce, workerFailureDiagnosticSchema.parse(input));
  }

  readFailureDiagnostic(workerId: string): Promise<Readonly<z.infer<typeof workerFailureDiagnosticSchema>> | null> {
    if (!/^[0-9a-f-]{36}$/u.test(workerId)) {
      throw new BackgroundError("worker_protocol_mismatch", "worker diagnostic identity is invalid");
    }
    return readRecord(join(this.paths.logs, `failure-${workerId}.json`), workerFailureDiagnosticSchema);
  }
}

export function resolveWorkerUserStateRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string {
  const base = input.platform === "win32" ? input.env.LOCALAPPDATA : input.env.XDG_STATE_HOME;
  if (base === undefined || base.length === 0) throw new BackgroundError("worker_reconciliation_required", "trusted user-state environment is unavailable");
  return input.platform === "win32"
    ? join(base, "BornAgent", "task-workers", "v1")
    : join(base, "bornagent", "task-workers", "v1");
}
