import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDirectLoopbackFetch } from "../security/direct-loopback-fetch.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";
import type { EvalTurnGuard, EvalExecutionSource } from "./eval-no-cost-policy.js";
import type { AttemptFailureEvidence } from "./attempt-classifier.js";
import type { PersistedEvalEvent } from "./attempt-observation-collector.js";
import type { ReportedTokenUsage } from "./metrics-collector.js";
import { EvalCoreError } from "./eval-errors.js";
import { EvalFaultController } from "./eval-fault-controller.js";
import type { EvalApprovalPolicy, EvalApprovalDecision } from "./eval-approval-policy.js";

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

const NO_USAGE: ReportedTokenUsage = Object.freeze({
  completeness: "none", inputTokens: null, outputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, reasoningTokens: null, totalTokens: null,
});

function terminalEvents(taskId: string, terminalKind: string): readonly PersistedEvalEvent[] {
  return Object.freeze([
    Object.freeze({ sequence: 1, durable: true, type: "run_started", fields: Object.freeze({ runId: taskId, stepId: "run" }) }),
    Object.freeze({ sequence: 2, durable: true, type: "run_terminal", fields: Object.freeze({ runId: taskId, stepId: "run", terminalKind }) }),
  ]);
}

function scriptedFixtureEvents(task: LoadedEvalTaskAsset, terminalKind: string): readonly PersistedEvalEvent[] {
  const scenario = task.task.scenario.scenario;
  if (scenario.kind === "single_run") return terminalEvents(task.task.manifest.id, terminalKind);
  const events: PersistedEvalEvent[] = [];
  let sequence = 1;
  for (const step of scenario.steps) {
    if (step.kind === "run") {
      events.push(Object.freeze({ sequence: sequence++, durable: true, type: "run_started", fields: Object.freeze({ runId: step.id, stepId: step.id }) }));
      if (step.fault !== undefined) {
        const controller = EvalFaultController.createForAttemptHarness({ runId: step.id, hook: step.fault.hook, action: step.fault.action });
        if (controller.observe({ runId: step.id, hook: step.fault.hook, persisted: true, synced: true }) !== "terminate_now" || controller.finishRun() !== "observed") {
          throw new EvalCoreError("eval_harness_invariant", "scripted fake fault did not terminate at its durable boundary", 1);
        }
        events.push(Object.freeze({ sequence: sequence++, durable: true, type: "run_terminal", fields: Object.freeze({ runId: step.id, stepId: step.id, terminalKind: "terminated_once", reasonCode: step.fault.hook }) }));
      } else {
        events.push(Object.freeze({ sequence: sequence++, durable: true, type: "run_terminal", fields: Object.freeze({ runId: step.id, stepId: step.id, terminalKind }) }));
      }
    } else {
      events.push(Object.freeze({ sequence: sequence++, durable: true, type: "resume_adopted", fields: Object.freeze({ runId: step.id, stepId: step.id, adoptedRunId: step.from, recoveryStatus: "adopted" }) }));
      events.push(Object.freeze({ sequence: sequence++, durable: true, type: "run_terminal", fields: Object.freeze({ runId: step.id, stepId: step.id, terminalKind }) }));
    }
  }
  return Object.freeze(events);
}

function withPatchApproval(
  events: readonly PersistedEvalEvent[],
  taskId: string,
  decision: EvalApprovalDecision,
): readonly PersistedEvalEvent[] {
  const projected = events.map((event) => ({ ...event, fields: { ...event.fields } }));
  const insertionIndex = Math.max(1, projected.length - 1);
  projected.splice(insertionIndex, 0, {
    sequence: 0,
    durable: true,
    type: "approval_decided",
    fields: {
      runId: taskId,
      stepId: "eval-patch",
      callId: "eval-patch-1",
      decision: decision.decision,
      decisionSource: decision.decisionSource,
      reasonCode: decision.reasonCode,
    },
  });
  return Object.freeze(projected.map((event, index) => Object.freeze({ ...event, sequence: index + 1, fields: Object.freeze(event.fields) })));
}

export class InProcessEvalAgentDriver implements EvalAgentDriver {
  public async run(request: EvalAgentDriverRequest): Promise<EvalAgentDriverResult> {
    if (request.source.kind !== "in_process_test") {
      throw new EvalCoreError("eval_agent_driver_invalid", "in-process driver received a non-test source", 1);
    }
    request.guard.assertBeforeModelTurn(request.source);
    if (request.signal.aborted) return Object.freeze({ completed: false, terminal: "cancelled", events: terminalEvents(request.task.task.manifest.id, "cancelled"), usage: NO_USAGE, evidence: Object.freeze({ secondaryCodes: ["cancelled"] }) });
    if (request.model === "harness-invalid-v1") {
      throw new EvalCoreError("eval_harness_invariant", "deliberate in-process harness-invalid fixture", 1);
    }
    const expected = `PASS:${request.task.task.manifest.id}\n`;
    const content = request.model === "false-complete-v1" ? "WRONG\n" : expected;
    const approval = request.approvalPolicy.decidePatch({ disposableWorkspaceId: request.disposableWorkspaceId, paths: ["answer.txt"], changedLines: 1 });
    if (approval.decision === "denied") {
      return Object.freeze({ completed: false, terminal: "incomplete", events: withPatchApproval(terminalEvents(request.task.task.manifest.id, "incomplete"), request.task.task.manifest.id, approval), usage: NO_USAGE, evidence: Object.freeze({ permission: true, secondaryCodes: [approval.reasonCode] }) });
    }
    await writeFile(path.join(request.workspacePath, "answer.txt"), content, "utf8");
    const completed = request.model !== "solved-incomplete-v1";
    return Object.freeze({
      completed,
      terminal: completed ? "completed" : "incomplete",
      events: withPatchApproval(scriptedFixtureEvents(request.task, completed ? "completed" : "incomplete"), request.task.task.manifest.id, approval),
      usage: NO_USAGE,
      evidence: Object.freeze(completed ? {} : { completion: true, secondaryCodes: ["fixture_incomplete"] }),
    });
  }
}

