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

describe("RIC3 repository cache fact receipts", () => {
  it("persists a strict acyclic portable receipt graph and recovers a corrupt receipt object", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric3-receipt-"));
    temporary.push(root);
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
    const service = await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: true,
    });
    const first = await service.rebuild(new AbortController().signal);
    const store = await RepositoryIndexV2Store.openExisting(root);
    const lease = await store!.acquireCurrentLease();
    const receipts = await lease!.readFactReceipts();
    await lease!.release();
    const identities = new Set(receipts.map((receipt) => receipt.receiptSha256));
    expect(identities.size).toBe(receipts.length);
    expect(new Set(receipts.map((receipt) => receipt.factKind))).toEqual(new Set([
      "dependency_resolution",
      "module_surface",
      "query_view",
      "semantic_unit",
      "source_unit",
      "syntax_facts",
    ]));
    expect(receipts.every((receipt) => receipt.dependencyFactSha256s.every((dependency) => identities.has(dependency)))).toBe(true);

    const currentLease = await store!.acquireCurrentLease();
    const receiptRef = currentLease!.root.factReceiptObjects[0]!;
    await currentLease!.release();
    await writeFile(await store!.paths.objectPath(receiptRef.sha256), "{}\n", "utf8");

    const recovered = await (await DefaultRepositoryNavigationService.create(root, {
      cacheStorageVersion: "v2",
      persistentFactsEnabled: true,
    })).ensureCurrent({
      allowBuild: true,
      signal: new AbortController().signal,
    });
    expect(recovered.stored.generation.generationSha256).toBe(first.stored.generation.generationSha256);
    expect(await readdir(store!.paths.quarantineObjectsRoot)).toHaveLength(1);
    expect((await store!.readCurrent())?.generation.generationSha256).toBe(first.stored.generation.generationSha256);
  });
});
