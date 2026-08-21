import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function pathKey(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith("../") && !difference.startsWith("..\\"));
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("repository cache path is not a plain directory");
    return;
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("repository cache directory identity is invalid");
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase UUID`);
  }
}

export class RepositoryIndexV2PathPolicy {
  private constructor(
    readonly workspaceRealPath: string,
    readonly repositoryCacheRoot: string,
    readonly root: string,
    readonly rootsRoot: string,
    readonly objectsRoot: string,
    readonly leasesRoot: string,
    readonly locksRoot: string,
    readonly temporaryRoot: string,
    readonly quarantineRoot: string,
    readonly quarantineRootsRoot: string,
    readonly quarantineObjectsRoot: string,
    readonly gcPendingRoot: string,
  ) {}

  static async create(workspace: string): Promise<RepositoryIndexV2PathPolicy> {
    try {
      const workspaceRealPath = await realpath(workspace);
      let current = workspaceRealPath;
      for (const part of [".bornagent", "cache", "repository-intelligence", "v2"]) {
        current = join(current, part);
        await ensurePlainDirectory(current);
      }
      const root = current;
      const repositoryCacheRoot = join(workspaceRealPath, ".bornagent", "cache", "repository-intelligence");
      const rootsRoot = join(root, "roots");
      const objectsRoot = join(root, "objects", "sha256");
      const leasesRoot = join(root, "leases");
      const locksRoot = join(root, "locks");
      const temporaryRoot = join(root, "tmp");
      const quarantineRoot = join(root, "quarantine");
      const quarantineRootsRoot = join(quarantineRoot, "roots");
      const quarantineObjectsRoot = join(quarantineRoot, "objects");
      const gcPendingRoot = join(root, "gc-pending");
      for (const path of [
        rootsRoot,
        join(root, "objects"),
        objectsRoot,
        leasesRoot,
        locksRoot,
        temporaryRoot,
        quarantineRoot,
        quarantineRootsRoot,
        quarantineObjectsRoot,
        gcPendingRoot,
      ]) await ensurePlainDirectory(path);
      const canonicalRoot = await realpath(root);
      if (!contained(workspaceRealPath, canonicalRoot) || pathKey(canonicalRoot) !== pathKey(root)) {
        throw new Error("repository v2 cache root was redirected");
      }
      return new RepositoryIndexV2PathPolicy(
        workspaceRealPath,
        repositoryCacheRoot,
        root,
        rootsRoot,
        objectsRoot,
        leasesRoot,
        locksRoot,
        temporaryRoot,
        quarantineRoot,
        quarantineRootsRoot,
        quarantineObjectsRoot,
        gcPendingRoot,
      );
    } catch (error) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 cache path policy failed", 1, { cause: error });
    }
  }

  static async openExisting(workspace: string): Promise<RepositoryIndexV2PathPolicy | null> {
    try {
      const workspaceRealPath = await realpath(workspace);
      const repositoryCacheRoot = join(workspaceRealPath, ".bornagent", "cache", "repository-intelligence");
      const root = join(repositoryCacheRoot, "v2");
      const rootsRoot = join(root, "roots");
      const objectsRoot = join(root, "objects", "sha256");
      const leasesRoot = join(root, "leases");
      const locksRoot = join(root, "locks");
      const temporaryRoot = join(root, "tmp");
      const quarantineRoot = join(root, "quarantine");
      const quarantineRootsRoot = join(quarantineRoot, "roots");
      const quarantineObjectsRoot = join(quarantineRoot, "objects");
      const gcPendingRoot = join(root, "gc-pending");
      for (const path of [
        join(workspaceRealPath, ".bornagent"),
        join(workspaceRealPath, ".bornagent", "cache"),
        repositoryCacheRoot,
        root,
        rootsRoot,
        join(root, "objects"),
        objectsRoot,
        leasesRoot,
        locksRoot,
        temporaryRoot,
        quarantineRoot,
        quarantineRootsRoot,
        quarantineObjectsRoot,
        gcPendingRoot,
      ]) {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("repository v2 cache path is not a plain directory");
      }
      const canonicalRoot = await realpath(root);
      if (!contained(workspaceRealPath, canonicalRoot) || pathKey(canonicalRoot) !== pathKey(root)) {
        throw new Error("repository v2 cache root was redirected");
      }
      return new RepositoryIndexV2PathPolicy(
        workspaceRealPath,
        repositoryCacheRoot,
        root,
        rootsRoot,
        objectsRoot,
        leasesRoot,
        locksRoot,
        temporaryRoot,
        quarantineRoot,
        quarantineRootsRoot,
        quarantineObjectsRoot,
        gcPendingRoot,
      );
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "existing repository v2 cache path policy failed", 1, { cause: error });
    }
  }

  currentPointerPath(): string {
    return join(this.root, "current.json");
  }

  rootManifestPath(storageManifestSha256: string): string {
    assertSha256(storageManifestSha256, "storage manifest identity");
    return join(this.rootsRoot, `${storageManifestSha256}.json`);
  }

  async objectPath(objectSha256: string, createPrefix = false): Promise<string> {
    assertSha256(objectSha256, "object identity");
    const prefix = join(this.objectsRoot, objectSha256.slice(0, 2));
    if (createPrefix) {
      await ensurePlainDirectory(prefix);
      const canonical = await realpath(prefix);
      if (pathKey(canonical) !== pathKey(prefix) || !contained(this.root, canonical)) {
        throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository object prefix was redirected");
      }
    }
    return join(prefix, `${objectSha256}.data`);
  }

  leasePath(leaseId: string): string {
    assertUuid(leaseId, "lease identity");
    return join(this.leasesRoot, `${leaseId}.json`);
  }

  temporaryFilePath(name: string): string {
    if (!/^(?:object|root|pointer|lease|key|lock)-[0-9a-f-]{36}\.tmp$/u.test(name)) {
      throw new TypeError("repository cache temporary file name is invalid");
    }
    return join(this.temporaryRoot, name);
  }

  navigationIntegrityKeyPath(): string {
    return join(this.repositoryCacheRoot, "navigation-integrity.key");
  }

  gcPendingSweepPath(sweepId: string): string {
    assertUuid(sweepId, "GC sweep identity");
    return join(this.gcPendingRoot, sweepId);
  }

  async assertKnownPath(path: string, expectedParent: string): Promise<void> {
    const parentReal = await realpath(expectedParent);
    if (pathKey(parentReal) !== pathKey(expectedParent) || !contained(this.root, resolve(path))) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 cache path escaped its validated root");
    }
  }
}
