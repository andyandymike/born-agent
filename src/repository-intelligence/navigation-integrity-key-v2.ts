import { link, lstat, readFile } from "node:fs/promises";

import { RepositoryIndexPathPolicy } from "./index-path-policy.js";
import type { RepositoryIndexV2PathPolicy } from "./index-v2-path-policy.js";
import {
  loadOrCreateNavigationIntegrityKey,
  type NavigationIntegrityKey,
} from "./navigation-integrity-key.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function readKeyOrNull(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 32) {
      throw new Error("navigation integrity key identity is invalid");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength !== 32) throw new Error("navigation integrity key length changed");
    return bytes;
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function linkNoReplace(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
}

/**
 * The cursor/signature key is format-independent. Migration preserves the v1
 * name for old binaries and installs the parent name with create-if-absent
 * semantics; a disagreement is never repaired implicitly.
 */
export async function loadOrMigrateNavigationIntegrityKeyV2(
  paths: RepositoryIndexV2PathPolicy,
): Promise<NavigationIntegrityKey> {
  try {
    const v1 = await RepositoryIndexPathPolicy.create(paths.workspaceRealPath);
    const parentPath = paths.navigationIntegrityKeyPath();
    const v1Path = v1.navigationIntegrityKeyPath();
    let [parent, legacy] = await Promise.all([readKeyOrNull(parentPath), readKeyOrNull(v1Path)]);

    if (parent === null && legacy === null) {
      legacy = Buffer.from(await loadOrCreateNavigationIntegrityKey(v1));
    }
    if (parent === null && legacy !== null) {
      await linkNoReplace(v1Path, parentPath);
    } else if (parent !== null && legacy === null) {
      await linkNoReplace(parentPath, v1Path);
    }

    [parent, legacy] = await Promise.all([readKeyOrNull(parentPath), readKeyOrNull(v1Path)]);
    if (parent === null || legacy === null || !parent.equals(legacy)) {
      throw new RepositoryIntelligenceError(
        "repository_cache_migration_blocked",
        "v1 and v2 navigation integrity keys do not have one exact identity",
        1,
      );
    }
    return parent;
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError(
      "repository_cache_migration_blocked",
      "repository navigation integrity key migration failed",
      1,
      { cause: error },
    );
  }
}
