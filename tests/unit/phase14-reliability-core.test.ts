import { describe, expect, it } from "vitest";

import { classifyAttempt, computeAttemptOutcome } from "../../src/evals/attempt-classifier.js";
import { collectTerminalEvalObservations } from "../../src/evals/attempt-observation-collector.js";
import {
  buildWorkspaceContentManifest,
  createFreshWorkspaceFiles,
  EVAL_GIT_BASELINE_SHA256,
  isAgentVisibleWorkspacePath,
} from "../../src/evals/attempt-workspace.js";
import { compareEvalRuns, type ComparableEvalRun } from "../../src/evals/eval-comparator.js";
import { EvalFaultController } from "../../src/evals/eval-fault-controller.js";
import { selectEvalExitCode } from "../../src/evals/eval-exit-code.js";
import { preflightEvalNoCostPolicy } from "../../src/evals/eval-no-cost-policy.js";
import { EvalReportStore, type AtomicEvalReportPort } from "../../src/evals/eval-report-store.js";
import {
  aggregateEvalDenominators,
  aggregateReportedUsage,
  summarizeDistribution,
} from "../../src/evals/metrics-collector.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

describe("Phase 14 outcome, classifier, and metrics", () => {
  it("keeps all four completion/solution quadrants distinct", () => {
    expect(computeAttemptOutcome({ agentCompleted: true, pathPolicyPassed: true, gradersPassed: true, safetyViolation: false }).quadrant).toBe("completed_solved");
    expect(computeAttemptOutcome({ agentCompleted: true, pathPolicyPassed: false, gradersPassed: true, safetyViolation: false })).toMatchObject({ quadrant: "completed_unsolved", falseComplete: true });
    expect(computeAttemptOutcome({ agentCompleted: false, pathPolicyPassed: true, gradersPassed: true, safetyViolation: false })).toMatchObject({ quadrant: "incomplete_solved", solvedIncomplete: true });
    expect(computeAttemptOutcome({ agentCompleted: false, pathPolicyPassed: false, gradersPassed: false, safetyViolation: false }).quadrant).toBe("incomplete_unsolved");
  });

  it("uses stable evidence priority and excludes only harness invalid from valid denominator", () => {
    const result = classifyAttempt(
      { agentCompleted: false, pathPolicyPassed: false, gradersPassed: false, safetyViolation: false },
      { provider: true, permission: true, context: true, secondaryCodes: ["timeout", "timeout"] },
    );
    expect(result).toMatchObject({ validAttempt: true, primaryCategory: "provider", secondaryCodes: ["timeout"] });
    expect(
      classifyAttempt(
        { agentCompleted: false, pathPolicyPassed: false, gradersPassed: false, safetyViolation: false },
        { harness: true, provider: true },
      ),
    ).toMatchObject({ validAttempt: false, primaryCategory: "harness" });
  });

  it("preserves null usage and exposes every denominator plus median/p95/n", () => {
    const usage = aggregateReportedUsage([
      { completeness: "complete", inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: null, totalTokens: 12 },
      { completeness: "partial", inputTokens: 5, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null },
    ]);
    expect(usage).toMatchObject({ completeness: "partial", inputTokens: 15, outputTokens: null, totalTokens: null });
    expect(summarizeDistribution([10, null, 20, 30])).toEqual({ scheduledN: 4, observedN: 3, median: 20, p95: 30 });
    expect(
      aggregateEvalDenominators([
        { status: "valid", taskPassed: true, falseComplete: false, solvedIncomplete: false, safetyViolation: false },
        { status: "harness_invalid", taskPassed: null, falseComplete: null, solvedIncomplete: null, safetyViolation: null },
        { status: "cancelled", taskPassed: null, falseComplete: null, solvedIncomplete: null, safetyViolation: null },
      ]),
    ).toMatchObject({ scheduled: 3, valid: 1, harnessInvalid: 1, cancelled: 1, taskPasses: 1 });
    expect(selectEvalExitCode([9, 2, 1, 130])).toBe(130);
    expect(selectEvalExitCode([9, 2, 1])).toBe(1);
  });
});

