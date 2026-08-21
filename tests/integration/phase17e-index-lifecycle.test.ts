import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RenameDurabilityPort } from "../../src/sessions/rename-durability.js";
import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { RepositoryIndexLock } from "../../src/repository-intelligence/index-lock.js";
import { RepositoryIndexStore } from "../../src/repository-intelligence/index-store.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase17e-lifecycle-"));
  temporary.push(root);
  await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
  return root;
}

describe("Phase 17E index lifecycle", () => {
  it("cancels a bounded lock contender without stealing or leaking the active lock", async () => {
    const root = await workspace();
    const store = await RepositoryIndexStore.create(root);
    const owner = await RepositoryIndexLock.acquire(store.paths);
    const controller = new AbortController();
    const contender = RepositoryIndexLock.acquire(store.paths, {
      pollIntervalMs: 10,
      signal: controller.signal,
      waitMs: 5_000,
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 25);
    await expect(contender).rejects.toMatchObject({ code: "repository_navigation_cancelled" });
    await owner.assertOwned();
    await owner.release();
    expect(await readdir(store.paths.locksRoot)).toEqual([]);
  });

  it("reports a corrupt pointer read-only, then repairs pointer and exact corrupt generation", async () => {
    const root = await workspace();
    const initial = await DefaultRepositoryNavigationService.create(root, { cacheStorageVersion: "v1" });
    const first = await initial.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    const store = (await RepositoryIndexStore.openExisting(root))!;
    await writeFile(join(store.paths.root, "current.json"), "{}\n", "utf8");

    await expect(DefaultRepositoryNavigationService.inspect(root, { cacheStorageVersion: "v1" })).resolves.toMatchObject({
      indexState: "blocked",
      reason: "cache_corrupt",
    });
    const pointerRepair = await DefaultRepositoryNavigationService.create(root, { cacheStorageVersion: "v1" });
    const repaired = await pointerRepair.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    expect(repaired.stored.generation.generationSha256).toBe(first.stored.generation.generationSha256);

    await writeFile(
      join(store.paths.generationPath(repaired.stored.generation.generationSha256), "symbols.data"),
      "[]\n",
      "utf8",
    );
    const generationRepair = await DefaultRepositoryNavigationService.create(root, { cacheStorageVersion: "v1" });
    const recovered = await generationRepair.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    expect(recovered.stored.generation.generationSha256).toBe(first.stored.generation.generationSha256);
    expect(await readdir(store.paths.quarantineRoot)).toEqual([
      expect.stringMatching(new RegExp(`^${first.stored.generation.generationSha256}\\.[0-9a-f-]{36}\\.corrupt$`, "u")),
    ]);
    expect((await store.readCurrent())?.generation.generationSha256).toBe(first.stored.generation.generationSha256);
  });

  it("recovers a complete orphan generation after pointer installation fails", async () => {
    const root = await workspace();
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const snapshot = await snapshotter.snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const built = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: "a".repeat(64),
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });
    const pathsStore = await RepositoryIndexStore.create(root);
    const failingPort: RenameDurabilityPort = {
      capability: "windows_installed_file_sync",
      install: async () => { throw new Error("injected pointer install failure"); },
    };
    const failingStore = new RepositoryIndexStore(pathsStore.paths, failingPort);
    const firstLock = await RepositoryIndexLock.acquire(pathsStore.paths);
    try {
      await expect(failingStore.publish(built, firstLock)).rejects.toMatchObject({
        code: "repository_index_publish_failed",
      });
    } finally {
      await firstLock.release();
    }
    expect(await pathsStore.readCurrent()).toBeNull();
    expect((await pathsStore.readGeneration(built.generation.generationSha256)).generation).toEqual(built.generation);

    const recoveryLock = await RepositoryIndexLock.acquire(pathsStore.paths);
    try {
      await pathsStore.publish(built, recoveryLock);
    } finally {
      await recoveryLock.release();
    }
    expect((await pathsStore.readCurrent())?.generation).toEqual(built.generation);
    expect(await readdir(pathsStore.paths.temporaryRoot)).toEqual([]);

    const partialName = "build-00000000-0000-4000-8000-000000000000";
    await mkdir(join(pathsStore.paths.temporaryRoot, partialName));
    await writeFile(join(pathsStore.paths.temporaryRoot, "unknown.keep"), "not-owned\n", "utf8");
    expect(await pathsStore.recoverOwnedTemps()).toBe(1);
    expect(await readdir(pathsStore.paths.temporaryRoot)).toEqual(["unknown.keep"]);
  });
});
