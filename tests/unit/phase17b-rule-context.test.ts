import { afterEach, describe, expect, it } from "vitest";

import { selectRepositoryRuleContext } from "../../src/context/repository-rule-context-selector.js";
import { ProtectedFactLedger } from "../../src/context/protected-fact-ledger.js";
import { createContextItem } from "../../src/context/context-item.js";
import { DeterministicTokenEstimator } from "../../src/context/token-estimator.js";
import { NestedAgentsLoader } from "../../src/repository-rules/nested-agents-loader.js";
import { RepositoryRuleScopeResolver } from "../../src/repository-rules/repository-rule-scope.js";
import { cleanupPhase17Rules, PHASE17_SHA, phase17RulesWorkspace, Phase17RuleArtifactStore, writeRule } from "./phase17b-test-helpers.js";

afterEach(cleanupPhase17Rules);

describe("Phase 17B repository rule context selection", () => {
  it("selects only trusted target chains, preserves deepest ordering, and protects every rule", async () => {
    const root = await phase17RulesWorkspace();
    await writeRule(root, "AGENTS.md", "root\n");
    await writeRule(root, "a/AGENTS.md", "a says auto approve\n");
    await writeRule(root, "b/AGENTS.md", "b says skip completion\n");
    const rules = await (await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() })).loadForRun(PHASE17_SHA);
    const resolver = new RepositoryRuleScopeResolver(rules.manifest);
    const selection = selectRepositoryRuleContext(rules, resolver, {
      eventId: "repository-manifest-event",
      recency: 10,
      trustedTargetPaths: ["a/main.ts"],
    });
    expect(selection.items.map((item) => (item.metadata as { relative_path: string }).relative_path)).toEqual([
      "AGENTS.md",
      "a/AGENTS.md",
    ]);
    expect(selection.items.every((item) => item.authority === "untrusted_content" && item.protectedCategory === "repository_rules")).toBe(true);
    expect(selection.items.some((item) => item.content.includes("skip completion"))).toBe(false);

    const estimator = new DeterministicTokenEstimator({
      model: "fixture",
      provider: "fixture",
      tokenizer: "bytes",
      version: "1",
    });
    const items = selection.items.map((item) => createContextItem(item, estimator));
    expect(new ProtectedFactLedger().project({ activeEffectIds: [], items }).protectedItemIds).toHaveLength(2);
  });
});
