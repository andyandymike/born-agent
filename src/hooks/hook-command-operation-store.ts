import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { HookError } from "./hook-errors.js";
import {
  hookCommandOperationRecordSchema,
  type HookCommandOperationCaptureV1,
  type HookCommandOperationCapturedV1,
  type HookCommandOperationRecordV1,
  type HookCommandOperationRequestedV1,
  type HookCommandOperationSpawningV1,
  type HookCommandOperationStartedV1,
} from "./hook-command-operation-schema.js";

const MAX_RECORD_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function operationError(message: string, cause?: unknown): HookError {
  return new HookError(
    "hook_effect_unknown",
    message,
    1,
    cause === undefined ? undefined : { cause },
  );
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
        throw operationError("Hook operation path contains a non-directory or reparse boundary");
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (creationError) {
        if (!isCode(creationError, "EEXIST")) {
          throw operationError("Hook operation directory could not be created", creationError);
        }
      }
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw operationError("Hook operation directory raced with an unsafe entry");
      }
    }
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not portable on Windows. Each record file is still
    // synced before its same-directory rename.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRecord(path: string): Promise<HookCommandOperationRecordV1 | null> {
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_RECORD_BYTES
    ) {
      throw operationError("Hook operation record is not a bounded unique regular file");
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw operationError("Hook operation record changed while it was read");
    }
    return hookCommandOperationRecordSchema.parse(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    if (error instanceof HookError) throw error;
    throw operationError("Hook operation record failed strict validation", error);
  }
}

async function writeExclusive(path: string, value: HookCommandOperationRecordV1): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw operationError(
      isCode(error, "EEXIST")
        ? "Hook operation identity already exists"
        : "Hook operation record could not be created",
      error,
    );
  }
}

