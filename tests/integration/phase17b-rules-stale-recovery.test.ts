import { afterEach, describe, expect, it, vi } from "vitest";

import { NestedAgentsLoader } from "../../src/repository-rules/nested-agents-loader.js";
import { RepositoryRuleChangeDetector } from "../../src/repository-rules/repository-rule-change-detector.js";
import { cleanupPhase17Rules, PHASE17_SHA, phase17RulesWorkspace, Phase17RuleArtifactStore, writeRule } from "../unit/phase17b-test-helpers.js";

afterEach(cleanupPhase17Rules);

describe("Phase 17B stale run recovery", () => {
  it("blocks the next model/effect checkpoint after current-run or external rule changes", async () => {
    const root = await phase17RulesWorkspace();
    await writeRule(root, "AGENTS.md", "version one\n");
    const loader = await NestedAgentsLoader.create(root, { artifactStore: new Phase17RuleArtifactStore() });
    const frozen = await loader.loadForRun(PHASE17_SHA);
    const detector = new RepositoryRuleChangeDetector(loader, frozen);
    expect(await detector.detect()).toEqual({ changed: false, reason: "unchanged" });

    await writeRule(root, "deep/AGENTS.md", "agent-created deeper rule\n");
    await expect(detector.assertFresh()).rejects.toEqual(expect.objectContaining({ code: "repository_rule_scope_stale" }));
    const providerSend = vi.fn();
    await detector.assertFresh().then(providerSend).catch(() => undefined);
    expect(providerSend).not.toHaveBeenCalled();

    const nextRun = await loader.loadForRun(PHASE17_SHA);
    expect(nextRun.manifest.manifestSha256).not.toBe(frozen.manifest.manifestSha256);
    await expect(
      new RepositoryRuleChangeDetector(loader, nextRun).detect(),
    ).resolves.toEqual({ changed: false, reason: "unchanged" });
  });
});
