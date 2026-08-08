import { afterEach, describe, expect, it } from "vitest";

import { assertPatchRuleScopeBinding, createPatchRuleScopeBinding } from "../../src/changes/patch-rule-scope-binding.js";
import { NestedAgentsLoader } from "../../src/repository-rules/nested-agents-loader.js";
import { RepositoryRuleScopeResolver } from "../../src/repository-rules/repository-rule-scope.js";
import { cleanupPhase17Rules, PHASE17_SHA, phase17RulesWorkspace, Phase17RuleArtifactStore, writeRule } from "./phase17b-test-helpers.js";

afterEach(cleanupPhase17Rules);

describe("Phase 17B patch rule scope binding", () => {
  it("binds sorted multi-path scopes and rejects a new/deeper manifest as stale", async () => {
    const root = await phase17RulesWorkspace();
    await writeRule(root, "AGENTS.md", "root\n");
    await writeRule(root, "a/AGENTS.md", "a\n");
    const loader = await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() });
    const frozenRules = await loader.loadForRun(PHASE17_SHA);
    const frozenResolver = new RepositoryRuleScopeResolver(frozenRules.manifest);
    const binding = createPatchRuleScopeBinding(frozenResolver, ["b/main.ts", "a/main.ts"]);
    expect(binding.targets.map((target) => target.relativePath)).toEqual(["a/main.ts", "b/main.ts"]);
    expect(() => assertPatchRuleScopeBinding(binding, frozenResolver)).not.toThrow();
    expect(() => createPatchRuleScopeBinding(frozenResolver, ["a.ts", "a.ts"])).toThrow(/unique/u);

    await writeRule(root, "b/AGENTS.md", "new b rule\n");
    const nextRules = await loader.loadForRun(PHASE17_SHA);
    expect(() => assertPatchRuleScopeBinding(binding, new RepositoryRuleScopeResolver(nextRules.manifest))).toThrow(
      expect.objectContaining({ code: "repository_rule_scope_stale" }),
    );
  });
});
