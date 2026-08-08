import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { RepositoryIndexStore } from "../../src/repository-intelligence/index-store.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];
const RULE_SHA = "b".repeat(64);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17C immutable index store", () => {
  it("publishes, validates, and reuses an immutable generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-store-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const built = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: RULE_SHA,
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });
    const store = await RepositoryIndexStore.create(root);
    const lock = { assertOwned: vi.fn(async () => undefined) };
    const installed = await store.publish(built, lock);
    expect((await store.readCurrent())?.generation).toEqual(built.generation);
    expect(installed.records).toEqual(built.records);
    expect((await store.publish(built, lock)).manifestSha256).toBe(installed.manifestSha256);
    expect(lock.assertOwned).toHaveBeenCalled();
  });

  it("rejects a tampered generation table", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-store-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const built = buildIndexGeneration({ engineIdentitySha256: engine.identity.identitySha256, records: await engine.build(root, snapshot, new AbortController().signal), ruleManifestSha256: RULE_SHA, sourceCoverage: snapshot.snapshot.coverage, sourceStateSha256: snapshot.snapshot.sourceStateSha256 });
    const store = await RepositoryIndexStore.create(root);
    await store.publish(built, { assertOwned: async () => undefined });
    await writeFile(join(store.paths.generationPath(built.generation.generationSha256), "symbols.data"), "[]\n", "utf8");
    await expect(store.readGeneration(built.generation.generationSha256)).rejects.toMatchObject({ code: "repository_index_corrupt" });
  });

  it("quarantines only the corrupt immutable generation before republishing exact content", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-store-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const built = buildIndexGeneration({ engineIdentitySha256: engine.identity.identitySha256, records: await engine.build(root, snapshot, new AbortController().signal), ruleManifestSha256: RULE_SHA, sourceCoverage: snapshot.snapshot.coverage, sourceStateSha256: snapshot.snapshot.sourceStateSha256 });
    const store = await RepositoryIndexStore.create(root);
    const lock = { assertOwned: vi.fn(async () => undefined) };
    await store.publish(built, lock);
    await writeFile(join(store.paths.generationPath(built.generation.generationSha256), "symbols.data"), "[]\n", "utf8");

    const recovered = await store.publish(built, lock);

    expect(recovered.records).toEqual(built.records);
    expect((await store.readCurrent())?.generation.generationSha256).toBe(built.generation.generationSha256);
    expect(await readdir(store.paths.quarantineRoot)).toEqual([
      expect.stringMatching(new RegExp(`^${built.generation.generationSha256}\\.[0-9a-f-]{36}\\.corrupt$`, "u")),
    ]);
  });
});
