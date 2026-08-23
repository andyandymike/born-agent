import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { ControlStatePaths } from "../../control-plane/control-state-paths.js";
import { withControlFileLock } from "../../control-plane/control-file-lock.js";
import type { ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import type { SessionLedgerHeadV1 } from "../../control-plane/application-protocol.js";
import type { SessionLedgerHeadSigner } from "../../control-plane/session-ledger-head.js";
import { NodeRenameDurabilityPort, type RenameDurabilityPort } from "../../sessions/rename-durability.js";
import { assertCanonicalSessionId } from "../../sessions/session-path-policy.js";
import { parseStrictJson } from "../../system/strict-json.js";
import {
  createWorkingSnapshotPointerV1,
  workingSnapshotPointerV1Schema,
  workingStateSnapshotV1Schema,
  type WorkingSnapshotPointerV1,
  type WorkingSnapshotRefV1,
  type WorkingStateSnapshotV1,
} from "./working-state-schema.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_POINTER_BYTES = 32 * 1024;

export type WorkingStateRebuildReasonV1 =
  | "corrupt"
  | "future_head"
  | "missing";

export interface WorkingStateReadResultV1 {
  readonly pointer: WorkingSnapshotPointerV1 | null;
  readonly rebuildReason: WorkingStateRebuildReasonV1 | null;
  readonly snapshot: WorkingStateSnapshotV1 | null;
}

export class WorkingStateStoreError extends Error {
  override readonly name = "WorkingStateStoreError";

  constructor(
    readonly code:
      | "working_state_busy"
      | "working_state_corrupt"
      | "working_state_publish_failed"
      | "working_state_stale",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface WorkingStatePaths {
  readonly current: string;
  readonly objects: string;
  readonly quarantine: string;
  readonly root: string;
  readonly sessionKey: string;
}

function pathKey(value: string): string {
  const normalized = resolve(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new WorkingStateStoreError(
      "working_state_corrupt",
      "working state path is not a real directory",
    );
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createPaths(
  stateRoot: string,
  sessionId: string,
): Promise<WorkingStatePaths> {
  assertCanonicalSessionId(sessionId);
  if (!isAbsolute(stateRoot)) {
    throw new WorkingStateStoreError(
      "working_state_corrupt",
      "working state root must be absolute",
    );
  }
  const canonicalStateRoot = await realpath(resolve(stateRoot));
  const sessionKey = sha256Canonical({
    domain: "bornagent.working-state-session.v1",
    sessionId,
  });
  const workingRoot = join(canonicalStateRoot, "memory", "v1", "working");
  const root = join(workingRoot, "sessions", sessionKey);
  const paths = Object.freeze({
    current: join(root, "current.json"),
    objects: join(root, "objects"),
    quarantine: join(root, "quarantine"),
    root,
    sessionKey,
  });
  for (const directory of [workingRoot, join(workingRoot, "sessions"), root, paths.objects, paths.quarantine]) {
    if (!contained(canonicalStateRoot, directory)) {
      throw new WorkingStateStoreError(
        "working_state_corrupt",
        "working state path escaped its root",
      );
    }
    await ensureDirectory(directory);
    if (!contained(await realpath(canonicalStateRoot), await realpath(directory))) {
      throw new WorkingStateStoreError(
        "working_state_corrupt",
        "working state path escaped through a link or junction",
      );
    }
  }
  return paths;
}

async function readBoundedCanonical(path: string, maximum: number): Promise<unknown> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximum
  ) {
    throw new Error("working state file identity or size is invalid");
  }
  const bytes = await readFile(path);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseStrictJson(source);
  if (`${canonicalJson(value)}\n` !== source) {
    throw new Error("working state file is not canonical JSON");
  }
  return value;
}

function snapshotBytes(snapshot: WorkingStateSnapshotV1): Buffer {
  const bytes = Buffer.from(`${canonicalJson(snapshot)}\n`, "utf8");
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new WorkingStateStoreError(
      "working_state_publish_failed",
      "working snapshot exceeds its hard byte bound",
    );
  }
  return bytes;
}

function sameHead(left: SessionLedgerHeadV1, right: SessionLedgerHeadV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class WorkingStateStore {
  private constructor(
    private readonly controlPaths: ControlStatePaths,
    private readonly paths: WorkingStatePaths,
    private readonly renameDurability: RenameDurabilityPort,
    readonly sessionId: string,
    private readonly faults: Readonly<{
      readonly afterSnapshotSync?: () => Promise<void> | void;
      readonly beforePointerInstall?: () => Promise<void> | void;
    }>,
  ) {}

  static async create(input: Readonly<{
    readonly faults?: Readonly<{
      readonly afterSnapshotSync?: () => Promise<void> | void;
      readonly beforePointerInstall?: () => Promise<void> | void;
    }>;
    readonly renameDurability?: RenameDurabilityPort;
    readonly sessionId: string;
    readonly stateRoot: string;
  }>): Promise<WorkingStateStore> {
    const controlPaths = await ControlStatePaths.create(input.stateRoot);
    return new WorkingStateStore(
      controlPaths,
      await createPaths(input.stateRoot, input.sessionId),
      input.renameDurability ?? new NodeRenameDurabilityPort(),
      input.sessionId,
      input.faults ?? {},
    );
  }

  async readCurrent(input?: Readonly<{
    readonly evidence: ExactSessionEvidenceV1;
    readonly signer: SessionLedgerHeadSigner;
  }>): Promise<WorkingStateReadResultV1> {
    let pointer: WorkingSnapshotPointerV1;
    try {
      pointer = workingSnapshotPointerV1Schema.parse(
        await readBoundedCanonical(this.paths.current, MAX_POINTER_BYTES),
      );
      if (pointer.sessionId !== this.sessionId) throw new Error("working pointer belongs to another session");
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return Object.freeze({ pointer: null, rebuildReason: "missing", snapshot: null });
      }
      return Object.freeze({ pointer: null, rebuildReason: "corrupt", snapshot: null });
    }
    try {
      const snapshot = workingStateSnapshotV1Schema.parse(
        await readBoundedCanonical(
          this.objectPath(pointer.current.snapshotSha256),
          MAX_SNAPSHOT_BYTES,
        ),
      );
      const bytes = snapshotBytes(snapshot);
      if (
        snapshot.sessionId !== this.sessionId ||
        snapshot.snapshotSha256 !== pointer.current.snapshotSha256 ||
        bytes.byteLength !== pointer.current.bytes ||
        snapshot.projectionVersion !== pointer.current.projectionVersion ||
        !sameHead(snapshot.sourceHead, pointer.current.sourceHead)
      ) {
        throw new Error("working snapshot does not match its current pointer");
      }
      if (input !== undefined) {
        if (
          snapshot.sourceHead.sequence > input.evidence.events.length ||
          !input.evidence.verifyHead(snapshot.sourceHead, input.signer)
        ) {
          return Object.freeze({ pointer, rebuildReason: "future_head", snapshot: null });
        }
      }
      return Object.freeze({ pointer, rebuildReason: null, snapshot });
    } catch {
      return Object.freeze({ pointer, rebuildReason: "corrupt", snapshot: null });
    }
  }

  async publish(input: Readonly<{
    readonly readSourceHead: () => Promise<SessionLedgerHeadV1>;
    readonly snapshot: WorkingStateSnapshotV1;
  }>): Promise<WorkingSnapshotPointerV1> {
    const snapshot = workingStateSnapshotV1Schema.parse(input.snapshot);
    if (snapshot.sessionId !== this.sessionId) {
      throw new WorkingStateStoreError(
        "working_state_stale",
        "working snapshot belongs to another session",
      );
    }
    return withControlFileLock(
      {
        keySha256: sha256Canonical({
          domain: "bornagent.working-state-writer-lock.v1",
          sessionId: this.sessionId,
        }),
        paths: this.controlPaths,
      },
      async () => {
        const observedHead = await input.readSourceHead();
        if (!sameHead(observedHead, snapshot.sourceHead)) {
          throw new WorkingStateStoreError(
            "working_state_busy",
            "session head advanced while the working snapshot was built",
          );
        }
        await this.cleanupPointerTemps();
        let current: WorkingSnapshotPointerV1 | null = null;
        const observed = await this.readCurrent();
        if (observed.rebuildReason === "corrupt") {
          await this.quarantineCurrent();
        } else {
          current = observed.pointer;
        }
        if (current !== null) {
          const currentSequence = current.current.sourceHead.sequence;
          if (currentSequence > snapshot.sourceHead.sequence) {
            // The exact source head was re-read above and equals the candidate.
            // Therefore a sidecar ahead of it belongs to replaced/truncated
            // source history and is derived residue, not newer authority.
            await this.quarantineCurrent();
            current = null;
          }
          if (
            current !== null &&
            currentSequence === snapshot.sourceHead.sequence
          ) {
            if (
              current.current.snapshotSha256 !== snapshot.snapshotSha256 ||
              !sameHead(current.current.sourceHead, snapshot.sourceHead)
            ) {
              throw new WorkingStateStoreError(
                "working_state_stale",
                "same working prefix produced different snapshot bytes",
              );
            }
            await this.cleanupObjects(current);
            return current;
          }
        }

        const bytes = snapshotBytes(snapshot);
        await this.writeSnapshotNoReplace(snapshot, bytes);
        await this.faults.afterSnapshotSync?.();
        const reference: WorkingSnapshotRefV1 = Object.freeze({
          bytes: bytes.byteLength,
          projectionVersion: snapshot.projectionVersion,
          snapshotSha256: snapshot.snapshotSha256,
          sourceHead: snapshot.sourceHead,
        });
        const pointer = createWorkingSnapshotPointerV1({
          current: reference,
          previous: current?.current ?? null,
          schemaVersion: 1,
          sessionId: this.sessionId,
        });
        const pointerBytes = Buffer.from(`${canonicalJson(pointer)}\n`, "utf8");
        const temporary = join(this.paths.root, `.current.${process.pid}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(pointerBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.faults.beforePointerInstall?.();
          await this.renameDurability.install(temporary, this.paths.current, pointerBytes);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        const readback = await this.readCurrent();
        if (
          readback.snapshot?.snapshotSha256 !== snapshot.snapshotSha256 ||
          readback.pointer?.pointerSha256 !== pointer.pointerSha256
        ) {
          throw new WorkingStateStoreError(
            "working_state_publish_failed",
            "working snapshot pointer failed strict readback",
          );
        }
        await this.cleanupObjects(pointer);
        return pointer;
      },
    ).catch((error: unknown) => {
      if (error instanceof WorkingStateStoreError) throw error;
      if (isCode(error, "control_operation_busy")) {
        throw new WorkingStateStoreError(
          "working_state_busy",
          "working snapshot writer lock or source head is busy",
          { cause: error },
        );
      }
      if (isCode(error, "control_operation_corrupt")) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working snapshot writer lock is corrupt",
          { cause: error },
        );
      }
      throw new WorkingStateStoreError(
        "working_state_publish_failed",
        "working snapshot publication failed",
        { cause: error },
      );
    });
  }

  private objectPath(snapshotSha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(snapshotSha256)) {
      throw new WorkingStateStoreError(
        "working_state_corrupt",
        "working snapshot object name is invalid",
      );
    }
    const path = join(this.paths.objects, `${snapshotSha256}.json`);
    if (!contained(this.paths.objects, path)) {
      throw new WorkingStateStoreError(
        "working_state_corrupt",
        "working snapshot object escaped its root",
      );
    }
    return path;
  }

  private async writeSnapshotNoReplace(
    snapshot: WorkingStateSnapshotV1,
    bytes: Buffer,
  ): Promise<void> {
    const path = this.objectPath(snapshot.snapshotSha256);
    let handle;
    let created = false;
    try {
      handle = await open(path, "wx", 0o600);
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = await readFile(path);
      if (!existing.equals(bytes)) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working snapshot hash path contains different bytes",
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (created) await syncDirectory(this.paths.objects);
    const readback = await readFile(path);
    if (!readback.equals(bytes)) {
      throw new WorkingStateStoreError(
        "working_state_publish_failed",
        "working snapshot failed byte-for-byte readback",
      );
    }
  }

  private async cleanupObjects(
    pointer: WorkingSnapshotPointerV1,
  ): Promise<void> {
    const entries = await readdir(this.paths.objects, { withFileTypes: true });
    if (entries.length > 4_096) {
      throw new WorkingStateStoreError(
        "working_state_corrupt",
        "working snapshot object inventory exceeds its hard bound",
      );
    }
    const retained = new Set([
      pointer.current.snapshotSha256,
      ...(pointer.previous === null ? [] : [pointer.previous.snapshotSha256]),
    ]);
    let removed = false;
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working snapshot object inventory contains an unknown entry",
        );
      }
      const snapshotSha256 = match[1]!;
      if (retained.has(snapshotSha256)) continue;
      const path = this.objectPath(snapshotSha256);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working snapshot cleanup target is not a regular file",
        );
      }
      await rm(path, { force: true });
      removed = true;
    }
    if (removed) await syncDirectory(this.paths.objects);
  }

  private async cleanupPointerTemps(): Promise<void> {
    const entries = await readdir(this.paths.root, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!/^\.current\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(entry.name)) {
        continue;
      }
      const path = join(this.paths.root, entry.name);
      if (!contained(this.paths.root, path)) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working pointer temp escaped its root",
        );
      }
      const metadata = await lstat(path);
      if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink()) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "working pointer temp is not a regular file",
        );
      }
      await rm(path, { force: true });
      removed = true;
    }
    if (removed) await syncDirectory(this.paths.root);
  }

  private async quarantineCurrent(): Promise<void> {
    try {
      const target = join(this.paths.quarantine, `current-${randomUUID()}.json`);
      await rename(this.paths.current, target);
    } catch (error) {
      if (!isCode(error, "ENOENT")) {
        throw new WorkingStateStoreError(
          "working_state_corrupt",
          "corrupt working pointer could not be quarantined",
          { cause: error },
        );
      }
    }
  }
}
