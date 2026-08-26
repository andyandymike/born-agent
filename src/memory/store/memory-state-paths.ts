import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { Ml1MemoryError } from "../core/ml1-memory-error.js";

function pathKey(value: string): string {
  const normalized = value.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory state path is not a real directory");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export interface Ml1MemoryStatePaths {
  readonly databaseExisted: boolean;
  readonly databasePath: string;
  readonly memoryRoot: string;
  readonly versionRoot: string;
}

export async function createMl1MemoryStatePaths(stateRootInput: string): Promise<Ml1MemoryStatePaths> {
  if (!isAbsolute(stateRootInput)) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory state root must be absolute");
  }
  const requestedRoot = resolve(stateRootInput);
  await ensurePrivateDirectory(requestedRoot);
  const canonicalStateRoot = await realpath(requestedRoot);
  const memoryRoot = join(canonicalStateRoot, "memory");
  const versionRoot = join(memoryRoot, "v1");
  for (const directory of [memoryRoot, versionRoot]) {
    if (!contained(canonicalStateRoot, directory)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory state path escaped its root");
    }
    await ensurePrivateDirectory(directory);
    if (!contained(canonicalStateRoot, await realpath(directory))) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory state path escaped through a link or junction");
    }
  }
  const databasePath = join(versionRoot, "memory.sqlite3");
  let databaseExisted = true;
  try {
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database is not a regular file");
    }
    const handle = await open(databasePath, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
      if (bytesRead !== header.byteLength || header.toString("binary") !== "SQLite format 3\u0000") {
        throw new Ml1MemoryError("memory_store_corrupt", "existing memory database header is invalid");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      // The SQLite owner creates the database below this already-verified parent.
      databaseExisted = false;
    } else {
      throw error;
    }
  }
  return Object.freeze({ databaseExisted, databasePath, memoryRoot, versionRoot });
}