async function replaceRecord(
  directory: string,
  target: string,
  nonce: string,
  value: HookCommandOperationRecordV1,
): Promise<void> {
  const temporary = join(directory, `.${target}.${nonce}.tmp`);
  await writeExclusive(temporary, value);
  try {
    await rename(temporary, join(directory, target));
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw operationError("Hook operation record could not be atomically replaced", error);
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw operationError(`${label} is not a canonical UUID`);
}

export class HookCommandOperationStore {
  readonly directory: string;
  readonly path: string;

  private constructor(
    readonly root: string,
    readonly sessionId: string,
    readonly runId: string,
    readonly invocationId: string,
  ) {
    this.directory = join(root, sessionId, runId);
    this.path = join(this.directory, `${invocationId}.json`);
  }

  static async create(input: {
    readonly invocationId: string;
    readonly root: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<HookCommandOperationStore> {
    assertUuid(input.sessionId, "Hook operation session ID");
    assertUuid(input.runId, "Hook operation run ID");
    assertUuid(input.invocationId, "Hook operation invocation ID");
    const root = resolve(input.root);
    const store = new HookCommandOperationStore(root, input.sessionId, input.runId, input.invocationId);
    await safeDirectory(store.directory);
    return store;
  }

  static async openExisting(input: {
    readonly invocationId: string;
    readonly root: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<HookCommandOperationStore> {
    const store = await HookCommandOperationStore.create(input);
    if (await store.read() === null) throw operationError("Hook operation record is missing");
    return store;
  }

  async createRequested(record: HookCommandOperationRequestedV1): Promise<void> {
    if (
      record.sessionId !== this.sessionId ||
      record.runId !== this.runId ||
      record.invocationId !== this.invocationId
    ) {
      throw operationError("Hook requested operation identity does not match its path");
    }
    const parsed = hookCommandOperationRecordSchema.parse(record);
    await writeExclusive(this.path, parsed);
    await fsyncDirectory(this.directory);
  }

  read(): Promise<HookCommandOperationRecordV1 | null> {
    return readRecord(this.path);
  }

  async markStarted(input: {
    readonly nonce: string;
    readonly process: HookCommandOperationStartedV1["process"];
    readonly startedAt: string;
  }): Promise<HookCommandOperationStartedV1> {
    const current = await this.requireState("spawning");
    const nextCandidate: Record<string, unknown> = { ...current };
    delete nextCandidate.spawningAt;
    delete nextCandidate.supervisor;
    const next = hookCommandOperationRecordSchema.parse({
      ...nextCandidate,
      process: input.process,
      startedAt: input.startedAt,
      state: "started",
    }) as HookCommandOperationStartedV1;
    await replaceRecord(this.directory, `${this.invocationId}.json`, input.nonce, next);
    return next;
  }

  async markSpawning(input: {
    readonly nonce: string;
    readonly spawningAt: string;
    readonly supervisor: HookCommandOperationSpawningV1["supervisor"];
  }): Promise<HookCommandOperationSpawningV1> {
    const current = await this.requireState("requested");
    const next = hookCommandOperationRecordSchema.parse({
      ...current,
      spawningAt: input.spawningAt,
      state: "spawning",
      supervisor: input.supervisor,
    }) as HookCommandOperationSpawningV1;
    await replaceRecord(this.directory, `${this.invocationId}.json`, input.nonce, next);
    return next;
  }

  async markCaptured(input: {
    readonly capture: HookCommandOperationCaptureV1;
    readonly capturedAt: string;
    readonly nonce: string;
  }): Promise<HookCommandOperationCapturedV1> {
    const current = await this.requireState("started");
    const next = hookCommandOperationRecordSchema.parse({
      ...current,
      capture: input.capture,
      capturedAt: input.capturedAt,
      state: "captured",
    }) as HookCommandOperationCapturedV1;
    await replaceRecord(this.directory, `${this.invocationId}.json`, input.nonce, next);
    return next;
  }

  async markTerminal(input: {
    readonly committedAt: string;
    readonly nonce: string;
    readonly terminalEventId: string;
    readonly terminalType: "hook.invocation.completed" | "hook.invocation.decided" | "hook.invocation.failed";
  }): Promise<void> {
    const current = await this.read();
    if (current === null) throw operationError("Hook operation record disappeared before terminal commit");
    if (current.terminalEventId !== input.terminalEventId) {
      throw operationError("Hook terminal event identity disagrees with its operation journal");
    }
    if (current.state === "terminal") {
      if (current.terminalType !== input.terminalType) {
        throw operationError("Hook operation already has a different terminal type");
      }
      return;
    }
    if (current.state !== "captured") {
      throw operationError("Hook operation cannot commit a terminal before capture");
    }
    const next = hookCommandOperationRecordSchema.parse({
      ...current,
      state: "terminal",
      terminalCommittedAt: input.committedAt,
      terminalType: input.terminalType,
    });
    await replaceRecord(this.directory, `${this.invocationId}.json`, input.nonce, next);
  }

  async markNotStartedCaptured(input: {
    readonly code: "hook_gate_output_invalid" | "hook_invocation_cancelled" | "hook_invocation_failed" | "hook_invocation_timeout";
    readonly capturedAt: string;
    readonly nonce: string;
  }): Promise<HookCommandOperationCapturedV1> {
    const current = await this.read();
    if (current === null) throw operationError("Hook operation disappeared before not-started capture");
    if (current.state !== "requested" && current.state !== "spawning") {
      throw operationError("Hook operation cannot prove not-started after a child identity exists");
    }
    const nextCandidate: Record<string, unknown> = { ...current };
    delete nextCandidate.spawningAt;
    delete nextCandidate.supervisor;
    const next = hookCommandOperationRecordSchema.parse({
      ...nextCandidate,
      capture: {
        code: input.code,
        effectState: "none",
        kind: "failure",
      },
      capturedAt: input.capturedAt,
      state: "captured",
    }) as HookCommandOperationCapturedV1;
    await replaceRecord(this.directory, `${this.invocationId}.json`, input.nonce, next);
    return next;
  }

  private async requireState<TState extends HookCommandOperationRecordV1["state"]>(
    state: TState,
  ): Promise<Extract<HookCommandOperationRecordV1, { readonly state: TState }>> {
    const current = await this.read();
    if (current === null || current.state !== state) {
      throw operationError(`Hook operation expected ${state} state`);
    }
    return current as Extract<HookCommandOperationRecordV1, { readonly state: TState }>;
  }
}

export async function listHookCommandOperationRecords(input: {
  readonly root: string;
  readonly sessionId: string;
}): Promise<readonly HookCommandOperationRecordV1[]> {
  assertUuid(input.sessionId, "Hook operation session ID");
  const sessionRoot = join(resolve(input.root), input.sessionId);
  let runEntries;
  try {
    const metadata = await lstat(sessionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw operationError("Hook operation session path is unsafe");
    }
    runEntries = await readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return Object.freeze([]);
    throw error;
  }
  const records: HookCommandOperationRecordV1[] = [];
  for (const runEntry of runEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!runEntry.isDirectory() || !UUID.test(runEntry.name)) {
      throw operationError("Hook operation session contains an unexpected run entry");
    }
    const runRoot = join(sessionRoot, runEntry.name);
    const invocationEntries = await readdir(runRoot, { withFileTypes: true });
    for (const entry of invocationEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !UUID.test(entry.name.slice(0, -5))) {
        throw operationError("Hook operation run contains an unexpected invocation entry");
      }
      const record = await readRecord(join(runRoot, entry.name));
      if (
        record === null ||
        record.sessionId !== input.sessionId ||
        record.runId !== runEntry.name ||
        `${record.invocationId}.json` !== entry.name
      ) {
        throw operationError("Hook operation record identity disagrees with its path");
      }
      records.push(record);
    }
  }
  return Object.freeze(records);
}
