import { canonicalJson } from "../completion/canonical-json.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  taskMutationBlocker,
} from "../coordination/task-control-plane.js";
import { isDomainHarnessRuntime } from "../coordination/domain-harness.js";
import type {
  PlanRevisionProjection,
  PlanRevisionRef,
} from "../coordination/task-state-types.js";
import { PlanFileLoader } from "../plans/plan-file-loader.js";
import {
  PlanStore,
  type PlanBaseIdentity,
} from "../plans/plan-store.js";
import { sha256Schema } from "../plans/plan-schema.js";
import { SessionCatalog } from "../sessions/session-catalog.js";
import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import {
  positiveRevision,
  renderTaskCommandFailure,
  taskMutationContext,
  taskWriterFactory,
} from "./task-control-plane-command.js";
import { executeTaskActionThroughApplicationService } from "../control-plane/adapters/task-cli-adapter.js";
import { querySessionViewThroughApplicationService } from "../control-plane/adapters/task-cli-adapter.js";
import { queryPlanReviewThroughApplicationService } from "../control-plane/adapters/task-surface-cli-query-adapter.js";

export interface PlanShowOptions {
  readonly history: boolean;
  readonly json: boolean;
  readonly sessionId: string;
}

export interface PlanReplaceOptions {
  readonly basePlanId?: string;
  readonly baseRevision?: string;
  readonly baseSha256?: string;
  readonly file: string;
  readonly goalId: string;
  readonly goalRevision: string;
  readonly sessionId: string;
}

interface PlanDecisionOptions {
  readonly goalId: string;
  readonly goalRevision: string;
  readonly planId: string;
  readonly revision: string;
  readonly sessionId: string;
  readonly sha256: string;
}

export type PlanApproveOptions = PlanDecisionOptions;
export interface PlanRejectOptions extends PlanDecisionOptions {
  readonly reason: string;
}

function refDocument(ref: PlanRevisionRef | null) {
  return ref === null
    ? null
    : {
        goalId: ref.goalId,
        goalRevision: ref.goalRevision,
        planId: ref.planId,
        planSha256: ref.planSha256,
        revision: ref.revision,
      };
}

function planDocument(plan: PlanRevisionProjection) {
  return {
    completed: plan.completed,
    content: plan.content,
    createdEventId: plan.createdEventId,
    decisionEventId: plan.decisionEventId,
    items: plan.items.map((item) => ({
      acceptance: item.content.acceptance,
      carriedFromRevision: item.carriedFromRevision,
      evidenceEventIds: item.evidenceEventIds,
      id: item.content.id,
      note: item.note,
      required: item.content.required,
      status: item.status,
      title: item.content.title,
    })),
    planSha256: plan.planSha256,
    status: plan.status,
    statusTransitions: plan.statusTransitions,
  };
}

function renderPlan(io: CliIO["stdout"] | CliIO["stderr"], plan: PlanRevisionProjection): void {
  io.write(
    `Plan ${plan.content.planId} revision=${String(plan.content.revision)} status=${plan.status}\n`,
  );
  io.write(`Title: ${plan.content.title}\n`);
  io.write(`SHA-256: ${plan.planSha256}\n`);
  for (const item of plan.items) {
    io.write(
      `- [${item.status}] ${item.content.id} required=${String(item.content.required)} ${item.content.title}\n`,
    );
    io.write(`  Acceptance: ${item.content.acceptance}\n`);
    if (item.note.length > 0) io.write(`  Note: ${item.note}\n`);
  }
}

function findExactPlan(
  plans: readonly PlanRevisionProjection[],
  identity: {
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
  },
): PlanRevisionProjection | undefined {
  return plans.find(
    (plan) =>
      plan.content.planId === identity.planId &&
      plan.content.revision === identity.revision &&
      plan.planSha256 === identity.sha256,
  );
}

