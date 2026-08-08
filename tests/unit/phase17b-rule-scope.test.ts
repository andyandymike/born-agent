import { afterEach, describe, expect, it } from "vitest";

import { NestedAgentsLoader } from "../../src/repository-rules/nested-agents-loader.js";
import { RepositoryRuleScopeResolver } from "../../src/repository-rules/repository-rule-scope.js";
import { cleanupPhase17Rules, PHASE17_SHA, phase17RulesWorkspace, Phase17RuleArtifactStore, writeRule } from "./phase17b-test-helpers.js";

afterEach(cleanupPhase17Rules);

describe("Phase 17B repository rule scopes", () => {
  it("orders root to deepest and keeps siblings plus segment prefixes isolated", async () => {
    const root = await phase17RulesWorkspace();
    await writeRule(root, "AGENTS.md", "root\n");
    await writeRule(root, "src/app/AGENTS.md", "app\n");
    await writeRule(root, "src/app/deep/AGENTS.md", "deep\n");
    await writeRule(root, "src/application/AGENTS.md", "application\n");
    const rules = await (await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() })).loadForRun(PHASE17_SHA);
    const resolver = new RepositoryRuleScopeResolver(rules.manifest);

    expect(resolver.resolve("src/app/deep/main.ts").applicableEntries.map((entry) => entry.relativePath)).toEqual([
      "AGENTS.md",
      "src/app/AGENTS.md",
      "src/app/deep/AGENTS.md",
    ]);
    expect(resolver.resolve("src/application/main.ts").applicableEntries.map((entry) => entry.relativePath)).toEqual([
      "AGENTS.md",
      "src/application/AGENTS.md",
    ]);
    expect(resolver.resolve("src/app2/main.ts").applicableEntries.map((entry) => entry.relativePath)).toEqual(["AGENTS.md"]);
    expect(resolver.resolve("src/app/main.ts").scopeSha256).not.toBe(resolver.resolve("src/app/other.ts").scopeSha256);
    expect(() => resolver.resolve("../outside.ts")).toThrow(/canonical/u);
  });
});
