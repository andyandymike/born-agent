import { mkdir } from "node:fs/promises";

import { classifyAttempt, type AttemptFailureEvidence } from "./attempt-classifier.js";
import { collectTerminalEvalObservations } from "./attempt-observation-collector.js";
import { prepareNodeAttemptWorkspace, readAttemptWorkspaceManifest, verifyNodeAttemptGitBaseline } from "./attempt-workspace-node.js";
import { EvalApprovalPolicy } from "./eval-approval-policy.js";
import type { EvalAgentDriver } from "./eval-agent-driver.js";
import { EvalCoreError } from "./eval-errors.js";
import { readEvalFileTree } from "./eval-file-tree.js";
import type { EvalTurnGuard, EvalExecutionSource } from "./eval-no-cost-policy.js";
import type { EvalAttemptReport } from "./eval-report-schema.js";
import type { EvalReportStore } from "./eval-report-store.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";
import type { EvalHiddenGrader } from "./static-hidden-grader.js";

function isPrivate(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === ".bornagent" || relativePath.startsWith(".bornagent/");
}

async function changedWorkspaceFacts(sourceRoot: string, candidateRoot: string): Promise<{ readonly paths: readonly string[]; readonly changedLines: number }> {
  const [before, after] = await Promise.all([readEvalFileTree(sourceRoot, { rejectGrader: true, rejectPrivate: true }), readEvalFileTree(candidateRoot)]);
  const beforeMap = new Map(before.files.map((file) => [file.path, file]));
  const afterMap = new Map(after.files.filter((file) => !isPrivate(file.path)).map((file) => [file.path, file]));
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((filePath) => beforeMap.get(filePath)?.sha256 !== afterMap.get(filePath)?.sha256).sort();
  const beforeBytes = new Map(before.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.bytes ?? new Uint8Array()]));
  const afterBytes = new Map(after.entries.filter((entry) => entry.kind === "file" && !isPrivate(entry.path)).map((entry) => [entry.path, entry.bytes ?? new Uint8Array()]));
  let changedLines = 0;
  for (const filePath of paths) {
    const decodeLines = (bytes: Uint8Array | undefined): readonly string[] => {
      if (bytes === undefined || bytes.byteLength === 0) return [];
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return lines;
    };
    let left: readonly string[];
    let right: readonly string[];
    try {
      left = decodeLines(beforeBytes.get(filePath));
      right = decodeLines(afterBytes.get(filePath));
    } catch {
      changedLines += Math.max(1, Math.ceil(Math.max(beforeMap.get(filePath)?.size ?? 0, afterMap.get(filePath)?.size ?? 0) / 80));
      continue;
    }
    if (left.length * right.length > 1_000_000) {
      changedLines += left.length + right.length;
      continue;
    }
    const previous = new Array<number>(right.length + 1).fill(0);
    for (const leftLine of left) {
      let diagonal = 0;
      for (let index = 1; index <= right.length; index += 1) {
        const above = previous[index] ?? 0;
        const candidate = leftLine === right[index - 1] ? diagonal + 1 : Math.max(previous[index - 1] ?? 0, above);
        diagonal = above;
        previous[index] = candidate;
      }
    }
    const common = previous[right.length] ?? 0;
    changedLines += left.length + right.length - 2 * common;
  }
  return Object.freeze({ paths: Object.freeze(paths), changedLines });
}

export class AttemptRunner {
  public constructor(
    private readonly reports: EvalReportStore,
    private readonly driver: EvalAgentDriver,
    private readonly grader: EvalHiddenGrader,
  ) {}

