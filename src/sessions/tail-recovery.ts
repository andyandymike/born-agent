import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { assertCanonicalSessionId } from "./session-path-policy.js";
import type { SessionPathPolicy } from "./session-path-policy.js";
import type { SessionLock } from "./session-lock.js";
import {
  NodeRenameDurabilityPort,
  type RenameDurabilityPort,
} from "./rename-durability.js";

export interface StoredLineDecoder<T> {
  decode(value: unknown, physicalLine: number): T;
}

export type TailRecoveryKind = "none" | "newline_added" | "tail_removed";

export interface TailRecoveryResult<T> {
  readonly backupFileName?: string;
  readonly decoded: readonly T[];
  readonly kind: TailRecoveryKind;
  readonly lineCount: number;
  readonly removedBytes: number;
}

export interface RecoverSessionTailOptions<T> {
  readonly decoder: StoredLineDecoder<T>;
  readonly lock: SessionLock;
  readonly now?: () => Date;
  readonly policy: SessionPathPolicy;
  readonly renameDurability?: RenameDurabilityPort;
  readonly recoveryNonce?: string;
}

export class SessionTailError extends Error {
  constructor(
    readonly code:
      | "interior_corruption"
      | "recovery_readback_mismatch"
      | "stored_event_rejected"
      | "tail_not_json_object"
      | "write_incomplete",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SessionTailError";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseUtf8JsonObject(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonObject(parsed)) {
    throw new SessionTailError(
      "tail_not_json_object",
      "stored JSONL value must be one JSON object",
    );
  }
  return parsed;
}

function decodeCompleteLine<T>(
  bytes: Uint8Array,
  physicalLine: number,
  decoder: StoredLineDecoder<T>,
): T {
  if (bytes.byteLength === 0) {
    throw new SessionTailError(
      "interior_corruption",
      `empty JSONL line at physical line ${physicalLine}`,
    );
  }
  let value: Record<string, unknown>;
  try {
    value = parseUtf8JsonObject(bytes);
  } catch (error) {
    throw new SessionTailError(
      "interior_corruption",
      `invalid completed JSONL line at physical line ${physicalLine}`,
      { cause: error },
    );
  }
  try {
    return decoder.decode(value, physicalLine);
  } catch (error) {
    throw new SessionTailError(
      "stored_event_rejected",
      `stored event was rejected at physical line ${physicalLine}`,
      { cause: error },
    );
  }
}

async function writeOneBuffer(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number | null,
): Promise<void> {
  if (bytes.byteLength === 0) {
    return;
  }
  const result = await handle.write(bytes, 0, bytes.byteLength, position);
  if (result.bytesWritten !== bytes.byteLength) {
    throw new SessionTailError(
      "write_incomplete",
      "durable recovery write was incomplete",
    );
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await writeOneBuffer(handle, bytes, 0);
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readFile(path);
  if (!readback.equals(bytes)) {
    throw new SessionTailError(
      "recovery_readback_mismatch",
      "durable recovery file did not match its source bytes",
    );
  }
}

async function appendMissingNewline(path: string, original: Buffer): Promise<void> {
  const handle = await open(path, "a");
  try {
    await writeOneBuffer(handle, Buffer.from("\n", "utf8"), null);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const expected = Buffer.concat([original, Buffer.from("\n", "utf8")]);
  const readback = await readFile(path);
  if (!readback.equals(expected)) {
    throw new SessionTailError(
      "recovery_readback_mismatch",
      "newline recovery readback did not match the expected bytes",
    );
  }
}

async function replaceWithPrefix(
  sessionPath: string,
  prefix: Buffer,
  tempPath: string,
  renameDurability: RenameDurabilityPort,
): Promise<void> {
  await writePrivateFile(tempPath, prefix);
  await renameDurability.install(tempPath, sessionPath, prefix);
}

export async function recoverSessionTail<T>(
  options: RecoverSessionTailOptions<T>,
): Promise<TailRecoveryResult<T>> {
  await options.lock.assertOwned();
  await options.policy.assertSessionPathsSafe(options.lock.paths, {
    allowMissingCheckpointDirectory: true,
  });

  let source: Buffer;
  try {
    source = await readFile(options.lock.paths.sessionFilePath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { decoded: [], kind: "none", lineCount: 0, removedBytes: 0 };
    }
    throw error;
  }
  if (source.byteLength === 0) {
    return { decoded: [], kind: "none", lineCount: 0, removedBytes: 0 };
  }

  const decoded: T[] = [];
  let cursor = 0;
  let physicalLine = 1;
  for (let index = 0; index < source.byteLength; index += 1) {
    if (source[index] !== 0x0a) {
      continue;
    }
    decoded.push(
      decodeCompleteLine(
        source.subarray(cursor, index),
        physicalLine,
        options.decoder,
      ),
    );
    physicalLine += 1;
    cursor = index + 1;
  }

  if (cursor === source.byteLength) {
    return {
      decoded,
      kind: "none",
      lineCount: decoded.length,
      removedBytes: 0,
    };
  }

  const finalFragment = source.subarray(cursor);
  let parsedFinal: Record<string, unknown> | undefined;
  let incompleteSyntax = false;
  try {
    parsedFinal = parseUtf8JsonObject(finalFragment);
  } catch (error) {
    if (error instanceof SessionTailError && error.code === "tail_not_json_object") {
      throw error;
    }
    incompleteSyntax = true;
  }

  if (parsedFinal !== undefined) {
    try {
      decoded.push(options.decoder.decode(parsedFinal, physicalLine));
    } catch (error) {
      // A syntactically complete future schema or sequence violation is not a
      // torn write. Truncating it would erase a fact we merely do not understand.
      throw new SessionTailError(
        "stored_event_rejected",
        `stored event was rejected at physical line ${physicalLine}`,
        { cause: error },
      );
    }
  }

  const now = options.now ?? (() => new Date());
  const recoveryNonce = options.recoveryNonce ?? randomUUID();
  assertCanonicalSessionId(recoveryNonce);
  const suffix = `${now().getTime()}.${recoveryNonce}`;
  const backupPath = `${options.lock.paths.sessionFilePath}.corrupt.${suffix}`;
  const backupFileName = basename(backupPath);
  await writePrivateFile(backupPath, source);

  if (!incompleteSyntax) {
    await appendMissingNewline(options.lock.paths.sessionFilePath, source);
    return {
      backupFileName,
      decoded,
      kind: "newline_added",
      lineCount: decoded.length,
      removedBytes: 0,
    };
  }

  // PHASE9: Only an unterminated final byte fragment can be removed. Every
  // newline-terminated interior record was already decoded above; corruption
  // there is ambiguous history and must be rejected without rewriting bytes.
  const prefix = source.subarray(0, cursor);
  const tempPath = join(
    options.lock.paths.sessionDirectory,
    `${options.lock.record.sessionId}.jsonl.recovery.${suffix}.tmp`,
  );
  await replaceWithPrefix(
    options.lock.paths.sessionFilePath,
    prefix,
    tempPath,
    options.renameDurability ?? new NodeRenameDurabilityPort(),
  );
  await options.lock.assertOwned();
  return {
    backupFileName,
    decoded,
    kind: "tail_removed",
    lineCount: decoded.length,
    removedBytes: finalFragment.byteLength,
  };
}
