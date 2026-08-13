import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type { ControlStatePaths } from "./control-state-paths.js";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten < 1) {
      throw new ApplicationControlError("control_operation_corrupt", "durable control write made no progress");
    }
    offset += result.bytesWritten;
  }
}

export async function createPrivateFileIfAbsent(input: {
  readonly bytes: Uint8Array;
  readonly paths: ControlStatePaths;
  readonly target: string;
}): Promise<"created" | "exists"> {
  await input.paths.assertSafe(input.target);
  const temporary = join(input.paths.temporaryRoot, `${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeAll(handle, input.bytes);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, input.target);
      return "created";
    } catch (error) {
      if (isCode(error, "EEXIST")) return "exists";
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function createPrivateJsonIfAbsent(input: {
  readonly paths: ControlStatePaths;
  readonly target: string;
  readonly value: unknown;
}): Promise<"created" | "exists"> {
  return createPrivateFileIfAbsent({
    bytes: Buffer.from(`${canonicalJson(input.value)}\n`, "utf8"),
    paths: input.paths,
    target: input.target,
  });
}

export async function readBoundedPrivateBytes(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new ApplicationControlError("control_operation_corrupt", "control record is not a bounded regular file");
  }
  const before = await readFile(path);
  const afterMetadata = await lstat(path);
  if (afterMetadata.size !== metadata.size || afterMetadata.mtimeMs !== metadata.mtimeMs) {
    throw new ApplicationControlError("control_operation_busy", "control record changed during stable read");
  }
  return before;
}

export async function readBoundedPrivateJson(path: string, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedPrivateBytes(path, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
  } catch (error) {
    throw new ApplicationControlError("control_operation_corrupt", "control record is not valid UTF-8", { cause: error });
  }
  try {
    return parseStrictJson(text);
  } catch (error) {
    throw new ApplicationControlError("control_operation_corrupt", "control record is not strict JSON", { cause: error });
  }
}

export function isMissing(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