  public async run(input: {
    readonly evalRunId: string;
    readonly repetition: number;
    readonly task: LoadedEvalTaskAsset;
    readonly attemptRoot: string;
    readonly source: EvalExecutionSource;
    readonly guard: EvalTurnGuard;
    readonly model: string;
    readonly signal: AbortSignal;
  }): Promise<EvalAttemptReport> {
    const attemptStartedAt = Date.now();
    await mkdir(input.attemptRoot, { recursive: true });
    const prepared = await prepareNodeAttemptWorkspace(input.task.workspaceRoot, input.attemptRoot);
    if (prepared.initialManifest.sourceStateSha256 !== input.task.task.manifest.initial_workspace_sha256) {
      throw new EvalCoreError("eval_harness_invariant", "fresh attempt digest differs from loaded task", 1);
    }
    const workspaceId = `${input.task.task.manifest.id}-r${String(input.repetition)}`;
    const approval = new EvalApprovalPolicy(input.task.task.manifest, workspaceId);
    let driverResult: Awaited<ReturnType<EvalAgentDriver["run"]>> | undefined;
    let finalSha256: string | null = null;
    let observationSha256: string | null = null;
    let changedPaths: readonly string[] = [];
    let changedLines: number | null = null;
    let pathPolicyPassed = false;
    let gradersPassed = false;
    let harnessInvalid = false;
    let evidence: AttemptFailureEvidence;
    let timedOut = false;
    const driverController = new AbortController();
    const abortDriver = () => driverController.abort();
    input.signal.addEventListener("abort", abortDriver, { once: true });
    const durationTimer = setTimeout(() => {
      timedOut = true;
      driverController.abort();
    }, input.task.task.manifest.limits.agent_duration_ms);
    try {
      driverResult = await this.driver.run({ task: input.task, workspacePath: prepared.workspacePath, model: input.model, source: input.source, guard: input.guard, signal: driverController.signal, approvalPolicy: approval, disposableWorkspaceId: workspaceId });
      await verifyNodeAttemptGitBaseline(prepared.workspacePath, prepared.baselineGitHead);
      const finalManifest = await readAttemptWorkspaceManifest(prepared.workspacePath);
      finalSha256 = finalManifest.sourceStateSha256;
      const changed = await changedWorkspaceFacts(input.task.workspaceRoot, prepared.workspacePath);
      changedPaths = changed.paths;
      changedLines = changed.changedLines;
      const patchDecision = approval.decidePatch({ disposableWorkspaceId: workspaceId, paths: changed.paths, changedLines: changed.changedLines });
      pathPolicyPassed = patchDecision.decision === "approved";
      const projection = collectTerminalEvalObservations(true, driverResult.events);
      observationSha256 = projection.observationsSha256;
      const grade = await this.grader.grade(
        input.task,
        prepared.workspacePath,
        input.signal,
      );
      gradersPassed = grade.passed;
      evidence = { ...driverResult.evidence, ...(pathPolicyPassed ? {} : { permission: true }), secondaryCodes: [...(driverResult.evidence.secondaryCodes ?? []), ...grade.secondaryCodes, ...(pathPolicyPassed ? [] : ["changed_path_policy_failed"])] };
    } catch (error) {
      harnessInvalid = error instanceof EvalCoreError && error.exitCode === 1;
      evidence = harnessInvalid
        ? { harness: true, secondaryCodes: [error instanceof EvalCoreError ? error.code : "attempt_harness_error"] }
        : input.source.kind === "local_ollama"
          ? { provider: true, secondaryCodes: [timedOut ? "timeout" : "local_ollama_transport_error"] }
          : { harness: true, secondaryCodes: ["in_process_driver_invariant"] };
      harnessInvalid ||= input.source.kind === "in_process_test";
    } finally {
      clearTimeout(durationTimer);
      input.signal.removeEventListener("abort", abortDriver);
    }
    const classified = classifyAttempt({ agentCompleted: driverResult?.completed ?? false, pathPolicyPassed, gradersPassed, safetyViolation: false }, evidence);
    const report: EvalAttemptReport = Object.freeze({
      schemaVersion: 1,
      evalRunId: input.evalRunId,
      taskId: input.task.task.manifest.id,
      taskVersion: input.task.task.manifest.task_version,
      repetition: input.repetition,
      status: input.signal.aborted ? "cancelled" : harnessInvalid ? "harness_invalid" : "complete",
      validAttempt: classified.validAttempt,
      outcome: classified.outcome,
      primaryCategory: classified.primaryCategory,
      secondaryCodes: [...classified.secondaryCodes],
      taskManifestSha256: input.task.task.taskManifestSha256,
      scenarioSha256: input.task.task.scenario.scenarioSha256,
      scenarioConfigSha256: input.task.task.scenario.scenarioConfigSha256,
      serviceSetSha256: input.task.task.scenario.serviceSetSha256,
      initialWorkspaceSha256: prepared.initialManifest.sourceStateSha256,
      finalWorkspaceSha256: finalSha256,
      observationSha256,
      usage: driverResult?.usage ?? { completeness: "none" as const, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null },
      baselineGitHead: prepared.baselineGitHead,
      graderSha256: input.task.graderSha256,
      changedPaths: [...changedPaths],
      changedLines,
      durationMs: Math.max(0, Date.now() - attemptStartedAt),
      agentTerminal: driverResult?.terminal ?? null,
      executionSourceSha256: input.guard.sourceSha256,
      provider: input.source.provider,
      model: input.model,
      installedModelDigest: input.source.kind === "local_ollama" ? input.source.installedModelDigest : null,
      adapter: input.source.kind === "local_ollama" ? "ollama-direct-loopback-v1" : "in-process-eval-v1",
      noCostEvidence: input.guard.evidence,
      fullSuiteExecution: "not_run_by_policy",
    });
    await this.reports.writeAttempt(report);
    return report;
  }
}
