import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("RIC2 repository cache rooted GC", () => {
  it("bounds historical roots and reaches an idempotent zero-work pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-gc-"));
    temporary.push(root);
    const source = join(root, "a.ts");
    await writeFile(source, "export const value = 0;\n", "utf8");
    const service = await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(source, `export const value = ${String(index)};\n`, "utf8");
      await service.rebuild(new AbortController().signal);
    }
    const store = await RepositoryIndexV2Store.openExisting(root);
    expect((await readdir(store!.paths.rootsRoot)).length).toBeGreaterThan(1);
    const beforeDryRun = await readdir(store!.paths.rootsRoot);
    const dryRun = await store!.collectGarbage({ dryRun: true });
    expect(dryRun.unreachableKnownEntries).toBeGreaterThan(0);
    expect(dryRun.gcReclaimedEntries).toBe(0);
    expect(await readdir(store!.paths.rootsRoot)).toEqual(beforeDryRun);

    for (let pass = 0; pass < 8; pass += 1) {
      const result = await store!.collectGarbage({ dryRun: false });
      if (result.unreachableKnownEntries === 0) break;
    }
    expect(await readdir(store!.paths.rootsRoot)).toHaveLength(1);
    const stable = await store!.collectGarbage({ dryRun: false });
    expect(stable).toMatchObject({ gcReclaimedBytes: 0, gcReclaimedEntries: 0, unreachableKnownBytes: 0, unreachableKnownEntries: 0 });
    expect(await readdir(store!.paths.gcPendingRoot)).toEqual([]);
  }, 60_000);
});
