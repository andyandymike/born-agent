import { readFile } from "node:fs/promises";
import path from "node:path";

import { executeAgent } from "../commands/agent.js";
import { executeSessionsResume } from "../commands/sessions.js";
import type { CliIO } from "../cli/types.js";
import type { AttemptFailureEvidence } from "./attempt-classifier.js";
import type { PersistedEvalEvent } from "./attempt-observation-collector.js";
import { EvalAgentRuntime, evalAgentCommandOptions } from "./eval-agent-runtime.js";
import type { EvalApprovalPolicy } from "./eval-approval-policy.js";
import { EvalCoreError } from "./eval-errors.js";
import type { EvalTurnGuard, EvalExecutionSource } from "./eval-no-cost-policy.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";
import { collectEvalSessionEvidence } from "./eval-session-evidence.js";
import type { ReportedTokenUsage } from "./metrics-collector.js";

export interface EvalAgentDriverResult {
  readonly completed: boolean;
  readonly terminal: "completed" | "incomplete" | "failed" | "cancelled";
  readonly events: readonly PersistedEvalEvent[];
  readonly usage: ReportedTokenUsage;
  readonly evidence: AttemptFailureEvidence;
}

export interface EvalAgentDriverRequest {
  readonly task: LoadedEvalTaskAsset;
  readonly workspacePath: string;
  readonly model: string;
  readonly source: EvalExecutionSource;
  readonly guard: EvalTurnGuard;
  readonly signal: AbortSignal;
  readonly approvalPolicy: EvalApprovalPolicy;
  readonly disposableWorkspaceId: string;
}

export interface EvalAgentDriver {
  run(request: EvalAgentDriverRequest): Promise<EvalAgentDriverResult>;
}

function boundedMemoryIO(): CliIO & {
  readonly readStderr: () => string;
  readonly readStdout: () => string;
} {
  const maximum = 128 * 1024;
  let stderr = "";
  let stdout = "";
  const append = (current: string, value: string): string =>
    Buffer.byteLength(current, "utf8") >= maximum
      ? current
      : `${current}${value}`.slice(0, maximum);
  return {
    readStderr: () => stderr,
    readStdout: () => stdout,
    stderr: { write: (value) => void (stderr = append(stderr, value)) },
    stdout: { write: (value) => void (stdout = append(stdout, value)) },
  };
}

function mergeEvidence(
  observed: AttemptFailureEvidence,
  extra: AttemptFailureEvidence,
): AttemptFailureEvidence {
  return Object.freeze({
    ...(observed.completion || extra.completion ? { completion: true } : {}),
    ...(observed.context || extra.context ? { context: true } : {}),
    ...(observed.environment || extra.environment ? { environment: true } : {}),
    ...(observed.harness || extra.harness ? { harness: true } : {}),
    ...(observed.permission || extra.permission ? { permission: true } : {}),
    ...(observed.provider || extra.provider ? { provider: true } : {}),
    ...(observed.tool || extra.tool ? { tool: true } : {}),
    secondaryCodes: Object.freeze([
      ...new Set([
        ...(observed.secondaryCodes ?? []),
        ...(extra.secondaryCodes ?? []),
      ]),
    ]),
  });
}

function terminalForExit(
  exitCode: number,
): EvalAgentDriverResult["terminal"] {
  if (exitCode === 0) return "completed";
  if (exitCode === 130) return "cancelled";
  if (exitCode === 2 || exitCode === 7 || exitCode === 8) return "incomplete";
  return "failed";
}

