import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { planPersistentFactUpdate } from "../../src/repository-intelligence/persistent-fact-update.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
describe("RIC3 persistent fact planner", () => {
  it("recomputes an exact reverse-dependency closure and reuses unrelated units", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric3-plan-"));
    temporary.push(root);
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
    await writeFile(join(root, "other.ts"), "export const other = true;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const before = await snapshotter.snapshot();
    const records = await new TypeScriptLanguageServiceAdapter().build(root, before, new AbortController().signal);
    await writeFile(join(root, "value.ts"), "export const value = 2;\n", "utf8");
    const plan = planPersistentFactUpdate(records, await snapshotter.snapshot());
    expect(plan).toMatchObject({
      dependencyInvalidated: ["use.ts"],
      directChanged: ["value.ts"],
      reparsedUnits: ["use.ts", "value.ts"],
      updateMode: "incremental",
    });
    expect(plan.reusedUnits).toContain("other.ts");
  });

  it("falls back for global or dynamic dependency scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric3-plan-"));
    temporary.push(root);
    await writeFile(join(root, "global.ts"), "export const value = 1;\n", "utf8");
    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const before = await snapshotter.snapshot();
    const records = await new TypeScriptLanguageServiceAdapter().build(root, before, new AbortController().signal);
    await writeFile(join(root, "global.ts"), "declare global { interface Window { value: number } }\nexport const value = 2;\n", "utf8");
    expect(planPersistentFactUpdate(records, await snapshotter.snapshot())).toMatchObject({
      reason: "persistent_fact_dependency_scope_unknown",
      updateMode: "full_rebuild_required",
    });
  });
});
