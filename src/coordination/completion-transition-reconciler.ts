import { createHash } from "node:crypto";

import { ArtifactSessionRuntime } from "../artifacts/artifact-session-runtime.js";
import {
  isLegacyModelUsageData,
  isPhase8ModelUsageData,
  type RunEvent,
} from "../events/run-event.js";
import { runEventSchema } from "../events/run-event-schema.js";
import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
  type Phase16RunBinding,
} from "../events/phase16-run-event-extension.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import {
  assertGoalChangeWorkspaceMatches,
  projectGoalChangeLedger,
} from "./goal-change-ledger.js";
import { VerifiedGoalChangeSeed } from "./goal-change-seed.js";
import { TaskStateMachine } from "./task-state-machine.js";

export type CompletionTransitionRecoveryCode =
  | "completion_recovery_ambiguous"
  | "completion_recovery_binding_mismatch"
  | "completion_recovery_evidence_invalid"
  | "completion_recovery_state_invalid";

export class CompletionTransitionRecoveryError extends Error {
  override readonly name = "CompletionTransitionRecoveryError";

  constructor(
    readonly code: CompletionTransitionRecoveryCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CompletionTransitionRecoveryResult {
  readonly appendedEventTypes: readonly string[];
  readonly evidenceSha256?: string;
  readonly reportSha256?: string;
  readonly runId?: string;
  readonly status: "completed" | "none";
}

export interface CompletionTransitionReconcilerOptions {
  readonly randomUUID: () => string;
  readonly timestamp: () => string;
  readonly workspace: string;
  readonly writer: V2SessionWriter;
}

function fail(
  code: CompletionTransitionRecoveryCode,
  message: string,
): never {
  throw new CompletionTransitionRecoveryError(code, message);
}

function bindingFromRunStart(event: DecodedRunEvent): Phase16RunBinding | null {
  if (event.type !== "run.started") return null;
  const candidate = Object.fromEntries(
    PHASE16_RUN_BINDING_KEYS.flatMap((key) =>
      Object.hasOwn(event.data, key) ? [[key, event.data[key]]] : [],
    ),
  );
  if (Object.keys(candidate).length === 0) return null;
  const parsed = phase16RunBindingSchema.safeParse(candidate);
  if (!parsed.success) {
    fail(
      "completion_recovery_binding_mismatch",
      "completion recovery run has an invalid Phase 16 binding",
    );
  }
  return parsed.data;
}

function exactAcceptedObservation(input: {
  readonly evidenceSha256: string;
  readonly reportSha256: string;
}): string {
  return JSON.stringify({
    effect: "accept",
    evidence_sha256: input.evidenceSha256,
    report_sha256: input.reportSha256,
    ok: true,
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aggregateUsage(events: readonly DecodedRunEvent[]) {
  const usages = events.filter(
    (event): event is Extract<DecodedRunEvent, { type: "model.usage" }> =>
      event.type === "model.usage",
  );
  const steps = events.filter((event) => event.type === "agent.step.started");
  if (usages.length === 0 || usages.length !== steps.length) {
    fail(
      "completion_recovery_evidence_invalid",
      "accepted completion does not have complete per-step usage evidence",
    );
  }
  if (
    usages.some(
      (event) =>
        "completeness" in event.data && event.data.completeness !== "complete",
    )
  ) {
    fail(
      "completion_recovery_evidence_invalid",
      "accepted completion contains partial provider usage",
    );
  }
  const known = usages.map((event) => event.data);
  const legacyCached = known
    .filter(isLegacyModelUsageData)
    .map((usage) => usage.cached_input_tokens)
    .filter((value): value is number => value !== undefined);
  const phase8Cached = known
    .filter(isPhase8ModelUsageData)
    .map((usage) => usage.cache_read_tokens);
  const cached =
    phase8Cached.length > 0
      ? phase8Cached.every((value) => value !== null)
        ? phase8Cached.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : undefined
      : legacyCached.length === 0
        ? undefined
        : legacyCached.reduce((sum, value) => sum + value, 0);
  return {
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    input_tokens: known.reduce(
      (sum, usage) => sum + (usage.input_tokens ?? 0),
      0,
    ),
    model_turns: known.length,
    output_tokens: known.reduce(
      (sum, usage) => sum + (usage.output_tokens ?? 0),
      0,
    ),
    total_tokens: known.reduce(
      (sum, usage) => sum + (usage.total_tokens ?? 0),
      0,
    ),
  };
}

function elapsedMs(
  started: DecodedRunEvent,
  events: readonly DecodedStoredEvent[],
): number {
  const start = Date.parse(started.timestamp);
  const end = Date.parse(events.at(-1)?.timestamp ?? started.timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(end - start));
}

export class CompletionTransitionReconciler {
  constructor(private readonly options: CompletionTransitionReconcilerOptions) {}

  async reconcile(): Promise<CompletionTransitionRecoveryResult> {
    let session = reconstructMultiRunSession(this.options.writer.events);
    const run = session.lastRun;
    if (run === null || run.status !== "interrupted") {
      return { appendedEventTypes: Object.freeze([]), status: "none" };
    }
    const binding = bindingFromRunStart(run.started);
    if (binding?.agent_mode !== "build") {
      return { appendedEventTypes: Object.freeze([]), status: "none" };
    }
    const accepted = run.events.filter(
      (
        event,
      ): event is Extract<DecodedRunEvent, { type: "completion.evaluated" }> =>
        event.type === "completion.evaluated" && event.data.effect === "accept",
    );
    if (accepted.length === 0) {
      return { appendedEventTypes: Object.freeze([]), status: "none" };
    }
    if (accepted.length !== 1) {
      fail(
        "completion_recovery_ambiguous",
        "interrupted Build run has more than one accepted completion",
      );
    }
    const evaluation = accepted[0]!;
    if (
      evaluation.data.evidence_sha256 === undefined ||
      evaluation.data.report_sha256 === undefined
    ) {
      fail(
        "completion_recovery_evidence_invalid",
        "accepted completion is missing its evidence or report identity",
      );
    }
    const evidenceSha256 = evaluation.data.evidence_sha256;
    const reportSha256 = evaluation.data.report_sha256;
    const callId = evaluation.data.call_id;
    const requested = run.events.find(
      (event) =>
        event.type === "tool.call.requested" && event.data.call_id === callId,
    );
    const candidate = run.events.find(
      (event) =>
        event.type === "completion.candidate" && event.data.call_id === callId,
    );
    if (
      requested?.type !== "tool.call.requested" ||
      requested.data.tool_name !== "finish_task" ||
      candidate?.type !== "completion.candidate" ||
      candidate.data.candidate_sha256 !== evaluation.data.candidate_sha256
    ) {
      fail(
        "completion_recovery_evidence_invalid",
        "accepted completion does not bind one exact finish_task request",
      );
    }

    const goalChanges = projectGoalChangeLedger(
      this.options.writer.events,
      binding.goal_id,
      binding.goal_revision,
    );
    if (goalChanges === null) {
      fail(
        "completion_recovery_binding_mismatch",
        "accepted Build completion has no Goal execution baseline",
      );
    }
    await assertGoalChangeWorkspaceMatches(goalChanges, this.options.workspace);
    const artifacts = await ArtifactSessionRuntime.create({
      events: this.options.writer.events,
      eventAppender: {
        appendArtifactEvent: (runId, event) =>
          this.options.writer.appendArtifactEvent(runId, event),
      },
      runId: run.runId,
      sessionId: session.sessionId,
      workspace: this.options.workspace,
    });
    await VerifiedGoalChangeSeed.hydrateAndVerify({
      artifactStore: artifacts.store,
      projection: goalChanges,
    });

    const appended: string[] = [];
    const expectedObservation = exactAcceptedObservation({
      evidenceSha256,
      reportSha256,
    });
    let toolResult = run.events.find(
      (event) =>
        event.type === "tool.call.completed" && event.data.call_id === callId,
    );
    if (toolResult === undefined) {
      const expectedArtifactSha256 = sha256Text(expectedObservation);
      const hasExactArtifact = this.options.writer.events.some(
        (event) =>
          event.scope === "run" &&
          event.runId === run.runId &&
          event.type === "artifact.stored" &&
          event.data.origin_event_id === requested.eventId &&
          event.data.capture_status === "complete" &&
          !event.data.capture_truncated &&
          event.data.sha256 === expectedArtifactSha256 &&
          event.data.bytes === Buffer.byteLength(expectedObservation, "utf8"),
      );
      let observation = expectedObservation;
      if (!hasExactArtifact) {
        const materialized = await artifacts.materialize({
          modelObservationBytes: Buffer.byteLength(expectedObservation, "utf8"),
          originEventId: requested.eventId,
          source: [Buffer.from(expectedObservation, "utf8")],
        });
        if (
          materialized.modelObservation !== expectedObservation ||
          materialized.modelObservationTruncated
        ) {
          fail(
            "completion_recovery_evidence_invalid",
            "finish_task recovery observation could not be preserved exactly",
          );
        }
        observation = materialized.modelObservation;
        appended.push(
          materialized.artifactEvent === null
            ? "artifact.capture.truncated"
            : "artifact.stored",
        );
      }
      await this.appendRunEvent(run.runId, "tool.call.completed", {
        call_id: callId,
        duration_ms: 0,
        output: observation,
        status: "success",
        step: evaluation.data.step,
        tool_name: "finish_task",
        truncated: false,
      });
      appended.push("tool.call.completed");
      session = reconstructMultiRunSession(this.options.writer.events);
      toolResult = session.lastRun?.events.find(
        (event) =>
          event.type === "tool.call.completed" && event.data.call_id === callId,
      );
    }
    if (
      toolResult?.type !== "tool.call.completed" ||
      toolResult.data.status !== "success" ||
      toolResult.data.tool_name !== "finish_task" ||
      toolResult.data.step !== evaluation.data.step ||
      toolResult.data.output !== expectedObservation ||
      toolResult.data.truncated
    ) {
      fail(
        "completion_recovery_evidence_invalid",
        "finish_task result does not exactly match the accepted completion",
      );
    }

    const currentRun = session.lastRun;
    if (currentRun === null || currentRun.runId !== run.runId) {
      fail(
        "completion_recovery_state_invalid",
        "completion recovery changed the active run identity",
      );
    }
    const usageEvents = currentRun.events.filter((event) => event.type === "usage");
    if (usageEvents.length > 1) {
      fail(
        "completion_recovery_evidence_invalid",
        "accepted completion has duplicate aggregate usage",
      );
    }
    if (usageEvents.length === 0) {
      await this.appendRunEvent(run.runId, "usage", aggregateUsage(currentRun.events));
      appended.push("usage");
    }

    let task = TaskStateMachine.project(this.options.writer.events);
    if (binding.plan_id !== null) {
      const completed = this.options.writer.events.find(
        (
          event,
        ): event is Extract<
          DecodedStoredEvent,
          { scope: "session"; type: "plan.completed" }
        > =>
          event.scope === "session" &&
          event.type === "plan.completed" &&
          event.data.goal_id === binding.goal_id &&
          event.data.goal_revision === binding.goal_revision &&
          event.data.plan_id === binding.plan_id &&
          event.data.revision === binding.plan_revision &&
          event.data.plan_sha256 === binding.plan_sha256,
      );
      if (completed === undefined) {
        const plan = task.plans.find(
          (entry) =>
            entry.content.goalId === binding.goal_id &&
            entry.content.goalRevision === binding.goal_revision &&
            entry.content.planId === binding.plan_id &&
            entry.content.revision === binding.plan_revision &&
            entry.planSha256 === binding.plan_sha256,
        );
        if (
          plan?.status !== "active" ||
          task.currentApprovedPlan?.planId !== binding.plan_id ||
          !task.readyForCompletion
        ) {
          fail(
            "completion_recovery_state_invalid",
            "accepted completion Plan is no longer exact and ready",
          );
        }
        await this.options.writer.appendTaskEvent("plan.completed", {
          completion_evaluated_event_id: evaluation.eventId,
          finish_task_call_id: callId,
          goal_id: binding.goal_id,
          goal_revision: binding.goal_revision,
          origin: { kind: "host_completion" },
          plan_id: binding.plan_id,
          plan_sha256: binding.plan_sha256!,
          revision: binding.plan_revision!,
        });
        appended.push("plan.completed");
        task = TaskStateMachine.project(this.options.writer.events);
      } else if (
        completed.data.completion_evaluated_event_id !== evaluation.eventId ||
        completed.data.finish_task_call_id !== callId
      ) {
        fail(
          "completion_recovery_state_invalid",
          "completed Plan does not match the accepted finish_task identity",
        );
      }
    } else if (task.currentApprovedPlan !== null || task.pendingDraft !== null) {
      fail(
        "completion_recovery_binding_mismatch",
        "direct Build completion acquired an unbound Plan",
      );
    }

    const goalCompleted = this.options.writer.events.find(
      (
        event,
      ): event is Extract<
        DecodedStoredEvent,
        { scope: "session"; type: "goal.status.changed" }
      > & {
        readonly data: Extract<
          Extract<
            DecodedStoredEvent,
            { scope: "session"; type: "goal.status.changed" }
          >["data"],
          { to: "completed" }
        >;
      } =>
        event.scope === "session" &&
        event.type === "goal.status.changed" &&
        event.data.to === "completed" &&
        event.data.goal_id === binding.goal_id &&
        event.data.revision === binding.goal_revision,
    );
    if (goalCompleted === undefined) {
      const goal = task.goals.find(
        (entry) =>
          entry.content.goalId === binding.goal_id &&
          entry.content.revision === binding.goal_revision,
      );
      if (goal?.status !== "active") {
        fail(
          "completion_recovery_state_invalid",
          "accepted completion Goal is no longer active",
        );
      }
      await this.options.writer.appendTaskEvent("goal.status.changed", {
        completion_evaluated_event_id: evaluation.eventId,
        finish_task_call_id: callId,
        from: "active",
        goal_id: binding.goal_id,
        origin: { kind: "host_completion" },
        revision: binding.goal_revision,
        to: "completed",
      });
      appended.push("goal.status.changed");
    } else if (
      goalCompleted.data.completion_evaluated_event_id !== evaluation.eventId ||
      goalCompleted.data.finish_task_call_id !== callId
    ) {
      fail(
        "completion_recovery_state_invalid",
        "completed Goal does not match the accepted finish_task identity",
      );
    }

    session = reconstructMultiRunSession(this.options.writer.events);
    const terminalRun = session.lastRun;
    if (terminalRun === null || terminalRun.runId !== run.runId) {
      fail(
        "completion_recovery_state_invalid",
        "completion recovery lost the interrupted run",
      );
    }
    if (terminalRun.terminal === undefined) {
      const textEvents = terminalRun.events.filter(
        (event): event is Extract<DecodedRunEvent, { type: "text.delta" }> =>
          event.type === "text.delta",
      );
      await this.appendRunEvent(run.runId, "run.completed", {
        completion_mode: "verified_finish_task",
        duration_ms: elapsedMs(run.started, this.options.writer.events),
        evidence_sha256: evidenceSha256,
        model_turns: terminalRun.events.filter(
          (event) => event.type === "model.usage",
        ).length,
        output_chars: textEvents.reduce(
          (sum, event) => sum + event.data.delta.length,
          0,
        ),
        report_sha256: reportSha256,
        steps: terminalRun.events.filter(
          (event) => event.type === "agent.step.started",
        ).length,
        tool_calls: terminalRun.events.filter(
          (event) => event.type === "tool.call.completed",
        ).length,
      });
      appended.push("run.completed");
    }

    const recovered = reconstructMultiRunSession(this.options.writer.events);
    const goal = recovered.taskState.goals.find(
      (entry) =>
        entry.content.goalId === binding.goal_id &&
        entry.content.revision === binding.goal_revision,
    );
    if (recovered.status !== "completed" || goal?.status !== "completed") {
      fail(
        "completion_recovery_state_invalid",
        "completion recovery did not reach one exact completed state",
      );
    }
    return {
      appendedEventTypes: Object.freeze(appended),
      evidenceSha256,
      reportSha256,
      runId: run.runId,
      status: "completed",
    };
  }

  private async appendRunEvent(
    runId: string,
    type: "run.completed" | "tool.call.completed" | "usage",
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const runEvents = this.options.writer.events.filter(
      (event) => event.scope === "run" && event.runId === runId,
    );
    const event = runEventSchema.parse({
      data,
      event_id: this.options.randomUUID(),
      run_id: runId,
      schema_version: 1,
      seq: runEvents.length + 1,
      session_id: this.options.writer.events[0]?.sessionId,
      timestamp: this.options.timestamp(),
      type,
    }) as RunEvent;
    const decoded = {
      data: event.data,
      eventId: event.event_id,
      runId,
      runSeq: runEvents.length + 1,
      scope: "run",
      sessionId: event.session_id,
      sessionSeq: this.options.writer.events.length + 1,
      sourceSchemaVersion: 2,
      timestamp: event.timestamp,
      type: event.type,
    } as DecodedStoredEvent;
    reconstructMultiRunSession([...this.options.writer.events, decoded]);
    await this.options.writer.write(event);
  }
}
