import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../system/strict-json.js";
import { BackgroundError } from "./background-errors.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import {
  backgroundHandoffRecordSchema,
  backgroundLaunchRecordSchema,
  backgroundTerminalReceiptSchema,
  graphWorkerCancelControlSchema,
  graphWorkerHeartbeatSchema,
  type BackgroundHandoffRecordV1,
  type BackgroundLaunchRecordV1,
  type BackgroundTerminalReceiptV1,
  type GraphWorkerCancelControlV1,
  type GraphWorkerHeartbeatV1,
} from "./background-schema.js";

const MAX_RECORD_BYTES = 64 * 1024;
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
  readonly heartbeat: string;
  readonly launch: string;
  readonly logs: string;
  readonly operation: string;
  readonly receipts: string;
}

export class BackgroundOperationStore {
  private constructor(readonly root: string, readonly paths: BackgroundOperationPathsV1) {}

  static async create(input: { readonly operationId: string; readonly repositoryId: string; readonly root: string }): Promise<BackgroundOperationStore> {
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
    return new BackgroundOperationStore(root, Object.freeze({
      controls,
      handoff: join(operation, "handoff.json"),
      heartbeat: join(operation, "heartbeat.json"),
      launch: join(operation, "launch.json"),
      logs,
      operation,
      receipts,
    }));
  }

  static async openExisting(input: { readonly operationId: string; readonly repositoryId: string; readonly root: string }): Promise<BackgroundOperationStore> {
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
    return new BackgroundOperationStore(root, Object.freeze({
      controls,
      handoff: join(operation, "handoff.json"),
      heartbeat: join(operation, "heartbeat.json"),
      launch: join(operation, "launch.json"),
      logs,
      operation,
      receipts,
    }));
  }

  async createLaunch(record: BackgroundLaunchRecordV1): Promise<void> {
    await exclusiveRecord(this.paths.launch, backgroundLaunchRecordSchema.parse(record));
  }

  readLaunch(): Promise<BackgroundLaunchRecordV1 | null> {
    return readRecord(this.paths.launch, backgroundLaunchRecordSchema);
  }

  async createHandoff(record: BackgroundHandoffRecordV1): Promise<void> {
    await exclusiveRecord(this.paths.handoff, backgroundHandoffRecordSchema.parse(record));
  }

  readHandoff(): Promise<BackgroundHandoffRecordV1 | null> {
    return readRecord(this.paths.handoff, backgroundHandoffRecordSchema);
  }

  async compareAndSwapHandoff(input: {
    readonly expectedOwner: BackgroundHandoffRecordV1["owner"];
    readonly expectedState: BackgroundHandoffRecordV1["state"];
    readonly next: BackgroundHandoffRecordV1;
    readonly nonce: string;
  }): Promise<void> {
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

  async readCancel(requestId: string): Promise<GraphWorkerCancelControlV1 | null> {
    return readRecord(join(this.paths.controls, `${requestId}.json`), graphWorkerCancelControlSchema);
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
