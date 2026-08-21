/**
 * The selected production storage format. Candidate stores are injected
 * explicitly by tests and benchmark runners; product code has one selector.
 */
export const repositoryCacheStorageVersion = "v2" as const;

/**
 * RIC3 remains an isolated candidate until same-patch evidence proves its
 * 30% fresh-process latency gate. Sharding, leases, and rooted GC do not
 * depend on this optional optimization.
 */
export const repositoryCachePersistentFactsEnabled = false;

export type RepositoryCacheStorageVersion = "v1" | "v2";

export function repositoryCacheCurrentRelativePath(
  version: RepositoryCacheStorageVersion = repositoryCacheStorageVersion,
): string {
  return `.bornagent/cache/repository-intelligence/${version}/current.json`;
}

export function repositoryCacheIndexLockRelativePath(
  version: RepositoryCacheStorageVersion = repositoryCacheStorageVersion,
): string {
  return `.bornagent/cache/repository-intelligence/${version}/locks/index.lock`;
}
