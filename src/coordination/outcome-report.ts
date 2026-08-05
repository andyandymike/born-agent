import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { goalChangeAttributionScope } from "./goal-change-seed.js";
import {
  projectGoalChangeLedger,
  type GoalChangeLedgerProjection,
} from "./goal-change-ledger.js";
import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import type {
  ReconstructedMultiRunSession,
  ReconstructedRunProjection,
} from "../sessions/reconstruct-multi-run-session.js";
import type {
  PlanRevisionProjection,
  TaskStateProjection,
} from "./task-state-types.js";

type CompletionEvaluationEvent = Extract<
  DecodedRunEvent,
  { type: "completion.evaluated" }
>;
type CompletionEvidenceEvent = Extract<
  DecodedStoredEvent,
  { type: "completion.evidence" }
>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const boundedReason = z.string().min(1).max(128);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "path must be normalized and workspace-relative",
  );

const outcomeWithoutHashSchema = z
  .object({
    changeAttribution: z
      .object({
        baselineEventId: uuid,
        goalId: uuid,
        goalRevision: z.number().int().positive(),
        kind: z.literal("goal_revision"),
        ledgerSha256: sha256,
      })
      .strict()
      .nullable(),
    changes: z.array(
      z
        .object({
          changeKind: z.enum(["create", "modify"]),
          evidenceEventIds: z.array(uuid).min(1).max(512),
          path: relativePath,
          postimageSha256: sha256,
          preimageSha256: sha256.nullable(),
          sourceRunIds: z.array(uuid).min(1).max(256),
        })
        .strict(),
    ).max(256),
    evidenceEventIds: z.array(uuid).max(2048),
    goal: z
      .object({
        id: uuid,
        objective: z.string().min(1).max(32 * 1024),
        revision: z.number().int().positive(),
        status: z.enum(["active", "completed", "abandoned"]),
      })
      .strict()
      .nullable(),
    outcome: z.enum([
      "abandoned",
      "blocked",
      "cancelled",
      "completed",
      "failed",
      "idle",
      "incomplete",
    ]),
    outcomeReasons: z
      .array(boundedReason)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    plan: z
      .object({
        execution: z
          .object({
            blockedItemIds: z.array(z.string().min(1).max(100)).max(32),
            completedItems: z.number().int().nonnegative(),
            currentItemId: z.string().min(1).max(100).nullable(),
            id: uuid,
            revision: z.number().int().positive(),
            sha256,
            skippedItems: z.number().int().nonnegative(),
            status: z.enum(["active", "completed"]),
            totalItems: z.number().int().positive().max(32),
          })
          .strict()
          .nullable(),
        pendingDraft: z
          .object({
            id: uuid,
            revision: z.number().int().positive(),
            sha256,
            totalItems: z.number().int().positive().max(32),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    run: z
      .object({
        id: uuid,
        mode: z.enum(["plan", "build"]),
        modeSource: z.enum([
          "explicit_cli",
          "explicit_tui",
          "legacy_default",
          "tui_default",
        ]),
        model: z.string().min(1).max(500),
        policyProfileId: z.string().min(1).max(128).nullable(),
        provider: z.string().min(1).max(200),
        qualificationSha256: sha256.nullable(),
        status: z.enum([
          "budget_exceeded",
          "cancelled",
          "completed",
          "failed",
          "incomplete",
          "interrupted",
        ]),
      })
      .strict()
      .nullable(),
    schemaVersion: z.literal(1),
    sessionId: uuid,
    usage: z
      .object({
        billedCost: z.number().nonnegative().nullable(),
        estimatedCost: z.number().nonnegative().nullable(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    verification: z
      .object({
        evidenceEventId: uuid,
        generation: z.number().int().nonnegative(),
        scopeSha256: sha256,
        status: z.enum(["failed", "passed", "stale"]),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const outcomeReportSchema = outcomeWithoutHashSchema
  .extend({ reportSha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const { reportSha256: _reportSha256, ...withoutHash } = value;
    void _reportSha256;
    if (reportSha256(withoutHash) !== value.reportSha256) {
      context.addIssue({ code: "custom", message: "OutcomeReport hash does not match" });
    }
  });

export type OutcomeReport = Readonly<z.infer<typeof outcomeReportSchema>>;
type OutcomeWithoutHash = z.infer<typeof outcomeWithoutHashSchema>;

export type OutcomeReportErrorCode =
  | "outcome_attribution_mismatch"
  | "outcome_phase16_evidence_missing"
  | "outcome_projection_invalid";

export class OutcomeReportError extends Error {
  override readonly name = "OutcomeReportError";

  constructor(
    readonly code: OutcomeReportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const REASON_ORDER = Object.freeze([
  "unresolved_effect",
  "goal_change_recovery_required",
  "completion_recovery_required",
  "interrupted_run",
  "task_blocked",
  "budget_exceeded",
] as const);

function reportSha256(value: OutcomeWithoutHash): string {
  return sha256Canonical(outcomeWithoutHashSchema.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function orderedReasons(values: readonly string[]): readonly string[] {
  const order = new Map<string, number>(
    REASON_ORDER.map((reason, index) => [reason, index]),
  );
  return Object.freeze(
    [...new Set(values)]
      .sort(
        (left, right) =>
          (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right),
      )
      .slice(0, 16),
  );
}

function lastGoal(task: TaskStateProjection) {
  return task.goals.find((goal) => goal.content.goalId === task.activeGoalId) ??
    task.goals.at(-1) ??
    null;
}

function exactPlan(
  task: TaskStateProjection,
  reference: TaskStateProjection["currentApprovedPlan"],
): PlanRevisionProjection | null {
  if (reference === null) return null;
  return task.plans.find(
    (plan) =>
      plan.content.goalId === reference.goalId &&
      plan.content.goalRevision === reference.goalRevision &&
      plan.content.planId === reference.planId &&
      plan.content.revision === reference.revision &&
      plan.planSha256 === reference.planSha256,
  ) ?? null;
}

function planSummary(plan: PlanRevisionProjection | null) {
  if (plan === null || (plan.status !== "active" && plan.status !== "completed")) {
    return null;
  }
  return {
    blockedItemIds: plan.items
      .filter((item) => item.status === "blocked")
      .map((item) => item.content.id),
    completedItems: plan.items.filter((item) => item.status === "completed").length,
    currentItemId:
      plan.items.find((item) => item.status === "in_progress")?.content.id ?? null,
    id: plan.content.planId,
    revision: plan.content.revision,
    sha256: plan.planSha256,
    skippedItems: plan.items.filter((item) => item.status === "skipped").length,
    status: plan.status,
    totalItems: plan.items.length,
  } as const;
}

function selectedPlans(task: TaskStateProjection, goalId: string | undefined) {
  const pending = exactPlan(task, task.pendingDraft);
  let execution = exactPlan(task, task.currentApprovedPlan);
  if (execution === null && goalId !== undefined) {
    execution = [...task.plans]
      .reverse()
      .find(
        (plan) =>
          plan.content.goalId === goalId &&
          plan.status === "completed" &&
          plan.completed !== null,
      ) ?? null;
  }
  const executionSummary = planSummary(execution);
  const pendingSummary =
    pending === null || pending.status !== "draft"
      ? null
      : {
          id: pending.content.planId,
          revision: pending.content.revision,
          sha256: pending.planSha256,
          totalItems: pending.items.length,
        };
  return executionSummary === null && pendingSummary === null
    ? null
    : { execution: executionSummary, pendingDraft: pendingSummary };
}

function goalChanges(projection: GoalChangeLedgerProjection | null) {
  if (projection === null) {
    return { attribution: null, changes: Object.freeze([]) };
  }
  const paths = new Map<
    string,
    {
      changeKind: "create" | "modify";
      evidenceEventIds: string[];
      postimageSha256: string;
      preimageSha256: string | null;
      sourceRunIds: string[];
    }
  >();
  for (const record of projection.records) {
    for (const file of record.data.files) {
      const current = paths.get(file.path);
      if (current === undefined) {
        paths.set(file.path, {
          changeKind: file.kind,
          evidenceEventIds: [record.eventId],
          postimageSha256: file.postimage.sha256,
          preimageSha256: file.preimage?.sha256 ?? null,
          sourceRunIds: [record.sourceRunId],
        });
      } else {
        current.postimageSha256 = file.postimage.sha256;
        if (!current.evidenceEventIds.includes(record.eventId)) {
          current.evidenceEventIds.push(record.eventId);
        }
        if (!current.sourceRunIds.includes(record.sourceRunId)) {
          current.sourceRunIds.push(record.sourceRunId);
        }
      }
    }
  }
  const changes = [...paths.entries()]
    .filter(
      ([, value]) =>
        value.changeKind === "create" ||
        value.preimageSha256 !== value.postimageSha256,
    )
    .map(([path, value]) => ({ path, ...value }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    attribution: {
      baselineEventId: projection.baselineEventId,
      goalId: projection.goalId,
      goalRevision: projection.goalRevision,
      kind: "goal_revision" as const,
      ledgerSha256: projection.ledgerSha256,
    },
    changes: Object.freeze(changes),
  };
}

function latestCompletionEvaluation(
  run: ReconstructedRunProjection | null,
): CompletionEvaluationEvent | undefined {
  return run === null
    ? undefined
    : [...run.events]
        .reverse()
        .find(
          (event): event is CompletionEvaluationEvent =>
            event.type === "completion.evaluated" &&
            (event.data.effect === "accept" || event.data.effect === "incomplete"),
        );
}

function matchingCompletionEvidence(
  events: readonly DecodedStoredEvent[],
  evaluation: CompletionEvaluationEvent | undefined,
): CompletionEvidenceEvent | undefined {
  if (
    evaluation?.type !== "completion.evaluated" ||
    evaluation.data.evidence_sha256 === undefined
  ) {
    return undefined;
  }
  return events.find(
    (event): event is CompletionEvidenceEvent =>
      event.scope === "run" &&
      event.runId === evaluation.runId &&
      event.type === "completion.evidence" &&
      event.data.evidence_sha256 === evaluation.data.evidence_sha256,
  );
}

function assertAttribution(input: {
  readonly evidence: ReturnType<typeof matchingCompletionEvidence>;
  readonly evaluation: CompletionEvaluationEvent | undefined;
  readonly ledger: GoalChangeLedgerProjection | null;
  readonly run: ReconstructedRunProjection | null;
}): void {
  const isPhase16Build = input.run?.started.data.agent_mode === "build";
  if (input.evaluation === undefined || input.evidence === undefined) return;
  const scope = input.evidence.data.evidence.attributionScope;
  if (isPhase16Build && scope === undefined) {
    throw new OutcomeReportError(
      "outcome_phase16_evidence_missing",
      "Phase 16 Build completion evidence has no Goal attribution scope",
    );
  }
  if (scope === undefined) return;
  if (
    input.ledger === null ||
    sha256Canonical(scope) !==
      sha256Canonical(goalChangeAttributionScope(input.ledger))
  ) {
    throw new OutcomeReportError(
      "outcome_attribution_mismatch",
      "completion evidence does not match the final Goal change ledger",
    );
  }
}

function legacyChanges(
  evidence: ReturnType<typeof matchingCompletionEvidence>,
  runId: string | undefined,
) {
  if (evidence === undefined || runId === undefined) return Object.freeze([]);
  return Object.freeze(
    evidence.data.evidence.changedByRun
      .map((change) => ({
        changeKind: change.kind,
        evidenceEventIds: [evidence.eventId],
        path: change.path,
        postimageSha256: change.postimageSha256,
        preimageSha256: change.preimageSha256,
        sourceRunIds: [runId],
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function latestVerification(
  run: ReconstructedRunProjection | null,
  evaluation: CompletionEvaluationEvent | undefined,
) {
  if (run === null) return null;
  const ids =
    evaluation?.type === "completion.evaluated"
      ? new Set(evaluation.data.verification_ids)
      : null;
  const event = [...run.events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "verification.completed" &&
        (ids === null || ids.size === 0 || ids.has(candidate.data.verification_id)),
    );
  if (event?.type !== "verification.completed") return null;
  return {
    evidenceEventId: event.eventId,
    generation: event.data.completed_generation,
    scopeSha256: sha256Canonical({
      action_sha256: event.data.action_sha256,
      after_snapshot_sha256: event.data.after_snapshot_sha256,
      before_snapshot_sha256: event.data.before_snapshot_sha256,
      completed_generation: event.data.completed_generation,
      verification_id: event.data.verification_id,
    }),
    status:
      event.data.stale || event.data.status === "stale"
        ? ("stale" as const)
        : event.data.status === "passed"
          ? ("passed" as const)
          : ("failed" as const),
  };
}

function goalChangeGap(
  events: readonly DecodedStoredEvent[],
  ledger: GoalChangeLedgerProjection | null,
  goalId: string | undefined,
  goalRevision: number | undefined,
): boolean {
  if (goalId === undefined || goalRevision === undefined) return false;
  const recorded = new Set(
    ledger?.records.map((record) => record.data.source.event_id) ?? [],
  );
  const runBindings = new Map(
    events.flatMap((event) =>
      event.scope === "run" && event.type === "run.started"
        ? [[event.runId, event.data] as const]
        : [],
    ),
  );
  return events.some((event) => {
    if (recorded.has(event.eventId)) return false;
    if (event.scope === "run" && event.type === "patch.apply.completed") {
      const binding = runBindings.get(event.runId);
      return binding?.agent_mode === "build" &&
        binding.goal_id === goalId && binding.goal_revision === goalRevision;
    }
    if (
      event.scope === "session" &&
      event.type === "side_effect.reconciled" &&
      event.data.effect_kind === "patch" &&
      event.data.observed === "applied"
    ) {
      const binding = runBindings.get(event.data.source_run_id);
      return binding?.agent_mode === "build" &&
        binding.goal_id === goalId && binding.goal_revision === goalRevision;
    }
    return false;
  });
}

function hasUnresolvedEffect(
  run: ReconstructedRunProjection | null,
  sessionEvents: readonly DecodedStoredEvent[],
): boolean {
  if (run === null) return false;
  const reconciled = new Set(
    sessionEvents.flatMap((event) =>
      event.scope === "session" && event.type === "side_effect.reconciled"
        ? [`${event.data.source_run_id}\0${event.data.effect_id}`]
        : [],
    ),
  );
  const completedPatches = new Set(
    run.events.flatMap((event) =>
      event.type === "patch.apply.completed" ? [event.data.plan_id] : [],
    ),
  );
  const completedCommands = new Set(
    run.events.flatMap((event) =>
      event.type === "command.completed" ? [event.data.execution_id] : [],
    ),
  );
  return run.events.some((event) => {
    if (event.type === "patch.apply.started") {
      return !completedPatches.has(event.data.plan_id) &&
        !reconciled.has(`${run.runId}\0${event.data.plan_id}`);
    }
    if (
      event.type === "command.execution.requested" ||
      event.type === "command.started"
    ) {
      return !completedCommands.has(event.data.execution_id);
    }
    return event.type === "mcp.tool.call.effect_unknown" ||
      event.type === "mcp.server.start.effect_unknown";
  });
}

function completedChain(
  session: ReconstructedMultiRunSession,
  goalId: string,
  goalRevision: number,
): boolean {
  const goalEvent = session.events.find(
    (event) =>
      event.scope === "session" &&
      event.type === "goal.status.changed" &&
      event.data.to === "completed" &&
      event.data.goal_id === goalId &&
      event.data.revision === goalRevision,
  );
  if (goalEvent?.type !== "goal.status.changed" || goalEvent.data.to !== "completed") {
    return false;
  }
  const completionEventId = goalEvent.data.completion_evaluated_event_id;
  const finishTaskCallId = goalEvent.data.finish_task_call_id;
  const evaluation = session.events.find(
    (event) =>
      event.scope === "run" &&
      event.type === "completion.evaluated" &&
      event.eventId === completionEventId &&
      event.data.effect === "accept" &&
      event.data.call_id === finishTaskCallId,
  );
  if (evaluation?.type !== "completion.evaluated") return false;
  const result = session.events.find(
    (event) =>
      event.scope === "run" &&
      event.runId === evaluation.runId &&
      event.type === "tool.call.completed" &&
      event.data.call_id === evaluation.data.call_id &&
      event.data.status === "success" &&
      event.data.tool_name === "finish_task",
  );
  const terminal = session.events.find(
    (event) =>
      event.scope === "run" &&
      event.runId === evaluation.runId &&
      event.type === "run.completed" &&
      event.data.completion_mode === "verified_finish_task" &&
      event.data.evidence_sha256 === evaluation.data.evidence_sha256 &&
      event.data.report_sha256 === evaluation.data.report_sha256,
  );
  return result !== undefined && terminal !== undefined;
}

function classifyOutcome(input: {
  readonly completionCrash: boolean;
  readonly gap: boolean;
  readonly goal: ReturnType<typeof lastGoal>;
  readonly run: ReconstructedRunProjection | null;
  readonly session: ReconstructedMultiRunSession;
  readonly unresolved: boolean;
}): { readonly outcome: OutcomeReport["outcome"]; readonly reasons: readonly string[] } {
  if (input.unresolved || input.gap || input.completionCrash) {
    return {
      outcome: "blocked",
      reasons: orderedReasons([
        ...(input.unresolved ? ["unresolved_effect"] : []),
        ...(input.gap ? ["goal_change_recovery_required"] : []),
        ...(input.completionCrash ? ["completion_recovery_required"] : []),
      ]),
    };
  }
  if (input.run?.status === "interrupted") {
    return { outcome: "blocked", reasons: ["interrupted_run"] };
  }
  if (input.goal?.status === "completed") {
    return completedChain(
      input.session,
      input.goal.content.goalId,
      input.goal.content.revision,
    )
      ? { outcome: "completed", reasons: [] }
      : { outcome: "blocked", reasons: ["completion_recovery_required"] };
  }
  if (input.goal?.status === "abandoned") {
    return { outcome: "abandoned", reasons: [] };
  }
  if (input.run?.status === "failed") {
    return {
      outcome: "failed",
      reasons: orderedReasons([
        input.run.terminal?.type === "run.failed"
          ? input.run.terminal.data.code
          : "run_failed",
      ]),
    };
  }
  if (input.run?.status === "cancelled") {
    return { outcome: "cancelled", reasons: [] };
  }
  if (input.run?.status === "budget_exceeded") {
    return { outcome: "incomplete", reasons: ["budget_exceeded"] };
  }
  if (input.run?.status === "incomplete") {
    const reason =
      input.run.terminal?.type === "run.incomplete"
        ? input.run.terminal.data.reason
        : "run_incomplete";
    return {
      outcome: reason === "task_blocked" ? "blocked" : "incomplete",
      reasons: orderedReasons([reason]),
    };
  }
  return { outcome: "idle", reasons: [] };
}

function eventEvidenceIds(input: {
  readonly changeLedger: GoalChangeLedgerProjection | null;
  readonly evaluation: CompletionEvaluationEvent | undefined;
  readonly executionPlan: PlanRevisionProjection | null;
  readonly goal: ReturnType<typeof lastGoal>;
  readonly pendingPlan: PlanRevisionProjection | null;
  readonly run: ReconstructedRunProjection | null;
  readonly session: ReconstructedMultiRunSession;
  readonly verificationId: string | undefined;
}): readonly string[] {
  const ids = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value !== null && value !== undefined) ids.add(value);
  };
  add(input.goal?.createdEventId);
  add(input.goal?.lastStatusEventId);
  for (const plan of [input.executionPlan, input.pendingPlan]) {
    if (plan === null) continue;
    add(plan.createdEventId);
    add(plan.decisionEventId);
    add(plan.completed?.eventId);
    for (const item of plan.items) add(item.lastTransitionEventId);
  }
  add(input.changeLedger?.baselineEventId);
  for (const record of input.changeLedger?.records ?? []) add(record.eventId);
  add(input.run?.started.eventId);
  add(input.run?.terminal?.eventId);
  if (input.evaluation !== undefined) {
    const evaluation = input.evaluation;
    add(input.evaluation.eventId);
    add(
      input.session.events.find(
        (event) =>
          event.type === "completion.evidence" &&
          event.data.evidence_sha256 === evaluation.data.evidence_sha256,
      )?.eventId,
    );
    add(
      input.session.events.find(
        (event) =>
          event.type === "tool.call.completed" &&
          event.runId === evaluation.runId &&
          event.data.call_id === evaluation.data.call_id,
      )?.eventId,
    );
  }
  add(input.verificationId);
  const order = new Map(
    input.session.events.map((event) => [event.eventId, event.sessionSeq]),
  );
  return Object.freeze(
    [...ids].sort(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

export class OutcomeReportBuilder {
  build(session: ReconstructedMultiRunSession): OutcomeReport {
    try {
      const task = session.taskState;
      const goal = lastGoal(task);
      const latestRun = session.lastRun;
      // PHASE16: a newly-created idle Goal cannot inherit outcome facts from
      // the previous Goal or from an untracked legacy run.
      const run =
        goal === null
          ? latestRun
          : latestRun?.started.data.goal_id === goal.content.goalId &&
              latestRun.started.data.goal_revision === goal.content.revision
            ? latestRun
            : null;
      const ledger =
        goal === null
          ? null
          : projectGoalChangeLedger(
              session.events,
              goal.content.goalId,
              goal.content.revision,
            );
      const evaluation = latestCompletionEvaluation(run);
      const completionEvidence = matchingCompletionEvidence(
        session.events,
        evaluation,
      );
      assertAttribution({ evidence: completionEvidence, evaluation, ledger, run });
      const projectedChanges = goalChanges(ledger);
      const changes =
        task.trackingMode === "legacy_untracked"
          ? legacyChanges(completionEvidence, run?.runId)
          : projectedChanges.changes;
      const attribution =
        task.trackingMode === "legacy_untracked"
          ? null
          : projectedChanges.attribution;
      const executionPlan =
        exactPlan(task, task.currentApprovedPlan) ??
        (goal === null
          ? null
          : [...task.plans]
              .reverse()
              .find(
                (plan) =>
                  plan.content.goalId === goal.content.goalId &&
                  plan.status === "completed" &&
                  plan.completed !== null,
              ) ?? null);
      const pendingPlan = exactPlan(task, task.pendingDraft);
      const plan = selectedPlans(task, goal?.content.goalId);
      const verification = latestVerification(run, evaluation);
      const gap = goalChangeGap(
        session.events,
        ledger,
        goal?.content.goalId,
        goal?.content.revision,
      );
      const accepted =
        evaluation?.type === "completion.evaluated" &&
        evaluation.data.effect === "accept";
      const completionCrash =
        accepted &&
        (run?.status === "interrupted" ||
          goal?.status !== "completed" ||
          run?.terminal?.type !== "run.completed");
      const classified = classifyOutcome({
        completionCrash,
        gap,
        goal,
        run,
        session,
        unresolved: hasUnresolvedEffect(run, session.events),
      });
      const usageEvent = [...(run?.events ?? [])]
        .reverse()
        .find((event) => event.type === "usage");
      const isPhase16 = run?.started.data.agent_mode !== undefined;
      const policyProfileId = run?.started.data.runtime_policy?.profile_id ?? null;
      const qualificationSha256 =
        run?.started.data.model_qualification_sha256 ?? null;
      if (isPhase16 && (policyProfileId === null || qualificationSha256 === null)) {
        throw new OutcomeReportError(
          "outcome_phase16_evidence_missing",
          "Phase 16 run is missing policy or qualification evidence",
        );
      }
      const withoutHash = outcomeWithoutHashSchema.parse({
        changeAttribution: attribution,
        changes,
        evidenceEventIds: eventEvidenceIds({
          changeLedger: ledger,
          evaluation,
          executionPlan,
          goal,
          pendingPlan,
          run,
          session,
          verificationId: verification?.evidenceEventId,
        }),
        goal:
          goal === null
            ? null
            : {
                id: goal.content.goalId,
                objective: goal.content.objective,
                revision: goal.content.revision,
                status: goal.status,
              },
        outcome: classified.outcome,
        outcomeReasons: classified.reasons,
        plan,
        run:
          run === null
            ? null
            : {
                id: run.runId,
                mode: run.started.data.agent_mode ?? "build",
                modeSource:
                  run.started.data.agent_mode_source ?? "legacy_default",
                model: run.started.data.model,
                policyProfileId,
                provider: run.started.data.provider,
                qualificationSha256,
                status: run.status,
              },
        schemaVersion: 1,
        sessionId: session.sessionId,
        usage: {
          billedCost: null,
          estimatedCost: null,
          inputTokens:
            usageEvent?.type === "usage" ? usageEvent.data.input_tokens : null,
          outputTokens:
            usageEvent?.type === "usage" ? usageEvent.data.output_tokens : null,
        },
        verification,
      });
      return deepFreeze(
        outcomeReportSchema.parse({
          ...withoutHash,
          reportSha256: reportSha256(withoutHash),
        }),
      );
    } catch (error) {
      if (error instanceof OutcomeReportError) throw error;
      throw new OutcomeReportError(
        "outcome_projection_invalid",
        error instanceof Error ? error.message : "OutcomeReport projection failed",
      );
    }
  }
}
