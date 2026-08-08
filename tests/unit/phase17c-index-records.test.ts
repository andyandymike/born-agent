import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];
const RULE_SHA = "a".repeat(64);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17C canonical index records", () => {
  it("produces deterministic semantic records with UTF-8 byte authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-records-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "// 世界\nexport function alpha(): number { return 1; }\n", "utf8");
    await writeFile(join(root, "src", "use.ts"), 'import { alpha } from "./value.js";\nexport const answer = alpha();\n', "utf8");
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const first = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: RULE_SHA,
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });
    const second = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: RULE_SHA,
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });
    expect(first).toEqual(second);
    const alpha = first.records.symbols.find((symbol) => symbol.name === "alpha")!;
    expect(alpha).toMatchObject({ evidenceLevel: "semantic", relativePath: "src/value.ts" });
    expect(alpha.range.startByte).toBe(Buffer.byteLength("// 世界\nexport function ", "utf8"));
    expect(alpha.range.startLine).toBe(2);
    expect(first.records.references.some((reference) => reference.targetSymbolRecordId === alpha.recordId && reference.relation === "call")).toBe(true);
    expect(first.generation.generationSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
