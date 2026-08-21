import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { buildRepositoryStorageLayoutV2 } from "../../src/repository-intelligence/index-v2-layout.js";
import {
  repositoryCacheObjectSha256,
  repositoryStorageRootV2Schema,
} from "../../src/repository-intelligence/index-v2-schema.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
describe("RIC1 repository cache v2 schema", () => {
  it("separates semantic generation identity from a strict sharded storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric1-schema-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const alpha = 1;\nexport function use() { return alpha; }\n", "utf8");
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const built = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: "a".repeat(64),
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });

    const layout = buildRepositoryStorageLayoutV2(built);

    expect(layout.root.generation).toEqual(built.generation);
    expect(layout.root.storageManifestSha256).not.toBe(built.generation.generationSha256);
    expect(layout.root.unitDirectoryObjects.length).toBeGreaterThan(0);
    expect(layout.root.symbolSearchDirectoryObjects.length).toBeGreaterThan(0);
    expect(layout.root.symbolPayloadObjects.length).toBeGreaterThan(0);
    expect(layout.root.factReceiptObjects.length).toBeGreaterThan(0);
    expect(() => repositoryStorageRootV2Schema.parse({
      ...layout.root,
      storageManifestSha256: "0".repeat(64),
    })).toThrow(/root hash mismatch/u);
  });

  it("domain-separates identical bytes by kind and logical partition", () => {
    const bytes = Buffer.from("{}\n", "utf8");
    const base = {
      bytes: bytes.byteLength,
      encoding: "canonical-json-v1" as const,
      objectSchemaVersion: 1 as const,
    };
    const first = repositoryCacheObjectSha256({ ...base, kind: "unit_directory", logicalPartitionKey: "all/000000" }, bytes);
    const second = repositoryCacheObjectSha256({ ...base, kind: "outline_view", logicalPartitionKey: "all/000000" }, bytes);
    const third = repositoryCacheObjectSha256({ ...base, kind: "unit_directory", logicalPartitionKey: "all/000001" }, bytes);
    expect(new Set([first, second, third]).size).toBe(3);
  });
});