type Fetch = typeof globalThis.fetch;

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1]?.trim();
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate) as unknown;
}

export class LocalOllamaEvalAgentDriver implements EvalAgentDriver {
  public constructor(private readonly fetcherFactory: (baseURL: string) => Fetch = (baseURL) => createDirectLoopbackFetch({ allowedMethods: ["POST"], baseURL, path: { exact: "/api/chat" } })) {}

  public async run(request: EvalAgentDriverRequest): Promise<EvalAgentDriverResult> {
    if (request.source.kind !== "local_ollama") throw new EvalCoreError("eval_agent_driver_invalid", "Ollama driver received the wrong source", 1);
    request.guard.assertBeforeModelTurn(request.source);
    // PHASE14: every local turn revalidates the frozen literal-loopback source and uses a direct no-proxy, no-redirect, no-fallback transport with no credentials.
    const response = await this.fetcherFactory(request.source.endpoint)(`${request.source.endpoint}/api/chat`, {
      method: "POST",
      redirect: "error",
      signal: request.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: request.source.installedModelTag,
        stream: false,
        messages: [{ role: "system", content: "Return only JSON: {\"path\":\"answer.txt\",\"content\":\"...\"}. Never use another path." }, { role: "user", content: request.task.task.manifest.prompt }],
        options: { temperature: 0, seed: 1 },
      }),
    });
    if (!response.ok) return Object.freeze({ completed: false, terminal: "failed", events: terminalEvents(request.task.task.manifest.id, "failed"), usage: NO_USAGE, evidence: Object.freeze({ provider: true, secondaryCodes: ["local_ollama_http_error"] }) });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new EvalCoreError("eval_agent_driver_invalid", "Ollama response exceeds bounded eval limit", 1);
    let decoded: unknown;
    try { decoded = JSON.parse(text) as unknown; } catch { decoded = null; }
    const record = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
    const message = typeof record.message === "object" && record.message !== null ? record.message as Record<string, unknown> : {};
    const content = typeof message.content === "string" ? message.content : "";
    try {
      const patch = extractJsonObject(content) as { path?: unknown; content?: unknown };
      if (patch.path !== "answer.txt" || typeof patch.content !== "string" || Buffer.byteLength(patch.content, "utf8") > 65_536) throw new Error("invalid patch");
      const approval = request.approvalPolicy.decidePatch({ disposableWorkspaceId: request.disposableWorkspaceId, paths: [patch.path], changedLines: Math.max(1, patch.content.split("\n").length - 1) });
      if (approval.decision === "denied") {
        return Object.freeze({ completed: false, terminal: "incomplete", events: withPatchApproval(terminalEvents(request.task.task.manifest.id, "incomplete"), request.task.task.manifest.id, approval), usage: NO_USAGE, evidence: Object.freeze({ permission: true, secondaryCodes: [approval.reasonCode] }) });
      }
      await writeFile(path.join(request.workspacePath, "answer.txt"), patch.content, "utf8");
    } catch {
      return Object.freeze({ completed: false, terminal: "incomplete", events: terminalEvents(request.task.task.manifest.id, "incomplete"), usage: NO_USAGE, evidence: Object.freeze({ secondaryCodes: ["model_patch_protocol_invalid"] }) });
    }
    const promptTokens = typeof record.prompt_eval_count === "number" && Number.isSafeInteger(record.prompt_eval_count) && record.prompt_eval_count >= 0 ? record.prompt_eval_count : null;
    const outputTokens = typeof record.eval_count === "number" && Number.isSafeInteger(record.eval_count) && record.eval_count >= 0 ? record.eval_count : null;
    const usage: ReportedTokenUsage = Object.freeze({ completeness: promptTokens === null || outputTokens === null ? "partial" : "complete", inputTokens: promptTokens, outputTokens, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: promptTokens === null || outputTokens === null ? null : promptTokens + outputTokens });
    const approval = request.approvalPolicy.decidePatch({ disposableWorkspaceId: request.disposableWorkspaceId, paths: ["answer.txt"], changedLines: 1 });
    return Object.freeze({ completed: true, terminal: "completed", events: withPatchApproval(terminalEvents(request.task.task.manifest.id, "completed"), request.task.task.manifest.id, approval), usage, evidence: Object.freeze({}) });
  }
}

export async function readPublicTaskHint(workspacePath: string): Promise<string | null> {
  return readFile(path.join(workspacePath, "TASK.md"), "utf8").catch(() => null);
}
