import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-ric1-demand-"));
  temporary.push(root);
  await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
  return root;
}

describe("RIC1 repository cache sharded query", () => {
  it("keeps v1/v2 query results exact while v2 opens only demanded views", async () => {
    const root = await fixture();
    const v1 = await DefaultRepositoryNavigationService.create(root, { cacheStorageVersion: "v1" });
    const v2 = await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    });
    await v1.rebuild(new AbortController().signal);
    await v2.rebuild(new AbortController().signal);

    const [v1Result, v2Result] = await Promise.all([
      v1.findSymbols({ limit: 16, query: "value" }, new AbortController().signal),
      v2.findSymbols({ limit: 16, query: "value" }, new AbortController().signal),
    ]);
    expect(v2Result).toEqual(v1Result);

    const store = await RepositoryIndexV2Store.openExisting(root);
    expect(store).not.toBeNull();
    store!.resetCounters();
    const lease = await store!.acquireCurrentLease();
    expect(lease).not.toBeNull();
    const directory = await lease!.readSymbolSearchDirectory();
    const selected = directory.filter((entry) => entry.name === "value");
    await lease!.readSymbolPayloads([...new Set(selected.map((entry) => entry.payloadPartitionKey))]);
    await lease!.release();
    const counters = store!.snapshotCounters();
    expect(counters.dataObjectBytesReadByKind.symbol_search_directory).toBeGreaterThan(0);
    expect(counters.dataObjectBytesReadByKind.symbol_payload).toBeGreaterThan(0);
    expect(counters.dataObjectBytesReadByKind.reference_posting).toBe(0);
    expect(counters.dataObjectBytesReadByKind.dependency_view).toBe(0);
    expect(counters.dataObjectBytesReadByKind.fact_receipt).toBe(0);
  }, 20_000);

  it("audits every object for status but does not read unrelated postings for symbol lookup", async () => {
    const root = await fixture();
    const service = await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: false,
    });
    await service.rebuild(new AbortController().signal);
    const store = await RepositoryIndexV2Store.openExisting(root);
    expect(store).not.toBeNull();
    store!.resetCounters();

    const lease = await store!.acquireCurrentLease();
    const directory = await lease!.readSymbolSearchDirectory();
    const selected = directory.filter((entry) => entry.name === "answer");
    await lease!.readSymbolPayloads([...new Set(selected.map((entry) => entry.payloadPartitionKey))]);
    await lease!.release();
    expect(store!.snapshotCounters().dataObjectBytesReadByKind.reference_posting).toBe(0);

    store!.resetCounters();
    await store!.readCurrent();
    expect(store!.snapshotCounters().dataObjectBytesReadByKind.reference_posting).toBeGreaterThan(0);
    expect(store!.snapshotCounters().dataObjectBytesReadByKind.fact_receipt).toBe(0);
  }, 20_000);
});
