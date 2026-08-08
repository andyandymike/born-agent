import { afterEach, describe, expect, it } from "vitest";

import { selectRepositoryRuleContext } from "../../src/context/repository-rule-context-selector.js";
import { NestedAgentsLoader } from "../../src/repository-rules/nested-agents-loader.js";
import { RepositoryRuleObservationTracker } from "../../src/repository-rules/repository-rule-observation-binding.js";
import { RepositoryRuleScopeResolver } from "../../src/repository-rules/repository-rule-scope.js";
import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";
import { cleanupPhase17Rules, PHASE17_SHA, phase17RulesWorkspace, Phase17RuleArtifactStore, writeRule } from "./phase17b-test-helpers.js";

afterEach(cleanupPhase17Rules);

describe("Phase 17B read-tool rule observation binding", () => {
  it("keeps model output separate while selecting every trusted search scope", async () => {
    const root = await phase17RulesWorkspace();
    await writeRule(root, "AGENTS.md", "root\n");
    await writeRule(root, "a/AGENTS.md", "a\n");
    await writeRule(root, "a/main.ts", "export const needle = 'a';\n");
    await writeRule(root, "b/AGENTS.md", "b\n");
    await writeRule(root, "b/main.ts", "export const needle = 'b';\n");
    const rules = await (await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() })).loadForRun(PHASE17_SHA);
    const tracker = new RepositoryRuleObservationTracker(new RepositoryRuleScopeResolver(rules.manifest));
    const registry = await createReadonlyToolRegistry(root, [], undefined, [], {
      assertFresh: async () => undefined,
      tracker,
    });
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify({ glob: null, mode: "literal", path: null, query: "needle" }),
        callId: "search-rules",
        name: "search",
        step: 1,
      },
      new AbortController().signal,
    );
    expect(execution.ok).toBe(true);
    expect(execution.repositoryRuleBinding?.targetScopes).toHaveLength(2);
    expect(execution.output).not.toContain("ruleManifestSha256");
    const selected = selectRepositoryRuleContext(rules, tracker.resolver, {
      eventId: "manifest",
      recency: 1,
      trustedTargetPaths: tracker.trustedTargetPaths(),
    });
    expect(selected.items.map((item) => item.content)).toEqual(["root\n", "a\n", "b\n"]);
  });

  it("stably truncates a list before returning more than sixteen bound target scopes", async () => {
    const root = await phase17RulesWorkspace();
    for (let index = 0; index < 17; index += 1) {
      const directory = `scope-${String(index).padStart(2, "0")}`;
      await writeRule(root, `${directory}/AGENTS.md`, `${directory}\n`);
      await writeRule(root, `${directory}/main.ts`, `export const value${index} = true;\n`);
    }
    const rules = await (await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() })).loadForRun(PHASE17_SHA);
    const tracker = new RepositoryRuleObservationTracker(new RepositoryRuleScopeResolver(rules.manifest));
    const registry = await createReadonlyToolRegistry(root, [], undefined, [], {
      assertFresh: async () => undefined,
      tracker,
    });
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify({ glob: "*.ts", path: null }),
        callId: "list-rules",
        name: "list_files",
        step: 1,
      },
      new AbortController().signal,
    );
    expect(execution.ok).toBe(true);
    expect(execution.repositoryRuleBinding).toMatchObject({
      ruleScopeTruncated: true,
      targetScopes: expect.any(Array),
    });
    expect(execution.repositoryRuleBinding?.targetScopes).toHaveLength(16);
    expect(JSON.parse(execution.output)).toMatchObject({
      ok: true,
      rule_scope_truncated: true,
      truncated: true,
    });
  });
});
