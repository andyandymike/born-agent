import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";
import { repositoryCacheStorageVersion } from "../../src/repository-intelligence/repository-cache-version.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("RIC4 repository cache production cutover", () => {
  it("selects only v2, preserves the v1 navigation key, and runs bounded foreground GC", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric4-cutover-"));
    temporary.push(root);
    const source = join(root, "value.ts");
    await writeFile(source, "export const value = 0;\n", "utf8");
    expect(repositoryCacheStorageVersion).toBe("v2");
    const service = await DefaultRepositoryNavigationService.create(root);
    for (let index = 0; index < 5; index += 1) {
      await writeFile(source, `export const value = ${String(index)};\n`, "utf8");
      await service.rebuild(new AbortController().signal);
    }
    const store = await RepositoryIndexV2Store.openExisting(root);
    expect(store).not.toBeNull();
    expect(await readdir(store!.paths.rootsRoot)).toHaveLength(1);
    expect(await readdir(store!.paths.gcPendingRoot)).toEqual([]);
    expect(await DefaultRepositoryNavigationService.inspect(root)).toMatchObject({ indexState: "ready" });
    await expect(readFile(join(root, ".bornagent", "cache", "repository-intelligence", "v1", "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const parentKey = await readFile(join(root, ".bornagent", "cache", "repository-intelligence", "navigation-integrity.key"));
    const legacyKey = await readFile(join(root, ".bornagent", "cache", "repository-intelligence", "v1", "navigation-integrity.key"));
    expect(parentKey).toEqual(legacyKey);
  });

  it("fails closed when parent and v1 navigation keys disagree", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric4-key-conflict-"));
    temporary.push(root);
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
    await DefaultRepositoryNavigationService.create(root);
    const parent = join(root, ".bornagent", "cache", "repository-intelligence", "navigation-integrity.key");
    await unlink(parent);
    await writeFile(parent, Buffer.alloc(32, 7));
    await expect(DefaultRepositoryNavigationService.create(root)).rejects.toMatchObject({
      code: "repository_cache_migration_blocked",
    });
  });

  it("recovers either one-key migration state without replacing the existing key", async () => {
    for (const initial of ["parent", "v1"] as const) {
      const root = await mkdtemp(join(tmpdir(), `bornagent-ric4-key-${initial}-`));
      temporary.push(root);
      await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
      const key = Buffer.alloc(32, initial === "parent" ? 3 : 5);
      const cacheRoot = join(root, ".bornagent", "cache", "repository-intelligence");
      const parentPath = join(cacheRoot, "navigation-integrity.key");
      const v1Path = join(cacheRoot, "v1", "navigation-integrity.key");
      await mkdir(join(cacheRoot, "v1"), { recursive: true });
      await writeFile(initial === "parent" ? parentPath : v1Path, key);

      await DefaultRepositoryNavigationService.create(root);

      expect(await readFile(parentPath)).toEqual(key);
      expect(await readFile(v1Path)).toEqual(key);
    }
  });

  it("accounts protected v1 bytes before publishing v2 and fails closed over budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric4-budget-"));
    temporary.push(root);
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
    const service = await DefaultRepositoryNavigationService.create(root);
    const protectedV1 = join(root, ".bornagent", "cache", "repository-intelligence", "v1", "protected.bin");
    const handle = await open(protectedV1, "w");
    try {
      // Logical size is authoritative for the fail-closed admission check; a
      // sparse fixture keeps the test fast and avoids allocating 470 MiB.
      await handle.truncate(470 * 1024 * 1024);
    } finally {
      await handle.close();
    }

    await expect(service.rebuild(new AbortController().signal)).rejects.toMatchObject({
      code: "repository_index_budget_exceeded",
      exitCode: 7,
    });
    const store = await RepositoryIndexV2Store.openExisting(root);
    await expect(readFile(store!.paths.currentPointerPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(protectedV1)).size).toBe(470 * 1024 * 1024);
  });
});