async function runScenario(
  request: EvalAgentDriverRequest,
): Promise<EvalAgentDriverResult> {
  if (request.signal.aborted) {
    return Object.freeze({
      completed: false,
      evidence: Object.freeze({ secondaryCodes: ["cancelled"] }),
      events: Object.freeze([]),
      terminal: "cancelled",
      usage: Object.freeze({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        completeness: "none",
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      }),
    });
  }
  const runtime = new EvalAgentRuntime({
    approvalPolicy: request.approvalPolicy,
    disposableWorkspaceId: request.disposableWorkspaceId,
    guard: request.guard,
    model: request.model,
    signal: request.signal,
    source: request.source,
    task: request.task,
    workspacePath: request.workspacePath,
  });
  await runtime.configureScenarioServices();
  const io = boundedMemoryIO();
  const scenario = request.task.task.scenario.scenario;
  const steps =
    scenario.kind === "single_run"
      ? Object.freeze([{ id: "single", kind: "run" as const }])
      : scenario.steps;
  let lastExitCode = 1;
  let activeSessionId: string | undefined;
  let hookNotObserved = false;
  const secondaryCodes: string[] = [];

  for (const step of steps) {
    if (request.signal.aborted) {
      lastExitCode = 130;
      break;
    }
    if (step.kind === "run") {
      const fault = "fault" in step ? step.fault : undefined;
      runtime.fault.disarm();
      if (fault !== undefined) runtime.fault.arm(fault);
      lastExitCode = await executeAgent(
        evalAgentCommandOptions({
          model: request.model,
          prompt:
            "prompt" in step && step.prompt !== undefined
              ? step.prompt
              : request.task.task.manifest.prompt,
          source: request.source,
          task: request.task,
        }),
        runtime,
        io,
      );
      activeSessionId = runtime.sessionId;
      if (fault !== undefined) {
        const status = runtime.fault.finish();
        if (status !== "observed") {
          hookNotObserved = true;
          secondaryCodes.push(`fault_hook_not_observed:${fault.hook}`);
          break;
        }
        secondaryCodes.push(`fault_observed:${fault.hook}`);
      }
      continue;
    }
    runtime.fault.disarm();
    if (activeSessionId === undefined) {
      throw new EvalCoreError(
        "eval_harness_invariant",
        "scripted resume has no runtime-owned session",
        1,
      );
    }
    lastExitCode = await executeSessionsResume(
      {
        allowDegradedResume: true,
        message: undefined,
        sessionId: activeSessionId,
      },
      runtime,
      io,
    );
    if (lastExitCode === 2) secondaryCodes.push("scenario_resume_blocked");
  }

  const collected = await collectEvalSessionEvidence(
    runtime.sessionPaths,
    secondaryCodes,
  );
  const extraEvidence: AttemptFailureEvidence = Object.freeze({
    ...(hookNotObserved ? { tool: true } : {}),
    ...(lastExitCode === 2 ? { tool: true } : {}),
    ...(lastExitCode === 130 ? { secondaryCodes: ["cancelled"] } : {}),
  });
  const completed = !hookNotObserved && lastExitCode === 0;
  // PHASE14: scenario completion is derived from real Agent/session terminal
  // facts. A durable injected prefix is never upgraded to success merely
  // because the hidden grader later finds correct bytes.
  return Object.freeze({
    completed,
    evidence: mergeEvidence(collected.evidence, extraEvidence),
    events: collected.events,
    terminal: hookNotObserved ? "incomplete" : terminalForExit(lastExitCode),
    usage: collected.usage,
  });
}

export class InProcessEvalAgentDriver implements EvalAgentDriver {
  public async run(
    request: EvalAgentDriverRequest,
  ): Promise<EvalAgentDriverResult> {
    if (request.source.kind !== "in_process_test") {
      throw new EvalCoreError(
        "eval_agent_driver_invalid",
        "in-process driver received a non-test source",
        1,
      );
    }
    if (request.model === "harness-invalid-v1") {
      throw new EvalCoreError(
        "eval_harness_invariant",
        "deliberate in-process harness-invalid fixture",
        1,
      );
    }
    return runScenario(request);
  }
}

export class LocalOllamaEvalAgentDriver implements EvalAgentDriver {
  public async run(
    request: EvalAgentDriverRequest,
  ): Promise<EvalAgentDriverResult> {
    if (request.source.kind !== "local_ollama") {
      throw new EvalCoreError(
        "eval_agent_driver_invalid",
        "Ollama driver received the wrong source",
        1,
      );
    }
    return runScenario(request);
  }
}

export async function readPublicTaskHint(
  workspacePath: string,
): Promise<string | null> {
  return readFile(path.join(workspacePath, "TASK.md"), "utf8").catch(
    () => null,
  );
}
