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

describe("RIC2 repository cache publisher and GC", () => {
  it("fails closed on an invalid lease before moving any root or object", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-publisher-gc-"));
    temporary.push(root);
    const source = join(root, "value.ts");
    await writeFile(source, "export const value = 1;\n", "utf8");
    const service = await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    });
    await service.rebuild(new AbortController().signal);
    await writeFile(source, "export const value = 2;\n", "utf8");
    await service.rebuild(new AbortController().signal);
    const store = await RepositoryIndexV2Store.openExisting(root);
    await writeFile(join(store!.paths.leasesRoot, "00000000-0000-4000-8000-000000000000.json"), "{}\n", "utf8");
    const rootsBefore = await readdir(store!.paths.rootsRoot);
    const pendingBefore = await readdir(store!.paths.gcPendingRoot);

    await expect(store!.collectGarbage({ dryRun: false })).rejects.toBeDefined();

    expect(await readdir(store!.paths.rootsRoot)).toEqual(rootsBefore);
    expect(await readdir(store!.paths.gcPendingRoot)).toEqual(pendingBefore);
  });
});
