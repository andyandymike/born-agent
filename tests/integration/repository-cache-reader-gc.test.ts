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

describe("RIC2 repository cache reader and GC", () => {
  it("never sweeps an old root while a reader lease still holds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-reader-gc-"));
    temporary.push(root);
    const source = join(root, "value.ts");
    await writeFile(source, "export const value = 1;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    })).rebuild(new AbortController().signal);
    const store = await RepositoryIndexV2Store.openExisting(root);
    const oldLease = await store!.acquireCurrentLease();
    const oldRoot = oldLease!.root.storageManifestSha256;

    await writeFile(source, "export const value = 2;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    })).rebuild(new AbortController().signal);
    const firstGc = await store!.collectGarbage({ dryRun: false });
    expect(firstGc.activeLeaseCount).toBe(1);
    expect(await readdir(store!.paths.rootsRoot)).toContain(`${oldRoot}.json`);
    await oldLease!.readUnits();

    await oldLease!.release();
    await store!.collectGarbage({ dryRun: false });
    expect(await readdir(store!.paths.rootsRoot)).not.toContain(`${oldRoot}.json`);
  });
});