export async function executePlanShow(
  options: PlanShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const applicationView = isDomainHarnessRuntime(runtime)
      ? null
      : await querySessionViewThroughApplicationService({ io, runtime, sessionId: options.sessionId });
    if (applicationView !== null && applicationView.value === null) return applicationView.exitCode;
    const session = applicationView === null ? await new SessionCatalog(runtime.cwd).read(options.sessionId) : null;
    const state = applicationView?.value?.taskState ?? session?.taskState;
    if (state === undefined || state === null) throw new Error("session has no materialized task projection");
    const visiblePlans = options.history
      ? state.plans
      : state.plans.filter((plan) =>
          [state.pendingDraft, state.currentApprovedPlan].some(
            (ref) =>
              ref?.planId === plan.content.planId &&
              ref.revision === plan.content.revision,
          ),
        );
    const blocker = applicationView?.value?.taskMutationBlocker ?? (session === null ? null : taskMutationBlocker(session));
    if (options.json) {
      io.stdout.write(
        `${canonicalJson({
          blocker,
          currentApprovedPlan: refDocument(state.currentApprovedPlan),
          pendingDraft: refDocument(state.pendingDraft),
          plans: visiblePlans.map(planDocument),
          plansTruncated: !options.history && visiblePlans.length !== state.plans.length,
          readyForCompletion: state.readyForCompletion,
          schemaVersion: 1,
          sessionId: options.sessionId,
          trackingMode: state.trackingMode,
        })}\n`,
      );
      return 0;
    }
    io.stdout.write(`Task tracking: ${state.trackingMode}\n`);
    if (visiblePlans.length === 0) io.stdout.write("Plan: none\n");
    for (const plan of visiblePlans) renderPlan(io.stdout, plan);
    if (state.pendingDraft !== null) {
      io.stdout.write(
        `Approve exactly: born plan approve ${options.sessionId} --goal-id ${state.pendingDraft.goalId} --goal-revision ${String(state.pendingDraft.goalRevision)} --plan-id ${state.pendingDraft.planId} --revision ${String(state.pendingDraft.revision)} --sha256 ${state.pendingDraft.planSha256}\n`,
      );
    }
    if (blocker !== null) {
      io.stdout.write(
        `Mutation blocker: ${blocker.code} (${blocker.details.join(", ")})\n`,
      );
    }
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

export async function executePlanReplace(
  options: PlanReplaceOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const baseFields = [
      options.basePlanId,
      options.baseRevision,
      options.baseSha256,
    ];
    if (
      baseFields.some((value) => value !== undefined) &&
      !baseFields.every((value) => value !== undefined)
    ) {
      throw new RangeError(
        "--base-plan-id, --base-revision, and --base-sha256 must be provided together",
      );
    }
    let base: PlanBaseIdentity | null = null;
    if (
      options.basePlanId !== undefined &&
      options.baseRevision !== undefined &&
      options.baseSha256 !== undefined
    ) {
      base = {
        planId: options.basePlanId,
        revision: positiveRevision(options.baseRevision, "base revision"),
        sha256: sha256Schema.parse(options.baseSha256),
      };
    }
    const editablePlan = await new PlanFileLoader().load(
      runtime.cwd,
      options.file,
    );
    const goalRevision = positiveRevision(options.goalRevision, "goal revision");
    const plan = isDomainHarnessRuntime(runtime)
      ? await new PlanStore(taskWriterFactory(runtime)).replaceDraft({ base, context: taskMutationContext(runtime, options.sessionId), editablePlan, goalId: options.goalId, goalRevision })
      : (await executeTaskActionThroughApplicationService({
          actionKind: "plan.propose",
          io,
          payload: { base, editablePlan, goalId: options.goalId, goalRevision },
          runtime,
          sessionId: options.sessionId,
        })).envelope.result;
    if (plan === null) return 2;
    io.stdout.write(
      `Plan ${plan.content.planId} revision ${String(plan.content.revision)} proposed as draft.\nSHA-256: ${plan.planSha256}\n`,
    );
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

async function previewDecision(
  options: PlanDecisionOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<{
  readonly goalRevision: number;
  readonly revision: number;
  readonly sha256: string;
} | Readonly<{ readonly exitCode: 0 | 1 | 2 | 8 }>> {
  const goalRevision = positiveRevision(options.goalRevision, "goal revision");
  const revision = positiveRevision(options.revision, "plan revision");
  const sha256 = sha256Schema.parse(options.sha256);
  const applicationReview = isDomainHarnessRuntime(runtime)
    ? null
    : await queryPlanReviewThroughApplicationService({
        io,
        planId: options.planId,
        revision,
        runtime,
        sessionId: options.sessionId,
        sha256,
      });
  if (applicationReview !== null && applicationReview.value === null) {
    return Object.freeze({ exitCode: applicationReview.exitCode });
  }
  const session = applicationReview === null ? await new SessionCatalog(runtime.cwd).read(options.sessionId) : null;
  const plan = applicationReview === null
    ? findExactPlan(session!.taskState.plans, { planId: options.planId, revision, sha256 })
    : applicationReview.value!.plan ?? undefined;
  if (plan !== undefined) renderPlan(io.stderr, plan);
  io.stderr.write(
    "Plan approval records review only; it does not authorize patches, commands, MCP calls, or any other side effect.\n",
  );
  return { goalRevision, revision, sha256 };
}

export async function executePlanApprove(
  options: PlanApproveOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const identity = await previewDecision(options, runtime, io);
    if ("exitCode" in identity) return identity.exitCode;
    const payload = { decision: "approve" as const, goalId: options.goalId, goalRevision: identity.goalRevision, planId: options.planId, revision: identity.revision, sha256: identity.sha256 };
    const plan = isDomainHarnessRuntime(runtime)
      ? await new PlanStore(taskWriterFactory(runtime)).approveDraft({
          context: taskMutationContext(runtime, options.sessionId),
          goalId: payload.goalId,
          goalRevision: payload.goalRevision,
          planId: payload.planId,
          revision: payload.revision,
          sha256: payload.sha256,
        })
      : (await executeTaskActionThroughApplicationService({ actionKind: "plan.decide", io, payload, runtime, sessionId: options.sessionId })).envelope.result;
    if (plan === null) return 2;
    io.stdout.write(
      `Plan ${plan.content.planId} revision ${String(plan.content.revision)} approved exactly at ${plan.planSha256}.\n`,
    );
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

export async function executePlanReject(
  options: PlanRejectOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const identity = await previewDecision(options, runtime, io);
    if ("exitCode" in identity) return identity.exitCode;
    const payload = { decision: "reject" as const, goalId: options.goalId, goalRevision: identity.goalRevision, planId: options.planId, reason: options.reason, revision: identity.revision, sha256: identity.sha256 };
    const plan = isDomainHarnessRuntime(runtime)
      ? await new PlanStore(taskWriterFactory(runtime)).rejectDraft({
          context: taskMutationContext(runtime, options.sessionId),
          goalId: payload.goalId,
          goalRevision: payload.goalRevision,
          planId: payload.planId,
          reason: payload.reason,
          revision: payload.revision,
          sha256: payload.sha256,
        })
      : (await executeTaskActionThroughApplicationService({ actionKind: "plan.decide", io, payload, runtime, sessionId: options.sessionId })).envelope.result;
    if (plan === null) return 2;
    io.stdout.write(
      `Plan ${plan.content.planId} revision ${String(plan.content.revision)} rejected.\n`,
    );
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}
