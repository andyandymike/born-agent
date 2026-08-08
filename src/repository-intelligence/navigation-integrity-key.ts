import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";

import type { RepositoryIndexPathPolicy } from "./index-path-policy.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

export type NavigationIntegrityKey = Uint8Array;

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readKey(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 32) {
    throw new Error("navigation integrity key identity is invalid");
  }
  const key = await readFile(path);
  if (key.byteLength !== 32) throw new Error("navigation integrity key length changed");
  return key;
}

export async function loadOrCreateNavigationIntegrityKey(
  paths: RepositoryIndexPathPolicy,
): Promise<NavigationIntegrityKey> {
  const target = paths.navigationIntegrityKeyPath();
  try {
    return await readKey(target);
  } catch (error) {
    if (!isCode(error, "ENOENT")) {
      throw new RepositoryIntelligenceError("repository_index_corrupt", "repository navigation integrity key is invalid", 1, { cause: error });
    }
  }

  const temporary = paths.temporaryIntegrityKeyPath(`key-${randomUUID()}.tmp`);
  await paths.assertKnownPath(temporary, paths.temporaryRoot);
  const bytes = randomBytes(32);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A same-filesystem hard link is an atomic create-if-absent operation on
    // both Windows and POSIX; a competing process can never replace the winner.
    await link(temporary, target);
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw new RepositoryIntelligenceError("repository_index_publish_failed", "repository navigation integrity key publish failed", 1, { cause: error });
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  try {
    return await readKey(target);
  } catch (error) {
    throw new RepositoryIntelligenceError("repository_index_corrupt", "repository navigation integrity key could not be verified", 1, { cause: error });
  }
}
