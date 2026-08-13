import { canonicalJson } from "../completion/canonical-json.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  taskMutationBlocker,
} from "../coordination/task-control-plane.js";
import type { GoalProjection } from "../goals/goal-schema.js";
import { GoalManager } from "../goals/goal-manager.js";
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

export interface GoalShowOptions {
  readonly json: boolean;
  readonly sessionId: string;
}

export interface GoalSetOptions {
  readonly baseRevision?: string;
  readonly goalId?: string;
  readonly sessionId: string;
  readonly text: string;
}

export interface GoalNewOptions {
  readonly abandonCurrent: boolean;
  readonly currentGoalId?: string;
  readonly currentRevision?: string;
  readonly parentGoal?: string;
  readonly sessionId: string;
  readonly text: string;
}

export interface GoalAbandonOptions {
  readonly goalId: string;
  readonly reason: string;
  readonly revision: string;
  readonly sessionId: string;
}

function goalDocument(goal: GoalProjection) {
  return {
    createdEventId: goal.createdEventId,
    goalId: goal.content.goalId,
    lastStatusEventId: goal.lastStatusEventId,
    objective: goal.content.objective,
    parentGoalId: goal.content.parentGoalId,
    revision: goal.content.revision,
    status: goal.status,
  };
}

export async function executeGoalShow(
  options: GoalShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const applicationView = runtime.controlPlaneStateRoot === undefined
      ? null
      : await querySessionViewThroughApplicationService({ io, runtime, sessionId: options.sessionId });
    if (applicationView !== null && applicationView.value === null) return applicationView.exitCode;
    const session = applicationView === null ? await new SessionCatalog(runtime.cwd).read(options.sessionId) : null;
    const state = applicationView?.value?.taskState ?? session?.taskState;
    if (state === undefined || state === null) throw new Error("session has no materialized task projection");
    const active = state.goals.find(
      (goal) => goal.content.goalId === state.activeGoalId,
    );
    const last = active ?? state.goals.at(-1) ?? null;
    const blocker = applicationView?.value?.taskMutationBlocker ?? (session === null ? null : taskMutationBlocker(session));
    if (options.json) {
      io.stdout.write(
        `${canonicalJson({
          activeGoalId: state.activeGoalId,
          blocker,
          goals: state.goals.map(goalDocument),
          historyCount: state.goals.length,
          schemaVersion: 1,
          sessionId: options.sessionId,
          trackingMode: state.trackingMode,
        })}\n`,
      );
      return 0;
    }
    io.stdout.write(`Task tracking: ${state.trackingMode}\n`);
    if (last === null) {
      io.stdout.write("Goal: none\n");
    } else {
      io.stdout.write(
        `Goal: ${last.content.goalId} revision=${String(last.content.revision)} status=${last.status}\n`,
      );
      io.stdout.write(`Objective: ${last.content.objective}\n`);
    }
    io.stdout.write(`Goal history: ${String(state.goals.length)}\n`);
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

export async function executeGoalSet(
  options: GoalSetOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const hasGoal = options.goalId !== undefined;
    const hasRevision = options.baseRevision !== undefined;
    if (hasGoal !== hasRevision) {
      throw new RangeError(
        "--goal-id and --base-revision must be provided together",
      );
    }
    const baseRevision = options.baseRevision === undefined ? undefined : positiveRevision(options.baseRevision, "base revision");
    const goal = runtime.controlPlaneStateRoot === undefined
      ? options.goalId === undefined || baseRevision === undefined
        ? await new GoalManager(taskWriterFactory(runtime)).createInitialGoal({ context: taskMutationContext(runtime, options.sessionId), objective: options.text })
        : await new GoalManager(taskWriterFactory(runtime)).reviseActiveGoal({ baseRevision, context: taskMutationContext(runtime, options.sessionId), goalId: options.goalId, objective: options.text })
      : (await executeTaskActionThroughApplicationService({
          actionKind: "goal.propose",
          io,
          payload: options.goalId === undefined || baseRevision === undefined
            ? { objective: options.text, operation: "create_initial" }
            : { baseRevision, goalId: options.goalId, objective: options.text, operation: "revise" },
          runtime,
          sessionId: options.sessionId,
        })).envelope.result;
    if (goal === null) return 2;
    io.stderr.write(
      "Goal revision changes invalidate Plan authority for the prior revision; workspace bytes are not rolled back.\n",
    );
    io.stdout.write(
      `Goal ${goal.content.goalId} revision ${String(goal.content.revision)} is active.\n`,
    );
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

export async function executeGoalNew(
  options: GoalNewOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const replacementFields = [
      options.abandonCurrent,
      options.currentGoalId !== undefined,
      options.currentRevision !== undefined,
    ];
    if (replacementFields.some(Boolean) && !replacementFields.every(Boolean)) {
      throw new RangeError(
        "--abandon-current, --current-goal-id, and --current-revision must be provided together",
      );
    }
    const replaceActive = options.currentGoalId === undefined || options.currentRevision === undefined
      ? null
      : { confirmedAbandon: true as const, goalId: options.currentGoalId, revision: positiveRevision(options.currentRevision, "current revision") };
    const payload = { objective: options.text, operation: "start_new" as const, parentGoalId: options.parentGoal ?? null, replaceActive };
    const goal = runtime.controlPlaneStateRoot === undefined
      ? await new GoalManager(taskWriterFactory(runtime)).startNewGoal({
          context: taskMutationContext(runtime, options.sessionId),
          objective: payload.objective,
          parentGoalId: payload.parentGoalId,
          replaceActive: payload.replaceActive,
        })
      : (await executeTaskActionThroughApplicationService({ actionKind: "goal.propose", io, payload, runtime, sessionId: options.sessionId })).envelope.result;
    if (goal === null) return 2;
    io.stderr.write(
      "Starting a new Goal invalidates prior Plan authority; prior change records remain history and workspace bytes are not rolled back.\n",
    );
    io.stdout.write(
      `Goal ${goal.content.goalId} revision 1 is active.\n`,
    );
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

export async function executeGoalAbandon(
  options: GoalAbandonOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const revision = positiveRevision(options.revision, "revision");
    const goal = runtime.controlPlaneStateRoot === undefined
      ? await new GoalManager(taskWriterFactory(runtime)).abandonActiveGoal({ context: taskMutationContext(runtime, options.sessionId), goalId: options.goalId, reason: options.reason, revision })
      : (await executeTaskActionThroughApplicationService({
          actionKind: "goal.decide",
          io,
          payload: { decision: "abandon", goalId: options.goalId, reason: options.reason, revision },
          runtime,
          sessionId: options.sessionId,
        })).envelope.result;
    if (goal === null) return 2;
    io.stdout.write(`Goal ${goal.content.goalId} was abandoned.\n`);
    return 0;
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}