describe("Phase 14 workspace, durable faults, and terminal observation", () => {
  it("creates independent fresh bytes and excludes harness-private metadata from source digest", () => {
    const originalBytes = new TextEncoder().encode("hello");
    const entries = [
      { path: "src/a.ts", kind: "file" as const, bytes: originalBytes },
      { path: ".git/HEAD", kind: "file" as const, bytes: new TextEncoder().encode("private") },
      { path: ".bornagent/session.json", kind: "file" as const, bytes: new TextEncoder().encode("private") },
    ];
    const first = createFreshWorkspaceFiles(entries);
    const second = createFreshWorkspaceFiles(entries);
    const firstBytes = first[0]?.bytes;
    if (firstBytes === undefined) throw new Error("missing test bytes");
    firstBytes[0] = 88;
    expect(second[0]?.bytes?.[0]).toBe(originalBytes[0]);
    expect(buildWorkspaceContentManifest(entries).files.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(isAgentVisibleWorkspacePath(".git/HEAD")).toBe(false);
    expect(EVAL_GIT_BASELINE_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => buildWorkspaceContentManifest([{ path: "src/link", kind: "symlink" }])).toThrow(/unsupported/u);
    expect(() => buildWorkspaceContentManifest([{ path: "A.ts", kind: "file", bytes: new Uint8Array() }, { path: "a.ts", kind: "file", bytes: new Uint8Array() }])).toThrow(/collision/u);
  });

  it("terminates exactly once only after durable sync", () => {
    const controller = EvalFaultController.createForAttemptHarness({
      runId: "initial",
      hook: "after_checkpoint_created",
      action: "terminate_once",
    });
    expect(() => controller.observe({ runId: "initial", hook: "after_checkpoint_created", persisted: true, synced: false })).toThrow(/durably/u);
    expect(controller.observe({ runId: "initial", hook: "after_checkpoint_created", persisted: true, synced: true })).toBe("terminate_now");
    expect(() => controller.observe({ runId: "initial", hook: "after_checkpoint_created", persisted: true, synced: true })).toThrow(/more than once/u);
  });

  it("projects only allowlisted scalar fields after terminal and produces a stable digest", () => {
    const events = [
      {
        sequence: 2,
        durable: true,
        type: "run_terminal",
        fields: { runId: "r1", terminalKind: "completed", prompt: "SECRET", output: "SECRET" },
      },
      {
        sequence: 1,
        durable: true,
        type: "command_terminal",
        fields: { runId: "r1", callId: "c1", exitCode: 0, timedOut: false, argv: ["SECRET"] },
      },
      { sequence: 3, durable: true, type: "model_message", fields: { reasoning: "SECRET" } },
    ];
    const projection = collectTerminalEvalObservations(true, events);
    expect(projection.observations.map((event) => event.order)).toEqual([1, 2]);
    expect(JSON.stringify(projection)).not.toContain("SECRET");
    expect(projection.observationsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => collectTerminalEvalObservations(false, events)).toThrow(/before scenario terminal/u);
  });
});

function comparableRun(overrides: Partial<ComparableEvalRun> = {}): ComparableEvalRun {
  return {
    compatibility: {
      suiteVersion: 1,
      tasks: [{ id: "task-a", taskVersion: 1, workspaceSha256: SHA_A, graderSha256: SHA_B, scenarioSchemaVersion: 1, scenarioKind: "single_run", scenarioSha256: SHA_C, scenarioConfigSha256: SHA_D, serviceSetSha256: SHA_A }],
      repetitionPolicySha256: SHA_B,
      attemptInclusionRule: "valid_started_v1",
      reportSchemaVersion: 1,
      metricDefinitionVersion: 1,
      priceCurrency: "USD",
    },
    config: { provider: "fake", model: "deterministic-v1", policy: SHA_C },
    tasks: [{ taskId: "task-a", passed: true, falseComplete: false, solvedIncomplete: false, safetyViolation: false }],
    harnessInvalidCount: 0,
    reportCorrupt: false,
    ...overrides,
  };
}

describe("Phase 14 report atomicity and compatible comparison", () => {
  it("detects regressions/config diffs, rejects protocol changes, and prioritizes invalid reports", () => {
    const regression = compareEvalRuns(
      comparableRun(),
      comparableRun({
        config: { provider: "mock", model: "deterministic-v2", policy: SHA_C },
        tasks: [{ taskId: "task-a", passed: false, falseComplete: true, solvedIncomplete: false, safetyViolation: false }],
      }),
    );
    expect(regression).toMatchObject({ compatible: true, exitCode: 9, statisticalClaim: null });
    expect(regression.regressions).toEqual(["false_complete_increase:task-a", "pass_to_fail:task-a"]);
    expect(regression.configDiff).toEqual(["model", "provider"]);

    const changedCompatibility = comparableRun().compatibility;
    const incompatible = compareEvalRuns(
      comparableRun(),
      comparableRun({ compatibility: { ...changedCompatibility, suiteVersion: 2 } }),
    );
    expect(incompatible).toMatchObject({ compatible: false, exitCode: 2 });
    expect(
      compareEvalRuns(
        comparableRun({ compatibility: { ...changedCompatibility, repetitions: 1 } }),
        comparableRun({ compatibility: { ...changedCompatibility, repetitions: 2 } }),
      ),
    ).toMatchObject({ compatible: false, incompatibilities: ["repetitions"], exitCode: 2 });
    expect(compareEvalRuns(comparableRun(), comparableRun({ reportCorrupt: true })).exitCode).toBe(1);
  });

  it("writes temp, syncs, renames, and rebuilds from attempt files", async () => {
    const calls: string[] = [];
    const evidence = preflightEvalNoCostPolicy({ kind: "in_process_test", provider: "fake" }).evidence;
    const report = {
      schemaVersion: 1,
      evalRunId: "run-1",
      taskId: "task-a",
      taskVersion: 1,
      repetition: 1,
      status: "partial",
      validAttempt: true,
      outcome: null,
      primaryCategory: "model",
      secondaryCodes: ["cancelled_partial"],
      taskManifestSha256: SHA_A,
      scenarioSha256: SHA_B,
      scenarioConfigSha256: SHA_C,
      serviceSetSha256: SHA_D,
      initialWorkspaceSha256: SHA_A,
      finalWorkspaceSha256: null,
      observationSha256: null,
      usage: { completeness: "none", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null },
      noCostEvidence: evidence,
      fullSuiteExecution: "not_run_by_policy",
    };
    const port: AtomicEvalReportPort = {
      async writeTemp(path) { calls.push(`write:${path}`); },
      async syncFile(path) { calls.push(`sync:${path}`); },
      async rename(from, to) { calls.push(`rename:${from}->${to}`); },
      async syncDirectory(path) { calls.push(`syncdir:${path}`); },
      async readAttemptFiles() { return [report]; },
    };
    const store = new EvalReportStore(port);
    expect(await store.writeAttempt(report)).toBe("run-1/attempts/task-a/r1.json");
    expect(calls).toEqual([
      "write:run-1/attempts/task-a/r1.json.tmp",
      "sync:run-1/attempts/task-a/r1.json.tmp",
      "rename:run-1/attempts/task-a/r1.json.tmp->run-1/attempts/task-a/r1.json",
      "syncdir:run-1/attempts/task-a",
    ]);
    expect(await store.rebuildAttempts("run-1")).toHaveLength(1);
  });
});
