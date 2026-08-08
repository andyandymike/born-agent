import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { planRepositoryIncrementalUpdate } from "../../src/repository-intelligence/incremental-update-planner.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17C incremental update planner", () => {
  it("invalidates a changed module and its importer while reusing unrelated units", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-incremental-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "src", "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
    await writeFile(join(root, "src", "other.ts"), "export const other = true;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const before = await snapshotter.snapshot();
    const records = await new TypeScriptLanguageServiceAdapter().build(root, before, new AbortController().signal);
    await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n", "utf8");
    const after = await snapshotter.snapshot();
    const plan = planRepositoryIncrementalUpdate({ newSnapshot: after, oldRecords: records, oldSnapshot: before });
    expect(plan.updateMode).toBe("incremental");
    expect(plan.directChanged).toEqual(["src/value.ts"]);
    expect(plan.dependencyInvalidated).toEqual(["src/use.ts"]);
    expect(plan.reparsedUnits).toEqual(["src/use.ts", "src/value.ts"]);
    expect(plan.reusedUnits).toContain("src/other.ts");
  });

  it("reuses an identical snapshot and does not invent a rename without Git facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-incremental-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const snapshot = await snapshotter.snapshot();
    const records = await new TypeScriptLanguageServiceAdapter().build(root, snapshot, new AbortController().signal);
    expect(planRepositoryIncrementalUpdate({ newSnapshot: snapshot, oldRecords: records, oldSnapshot: snapshot })).toMatchObject({
      reparsedUnits: [],
      updateMode: "reused",
    });
  });

  it("runs the production incremental engine and matches a clean full generation exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-incremental-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "src", "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
    await writeFile(join(root, "src", "other.ts"), "export const other = true;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const before = await snapshotter.snapshot();
    const incrementalEngine = new TypeScriptLanguageServiceAdapter();
    const oldRecords = await incrementalEngine.build(root, before, new AbortController().signal);

    await writeFile(join(root, "src", "value.ts"), "export const value = 2;\nexport const added = 3;\n", "utf8");
    const after = await snapshotter.snapshot();
    const updated = await incrementalEngine.update(root, after, oldRecords, new AbortController().signal);
    expect(updated.buildMode).toBe("incremental");
    expect(updated.incrementalPlan).toMatchObject({
      dependencyInvalidated: ["src/use.ts"],
      directChanged: ["src/value.ts"],
      reparsedUnits: ["src/use.ts", "src/value.ts"],
      reusedUnits: ["src/other.ts"],
      updateMode: "incremental",
    });

    const cleanEngine = new TypeScriptLanguageServiceAdapter();
    const cleanRecords = await cleanEngine.build(root, after, new AbortController().signal);
    const ruleManifestSha256 = "a".repeat(64);
    const incrementalGeneration = buildIndexGeneration({
      engineIdentitySha256: incrementalEngine.identity.identitySha256,
      records: updated.records,
      ruleManifestSha256,
      sourceCoverage: after.snapshot.coverage,
      sourceStateSha256: after.snapshot.sourceStateSha256,
    });
    const cleanGeneration = buildIndexGeneration({
      engineIdentitySha256: cleanEngine.identity.identitySha256,
      records: cleanRecords,
      ruleManifestSha256,
      sourceCoverage: after.snapshot.coverage,
      sourceStateSha256: after.snapshot.sourceStateSha256,
    });
    expect(incrementalGeneration).toEqual(cleanGeneration);
  });

  it("falls back honestly when no same-process analysis state exists or a global script changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-incremental-"));
    temporary.push(root);
    await writeFile(join(root, "global.ts"), "const globalValue = 1;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const before = await snapshotter.snapshot();
    const warmEngine = new TypeScriptLanguageServiceAdapter();
    const records = await warmEngine.build(root, before, new AbortController().signal);
    await writeFile(join(root, "global.ts"), "const globalValue = 2;\n", "utf8");
    const after = await snapshotter.snapshot();
    await expect(warmEngine.update(root, after, records, new AbortController().signal)).resolves.toMatchObject({
      buildMode: "cold",
      incrementalPlan: { reason: "global_script_dependency_scope_unknown", updateMode: "full_rebuild_required" },
    });

    const coldEngine = new TypeScriptLanguageServiceAdapter();
    await expect(coldEngine.update(root, after, records, new AbortController().signal)).resolves.toMatchObject({
      buildMode: "cold",
      incrementalPlan: null,
    });
  });
});
