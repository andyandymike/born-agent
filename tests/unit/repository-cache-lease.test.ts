import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";
import { RepositoryIndexLock } from "../../src/repository-intelligence/index-lock.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("RIC2 repository cache reader lease", () => {
  it("installs an exact root lease and releases it idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-lease-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    })).rebuild(new AbortController().signal);
    const store = await RepositoryIndexV2Store.openExisting(root);
    const lease = await store!.acquireCurrentLease();
    expect(lease).not.toBeNull();
    expect(lease!.record.storageManifestSha256).toBe(lease!.root.storageManifestSha256);
    expect(await store!.paths.objectPath(lease!.root.unitDirectoryObjects[0]!.sha256)).toContain("objects");
    await lease!.readUnits();
    await lease!.release();
    await lease!.release();
    await expect(lease!.readUnits()).rejects.toMatchObject({ code: "repository_cache_lease_invalid" });
  });

  it("reclaims only a proven-dead same-host lease after the minimum age", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-lease-"));
    temporary.push(root);
    const source = join(root, "a.ts");
    await writeFile(source, "export const a = 1;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    })).rebuild(new AbortController().signal);
    const start = new Date("2026-08-21T00:00:00.000Z");
    const crashed = await RepositoryIndexV2Store.openExisting(root, {
      now: () => start,
      processIdentity: { pid: 4242, startIdentity: "1".repeat(64) },
    });
    const lease = await crashed!.acquireCurrentLease();
    const oldRoot = lease!.root.storageManifestSha256;
    await writeFile(source, "export const a = 2;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    })).rebuild(new AbortController().signal);

    const unknown = await RepositoryIndexV2Store.openExisting(root, {
      now: () => new Date(start.getTime() + 60_000),
      ownerProbe: { probe: async () => "unknown" },
    });
    const preserved = await unknown!.collectGarbage({ dryRun: false });
    expect(preserved.activeLeaseCount).toBe(1);
    expect(await readdir(unknown!.paths.rootsRoot)).toContain(`${oldRoot}.json`);

    const provenDead = await RepositoryIndexV2Store.openExisting(root, {
      now: () => new Date(start.getTime() + 60_000),
      ownerProbe: { probe: async () => "missing" },
    });
    const reclaimed = await provenDead!.collectGarbage({ dryRun: false });
    expect(reclaimed.staleLeasesReclaimed).toBe(1);
    expect(await readdir(provenDead!.paths.rootsRoot)).not.toContain(`${oldRoot}.json`);
  });

  it("retries when a contended lease lock disappears before strict read", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric2-lock-release-race-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const store = await RepositoryIndexV2Store.create(root);

    const attempts = await Promise.allSettled(Array.from({ length: 24 }, async () => {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const lock = await RepositoryIndexLock.acquire(store.paths, {
          lockName: "lease-gc.lock",
          pollIntervalMs: 0,
          waitMs: 5_000,
        });
        await Promise.resolve();
        await lock.release();
      }
    }));

    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((attempt) => attempt.reason));
    expect(await readdir(store.paths.locksRoot)).toEqual([]);
    expect(await readdir(store.paths.temporaryRoot)).toEqual([]);
  }, 20_000);
});
