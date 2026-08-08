import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith("../") && !difference.startsWith("..\\"));
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("index state path is not a plain directory");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    // Another process may have created the exact directory after our lstat. EEXIST is only
    // accepted after the same non-link directory identity check below.
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("index state directory identity is invalid");
}

export class RepositoryIndexPathPolicy {
  private constructor(
    readonly workspaceRealPath: string,
    readonly root: string,
    readonly generationsRoot: string,
    readonly locksRoot: string,
    readonly quarantineRoot: string,
    readonly temporaryRoot: string,
  ) {}

  static async create(workspace: string): Promise<RepositoryIndexPathPolicy> {
    try {
      const workspaceRealPath = await realpath(workspace);
      const parts = [".bornagent", "cache", "repository-intelligence", "v1"];
      let current = workspaceRealPath;
      for (const part of parts) {
        current = join(current, part);
        await ensureDirectory(current);
      }
      const root = current;
      const generationsRoot = join(root, "generations");
      const locksRoot = join(root, "locks");
      const quarantineRoot = join(root, "quarantine");
      const temporaryRoot = join(root, "tmp");
      for (const path of [generationsRoot, locksRoot, quarantineRoot, temporaryRoot]) await ensureDirectory(path);
      const canonicalRoot = await realpath(root);
      if (!contained(workspaceRealPath, canonicalRoot) || pathKey(canonicalRoot) !== pathKey(root)) {
        throw new Error("index state root was redirected");
      }
      return new RepositoryIndexPathPolicy(workspaceRealPath, root, generationsRoot, locksRoot, quarantineRoot, temporaryRoot);
    } catch (error) {
      throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index path policy failed", 1, { cause: error });
    }
  }

  static async openExisting(workspace: string): Promise<RepositoryIndexPathPolicy | null> {
    try {
      const workspaceRealPath = await realpath(workspace);
      const root = join(workspaceRealPath, ".bornagent", "cache", "repository-intelligence", "v1");
      const generationsRoot = join(root, "generations");
      const locksRoot = join(root, "locks");
      const quarantineRoot = join(root, "quarantine");
      const temporaryRoot = join(root, "tmp");
      for (const path of [join(workspaceRealPath, ".bornagent"), join(workspaceRealPath, ".bornagent", "cache"), join(workspaceRealPath, ".bornagent", "cache", "repository-intelligence"), root, generationsRoot, locksRoot, quarantineRoot, temporaryRoot]) {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("existing index path is not a plain directory");
      }
      const canonicalRoot = await realpath(root);
      if (!contained(workspaceRealPath, canonicalRoot) || pathKey(canonicalRoot) !== pathKey(root)) throw new Error("existing index root was redirected");
      return new RepositoryIndexPathPolicy(workspaceRealPath, root, generationsRoot, locksRoot, quarantineRoot, temporaryRoot);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new RepositoryIntelligenceError("repository_index_corrupt", "existing repository index path policy failed", 1, { cause: error });
    }
  }

  generationPath(generationSha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(generationSha256)) throw new TypeError("generation identity must be lowercase SHA-256");
    return join(this.generationsRoot, generationSha256);
  }

  quarantineGenerationPath(generationSha256: string, nonce: string): string {
    if (!/^[a-f0-9]{64}$/u.test(generationSha256)) throw new TypeError("generation identity must be lowercase SHA-256");
    if (!/^[0-9a-f-]{36}$/u.test(nonce)) throw new TypeError("quarantine nonce is invalid");
    return join(this.quarantineRoot, `${generationSha256}.${nonce}.corrupt`);
  }

  temporaryGenerationPath(id: string): string {
    if (!/^build-[0-9a-f-]{36}$/u.test(id)) throw new TypeError("temporary index generation ID is invalid");
    return join(this.temporaryRoot, id);
  }

  navigationIntegrityKeyPath(): string {
    return join(this.root, "navigation-integrity.key");
  }

  temporaryIntegrityKeyPath(id: string): string {
    if (!/^key-[0-9a-f-]{36}\.tmp$/u.test(id)) throw new TypeError("temporary navigation key ID is invalid");
    return join(this.temporaryRoot, id);
  }

  async assertKnownPath(path: string, expectedParent: string): Promise<void> {
    const parentReal = await realpath(expectedParent);
    if (pathKey(parentReal) !== pathKey(expectedParent) || !contained(this.root, path)) {
      throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index path escaped its validated root");
    }
  }
}
