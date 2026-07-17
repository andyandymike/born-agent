import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareNodeAttemptWorkspace } from "../../src/evals/attempt-workspace-node.js";
import { NodeEvalRuntime } from "../../src/evals/eval-runtime.js";
import { loadEvalAssets } from "../../src/evals/eval-suite-loader.js";

const temporaryRoots: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bornagent-phase14-"));
  temporaryRoots.push(root);
  await cp(path.join(process.cwd(), "evals"), path.join(root, "evals"), { recursive: true, errorOnExist: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 14 checked-in assets and fresh Git attempts", () => {
  it("loads exactly 20 versioned tasks and a fixed five-task smoke plan", async () => {
    const assets = await loadEvalAssets(path.join(process.cwd(), "evals"));
    expect(assets.tasks.size).toBe(20);
    expect(assets.suite.suite.smoke_task_ids).toEqual([
      "read-paths", "edit-clamp", "verify-failing-test", "safety-denied-secret", "context-overflow",
    ]);
    expect(assets.suite.suite.full_task_ids).toHaveLength(20);
    expect(assets.tasks.get("resume-checkpoint")?.task.scenario.scenario.kind).toBe("scripted_v1");
    expect(assets.tasks.get("mcp-origin")?.task.scenario.resolvedServices).toHaveLength(1);
  });

  it("creates deterministic independent Git baselines without mutating the fixture", async () => {
    const root = await temporaryWorkspace();
    const source = path.join(root, "evals", "tasks", "edit-clamp", "workspace");
    const firstRoot = path.join(root, "attempt-a");
    const secondRoot = path.join(root, "attempt-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const first = await prepareNodeAttemptWorkspace(source, firstRoot);
    await writeFile(path.join(first.workspacePath, "answer.txt"), "MUTATED\n", "utf8");
    const second = await prepareNodeAttemptWorkspace(source, secondRoot);

    expect(first.baselineGitHead).toBe(second.baselineGitHead);
    expect(first.initialManifest.sourceStateSha256).toBe(second.initialManifest.sourceStateSha256);
    await expect(readFile(path.join(second.workspacePath, "answer.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(source, "answer.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});

describe("Phase 14 zero-cost Node eval runtime", () => {
  it("refuses remote and full runs before attempts, then runs and compares targeted fake attempts", async () => {
    const root = await temporaryWorkspace();
    const catalogRefresh = vi.fn(async () => []);
    let counter = 0;
    const runtime = new NodeEvalRuntime({
      workspace: root,
      timestamp: () => "2026-07-17T00:00:00.000Z",
      randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      ollamaCatalog: { refresh: catalogRefresh } as never,
    });

    const forbidden = await runtime.run({ suite: "smoke", provider: "openai", model: "never", json: true });
    expect(forbidden.exitCode).toBe(2);
    expect(catalogRefresh).not.toHaveBeenCalled();
    await expect(readdir(path.join(root, ".bornagent"))).rejects.toMatchObject({ code: "ENOENT" });

    const full = await runtime.run({ suite: "full", provider: "fake", model: "deterministic-v1", json: true });
    expect(full.exitCode).toBe(2);
    const fullSummary = JSON.parse(full.stdout ?? "") as Record<string, unknown> & { evalRunId: string };
    expect(fullSummary).toMatchObject({ fullSuiteExecution: "not_run_by_policy", exitCode: 2 });
    expect(fullSummary.denominators).toMatchObject({ scheduled: 20, valid: 0 });
    await expect(readdir(path.join(root, ".bornagent", "evals", fullSummary.evalRunId, "attempts"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalid = await runtime.run({ suite: "smoke", task: "edit-clamp", provider: "fake", model: "harness-invalid-v1", repetitions: "1", json: true });
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout ?? "").denominators).toMatchObject({ scheduled: 1, valid: 0, harnessInvalid: 1 });

    const sentinel = "SHOULD_NOT_BE_READ_PHASE14";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = sentinel;
    try {
      const baseline = await runtime.run({ suite: "smoke", task: "edit-clamp", provider: "fake", model: "deterministic-v1", repetitions: "1", json: true });
      const candidate = await runtime.run({ suite: "smoke", task: "edit-clamp", provider: "fake", model: "false-complete-v1", repetitions: "1", json: true });
      expect(baseline.exitCode).toBe(0);
      expect(candidate.exitCode).toBe(9);
      const baselineSummary = JSON.parse(baseline.stdout ?? "") as { evalRunId: string };
      const candidateSummary = JSON.parse(candidate.stdout ?? "") as { evalRunId: string };
      const comparison = await runtime.compare({ baselineId: baselineSummary.evalRunId, candidateId: candidateSummary.evalRunId, json: true });
      expect(comparison.exitCode).toBe(9);
      expect(JSON.parse(comparison.stdout ?? "")).toMatchObject({ compatible: true, regressions: ["false_complete_increase:edit-clamp", "pass_to_fail:edit-clamp"] });
      const shown = await runtime.show({ runId: candidateSummary.evalRunId, attempt: "edit-clamp:r1", json: true });
      expect(shown.exitCode).toBe(9);
      expect(shown.stdout).not.toContain(sentinel);
      const reportText = await readFile(path.join(root, ".bornagent", "evals", candidateSummary.evalRunId, "summary.json"), "utf8");
      expect(reportText).not.toContain(sentinel);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  }, 30_000);
});
