import { installRepositoryCacheBenchmarkGuard } from "./repository-cache-benchmark-guard.js";

const workspace = process.argv[2];
if (workspace === undefined) throw new TypeError("repository cache writer worker requires a workspace");
const storageVersion = process.argv[3] ?? "v1";
if (storageVersion !== "v1" && storageVersion !== "v2") throw new TypeError("repository cache writer worker received an invalid storage version");
const persistentFactsEnabled = process.argv[4] === "true";

const guard = installRepositoryCacheBenchmarkGuard();
try {
  const { DefaultRepositoryNavigationService } = await import("../navigation-service.js");
  const current = await (await DefaultRepositoryNavigationService.create(workspace, {
    cacheStorageVersion: storageVersion,
    persistentFactsEnabled,
  })).ensureCurrent({
    allowBuild: true,
    signal: new AbortController().signal,
  });
  guard.assertClean();
  process.stdout.write(`${JSON.stringify({
    buildMode: current.buildMode,
    generationSha256: current.stored.generation.generationSha256,
  })}\n`);
} finally {
  guard.restore();
}
