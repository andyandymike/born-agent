import type { CliIO, CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import type {
  ApplicationEnvelopeV1,
  AuthenticatedCallContextV1,
} from "../application-protocol.js";
import type { PreparedActionResponseV1 } from "../application-service.js";
import type { ProductSessionProjectionBodyV1 } from "../session-projection-service.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  activeDelegationControlForRuntime,
  activeForegroundGraphControlForRuntime,
  adoptLegacySessionThroughApplicationService,
  contextForRuntime,
  planeForRuntime,
  registerCurrentRepository,
} from "./agent-cli-adapter.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import {
  decodeTaskActionResult,
  type TaskActionResultContractMapV1,
} from "../use-cases/action-result-codecs.js";
import {
  preparedReviewFailure,
  registerPreparedApplicationActionReviewer,
  reviewPreparedApplicationAction,
  type PreparedApplicationActionReviewDecisionV1,
  type PreparedApplicationActionReviewerV1,
  type PreparedApplicationActionReviewV1,
} from "./prepared-action-reviewer.js";

export interface TaskApplicationActionResultV1<TResult = unknown> {
  readonly envelope: ApplicationEnvelopeV1<TResult>;
  readonly exitCode: 0 | 1 | 2 | 8;
}

export type TaskApplicationActionResultMapV1 = TaskActionResultContractMapV1;
export type TaskApplicationActionKindV1 = keyof TaskApplicationActionResultMapV1;

export interface TaskApplicationActionInputV1<
  TActionKind extends TaskApplicationActionKindV1 = TaskApplicationActionKindV1,
> {
  readonly actionKind: TActionKind;
  readonly io: CliIO;
  readonly expectedSessionSeq?: number;
  readonly payload: unknown;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface?: "cli" | "tui";
}

export type TaskPreparedActionReviewV1 = PreparedApplicationActionReviewV1;
export type TaskPreparedActionReviewDecisionV1 = PreparedApplicationActionReviewDecisionV1;
export type TaskPreparedActionReviewerV1 = PreparedApplicationActionReviewerV1;

/**
 * PHASE21: only the interactive TUI installs this process-local presentation
 * port. The prepared identity remains Host-owned and is never reconstructed
 * from projection text or from the human decision.
 */
export function registerTaskPreparedActionReviewer(
  runtime: CliRuntime,
  reviewer: TaskPreparedActionReviewerV1,
): () => void {
  return registerPreparedApplicationActionReviewer(runtime, reviewer);
}

export interface PreparedTaskApplicationActionV1 {
  readonly envelope: ApplicationEnvelopeV1<PreparedActionResponseV1>;
  readonly exitCode: 0 | 1 | 2 | 8;
}

interface PreparedTaskApplicationActionStateV1 {
  readonly actionKind: TaskApplicationActionKindV1;
  readonly context: AuthenticatedCallContextV1;
  readonly io: CliIO;
  readonly plane: Awaited<ReturnType<typeof planeForRuntime>>;
  readonly repositoryId: string;
  readonly runtime: CliRuntime;
  readonly semantic: string;
  readonly sessionId: string;
}

const preparedTaskApplicationActions = new WeakMap<
  PreparedTaskApplicationActionV1,
  PreparedTaskApplicationActionStateV1
>();

function failureExit(envelope: ApplicationEnvelopeV1<unknown>): 1 | 2 | 8 {
  const code = envelope.error?.code ?? "control_operation_corrupt";
  if ([
    "control_catalog_conflict",
    "control_operation_busy",
    "control_prepared_action_consumed",
    "control_prepared_action_expired",
    "control_resync_required",
    "control_session_not_started",
    "control_stale_projection",
  ].includes(code)) return 8;
  return [
    "control_authentication_failed",
    "control_authorization_denied",
    "control_idempotency_conflict",
    "control_payload_invalid",
    "control_prepared_action_mismatch",
    "control_session_not_started",
    "control_stale_projection",
    "control_target_invalid",
    "control_unknown_action",
  ].includes(code) ? 2 : 1;
}

function renderFailure(envelope: ApplicationEnvelopeV1<unknown>, io: CliIO): 1 | 2 | 8 {
  io.stderr.write(`${envelope.error?.code ?? "control_operation_corrupt"}: ${envelope.error?.message ?? "application control failed"}\n`);
  return failureExit(envelope);
}

/** PHASE21: legacy session discovery is a bounded, one-time catalog migration. */
async function ensureCatalogedSession(input: {
  readonly context: AuthenticatedCallContextV1;
  readonly io: CliIO;
  readonly plane: Awaited<ReturnType<typeof planeForRuntime>>;
  readonly repositoryId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}): Promise<ApplicationEnvelopeV1<unknown> | null> {
  const adopted = await adoptLegacySessionThroughApplicationService(
    input.plane,
    input.context,
    input.runtime,
    input.repositoryId,
    input.sessionId,
    input.io,
  );
  return "status" in adopted ? adopted : null;
}

export async function prepareTaskActionThroughApplicationService(
  input: TaskApplicationActionInputV1,
): Promise<PreparedTaskApplicationActionV1> {
  if (input.runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("application control state root is unavailable");
  }
  const plane = await planeForRuntime(input.runtime, input.io);
  const context = contextForRuntime(plane, input.runtime, input.surface ?? "cli");
  const repository = await registerCurrentRepository(plane, context, input.runtime, input.io);
  if (!("repositoryId" in repository)) {
    return Object.freeze({
      envelope: repository as ApplicationEnvelopeV1<PreparedActionResponseV1>,
      exitCode: renderFailure(repository, input.io),
    });
  }
  const adoptionFailure = await ensureCatalogedSession({
    context,
    io: input.io,
    plane,
    repositoryId: repository.repositoryId,
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  if (adoptionFailure !== null) {
    return Object.freeze({
      envelope: adoptionFailure as ApplicationEnvelopeV1<PreparedActionResponseV1>,
      exitCode: renderFailure(adoptionFailure, input.io),
    });
  }
  const snapshot = await plane.sessionProjection.read({
    repositoryId: repository.repositoryId,
    requestedHead: null,
    sessionId: input.sessionId,
  });
  if (
    input.expectedSessionSeq !== undefined &&
    snapshot.head.publicHead.sequence !== input.expectedSessionSeq
  ) {
    const requestId = input.runtime.randomUUID();
    const stale: ApplicationEnvelopeV1<PreparedActionResponseV1> = Object.freeze({
      deliveryCursor: null,
      error: Object.freeze({
        code: "control_stale_projection",
        message: `expected session sequence ${String(input.expectedSessionSeq)}, current ${String(snapshot.head.publicHead.sequence)}`,
      }),
      ledgerHead: snapshot.head.publicHead,
      liveObservation: null,
      operationId: null,
      projectionIdentity: snapshot.projection.identity,
      requestId,
      resourceScope: snapshot.resourceScope,
      resourceVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" as const },
      result: null,
      schemaVersion: 1,
      sessionId: input.sessionId,
      status: "rejected",
      warnings: Object.freeze([]),
    });
    return Object.freeze({ envelope: stale, exitCode: renderFailure(stale, input.io) });
  }
  const semantic = sha256Canonical({
    action_kind: input.actionKind,
    payload: input.payload,
    resource_scope: snapshot.resourceScope,
    resource_version: snapshot.head.publicHead,
    schema_version: 1,
  });
  const prepared = await plane.actions.prepare(context, {
    actionKind: input.actionKind,
    payload: input.payload,
    payloadSha256: sha256Canonical(input.payload),
    // A closed/expired/stale TUI dialog is discarded. A later invocation gets
    // a fresh prepared identity instead of silently reusing the bytes that the
    // human declined or could no longer authorize.
    prepareIdempotencyKey: input.surface === "tui"
      ? `tui-prepare-${input.runtime.randomUUID()}`
      : `cli-prepare-${semantic}`,
    requestId: input.runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: snapshot.resourceScope,
    },
  });
  if (prepared.status !== "ok" || prepared.result === null) {
    return Object.freeze({ envelope: prepared, exitCode: renderFailure(prepared, input.io) });
  }
  const handle: PreparedTaskApplicationActionV1 = Object.freeze({
    envelope: prepared,
    exitCode: 0,
  });
  preparedTaskApplicationActions.set(handle, Object.freeze({
    actionKind: input.actionKind,
    context,
    io: input.io,
    plane,
    repositoryId: repository.repositoryId,
    runtime: input.runtime,
    semantic,
    sessionId: input.sessionId,
  }));
  return handle;
}

function rejectedPreparedAction<TResult>(
  prepared: PreparedTaskApplicationActionV1,
  code:
    | "control_authorization_denied"
    | "control_prepared_action_expired"
    | "control_stale_projection",
  message: string,
  io: CliIO,
): TaskApplicationActionResultV1<TResult> {
  const rejected: ApplicationEnvelopeV1<TResult> = Object.freeze({
    ...prepared.envelope,
    error: Object.freeze({ code, message }),
    result: null,
    status: "rejected",
  });
  return Object.freeze({ envelope: rejected, exitCode: renderFailure(rejected, io) });
}

async function preparedTargetIsCurrent(
  prepared: PreparedTaskApplicationActionV1,
  state: PreparedTaskApplicationActionStateV1,
): Promise<boolean> {
  const target = prepared.envelope.result?.prepared.target;
  if (
    target?.kind !== "existing_resource" ||
    target.expectedVersion.kind !== "session_ledger_head"
  ) return true;
  const snapshot = await state.plane.sessionProjection.read({
    repositoryId: state.repositoryId,
    requestedHead: null,
    sessionId: state.sessionId,
  });
  return sha256Canonical(snapshot.head.publicHead) ===
    sha256Canonical(target.expectedVersion.head);
}

export async function commitPreparedTaskActionThroughApplicationService<
  TActionKind extends TaskApplicationActionKindV1,
>(
  prepared: PreparedTaskApplicationActionV1,
  expectedActionKind: TActionKind,
): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1[TActionKind]>> {
  type TResult = TaskApplicationActionResultMapV1[TActionKind];
  const state = preparedTaskApplicationActions.get(prepared);
  const response = prepared.envelope.result;
  if (
    state === undefined || response === null || prepared.envelope.status !== "ok" ||
    state.actionKind !== expectedActionKind || response.prepared.actionKind !== expectedActionKind
  ) {
    throw new TypeError("prepared task action handle is unavailable");
  }
  if (Date.parse(response.prepared.expiresAt) <= Date.parse(state.runtime.timestamp())) {
    return rejectedPreparedAction(
      prepared,
      "control_prepared_action_expired",
      "prepared action expired before confirmation; prepare the action again",
      state.io,
    );
  }
  if (!(await preparedTargetIsCurrent(prepared, state))) {
    return rejectedPreparedAction(
      prepared,
      "control_stale_projection",
      "prepared action target became stale before confirmation; prepare the action again",
      state.io,
    );
  }
  const committed = await state.plane.actions.commit(state.context, {
    idempotencyKey: `cli-commit-${state.semantic}`,
    preparedActionId: response.prepared.preparedActionId,
    preparedActionSha256: response.prepared.preparedActionSha256,
    requestId: state.runtime.randomUUID(),
    schemaVersion: 1,
  });
  if (committed.status !== "ok") {
    const envelope: ApplicationEnvelopeV1<TResult> = Object.freeze({ ...committed, result: null });
    return Object.freeze({
      envelope,
      exitCode: renderFailure(committed, state.io),
    });
  }
  try {
    if (committed.result === null) throw new TypeError("successful application action returned a null result");
    // The Host re-validates its registered contract, then the surface binds
    // that value through the compile-time action/result map. There is no
    // caller-selected TResult assertion at this boundary.
    state.plane.actions.decodeResult(expectedActionKind, committed.result);
    const result = decodeTaskActionResult(expectedActionKind, committed.result);
    const envelope: ApplicationEnvelopeV1<TResult> = Object.freeze({ ...committed, result });
    return Object.freeze({ envelope, exitCode: 0 });
  } catch {
    const corrupt: ApplicationEnvelopeV1<TResult> = Object.freeze({
      ...committed,
      error: Object.freeze({
        code: "control_operation_corrupt",
        message: "application action failed its strict typed result contract",
      }),
      result: null,
      status: "rejected",
    });
    return Object.freeze({ envelope: corrupt, exitCode: renderFailure(corrupt, state.io) });
  }
}

export async function executeTaskActionThroughApplicationService<
  TActionKind extends TaskApplicationActionKindV1,
>(
  input: TaskApplicationActionInputV1<TActionKind>,
): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1[TActionKind]>> {
  type TResult = TaskApplicationActionResultMapV1[TActionKind];
  const prepared = await prepareTaskActionThroughApplicationService(input);
  if (prepared.exitCode !== 0 || prepared.envelope.result === null) {
    const envelope: ApplicationEnvelopeV1<TResult> = Object.freeze({
      ...prepared.envelope,
      result: null,
    });
    return Object.freeze({ envelope, exitCode: prepared.exitCode });
  }
  // PHASE21: the adapter must present the exact Host-built display before it
  // commits. These registered task actions use show_before_commit; any future
  // explicit_human action must use a separate confirmation adapter and is not
  // eligible for this automatic command-invocation commit path.
  const confirmation = prepared.envelope.result.prepared.confirmation as
    | "explicit_human"
    | "none"
    | "show_before_commit";
  if (confirmation === "show_before_commit") {
    const decision = await reviewPreparedApplicationAction({
      io: input.io,
      prepared: prepared.envelope.result,
      runtime: input.runtime,
      surface: input.surface ?? "cli",
    });
    if (decision !== "confirmed") {
      const failure = preparedReviewFailure(decision);
      return rejectedPreparedAction(
        prepared,
        failure.code,
        failure.message,
        input.io,
      );
    }
  } else if (confirmation !== "none") {
    input.io.stderr.write(`${prepared.envelope.result.display.summary}\n`);
    for (const warning of prepared.envelope.result.display.warnings) {
      input.io.stderr.write(`warning: ${warning}\n`);
    }
  }
  if (confirmation === "explicit_human") {
    return rejectedPreparedAction(
      prepared,
      "control_authorization_denied",
      "explicit human confirmation is required before commit",
      input.io,
    );
  }
  const foregroundGraph = foregroundGraphSelector(input);
  if (foregroundGraph !== null && (input.surface ?? "cli") === "cli") {
    return commitForegroundGraphWithTypedCancellation({
      input,
      prepared,
      selector: foregroundGraph,
    });
  }
  const delegation = delegationSelector(input);
  if (delegation !== null && (input.surface ?? "cli") === "cli") {
    return commitDelegationWithTypedCancellation({
      input,
      prepared,
      selector: delegation,
    });
  }
  return commitPreparedTaskActionThroughApplicationService(prepared, input.actionKind);
}

function delegationSelector(input: TaskApplicationActionInputV1): Readonly<{
  readonly delegationId: string;
}> | null {
  if (input.actionKind !== "delegation.start" && input.actionKind !== "delegation.resume") return null;
  if (typeof input.payload !== "object" || input.payload === null) return null;
  const delegationId = (input.payload as Readonly<Record<string, unknown>>).delegationId;
  return typeof delegationId === "string"
    ? Object.freeze({ delegationId })
    : null;
}

async function commitDelegationWithTypedCancellation<
  TActionKind extends TaskApplicationActionKindV1,
>(input: Readonly<{
  readonly input: TaskApplicationActionInputV1<TActionKind>;
  readonly prepared: PreparedTaskApplicationActionV1;
  readonly selector: Readonly<{ readonly delegationId: string }>;
}>): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1[TActionKind]>> {
  const state = preparedTaskApplicationActions.get(input.prepared);
  const preparedResponse = input.prepared.envelope.result;
  if (state === undefined || preparedResponse === null) throw new TypeError("prepared Delegation action handle is unavailable");
  let actionSettled = false;
  let cancellationStarted = false;
  let cancellationFailure: unknown = null;
  let cancellationTask: Promise<void> = Promise.resolve();
  const wait = () => new Promise<void>((resolve) => input.input.runtime.setTimer(resolve, 10));
  const requestTypedCancellation = async () => {
    while (!actionSettled) {
      const active = activeDelegationControlForRuntime(input.input.runtime, input.input.sessionId);
      if (
        active === null || active.delegationId !== input.selector.delegationId ||
        active.ownerPreparedActionSha256 !== preparedResponse.prepared.preparedActionSha256
      ) {
        await wait();
        continue;
      }
      const cancelled = await requestActiveDelegationCancelThroughApplicationService({
        delegationId: input.selector.delegationId,
        io: input.input.io,
        reason: "CLI interrupt requested delegated child cancellation",
        runtime: input.input.runtime,
        sessionId: input.input.sessionId,
        surface: "cli",
      });
      if (cancelled.exitCode !== 0) throw new TypeError("typed Delegation cancellation was not accepted");
      return;
    }
  };
  const stop = input.input.runtime.onCancel(() => {
    if (cancellationStarted || actionSettled) return;
    cancellationStarted = true;
    cancellationTask = requestTypedCancellation().catch((error: unknown) => {
      cancellationFailure = error;
      input.input.io.stderr.write(`control_operation_busy: ${error instanceof Error ? error.message : "typed Delegation cancellation failed"}\n`);
    });
  });
  try {
    const result = await commitPreparedTaskActionThroughApplicationService(input.prepared, input.input.actionKind);
    actionSettled = true;
    await cancellationTask;
    if (cancellationFailure !== null) throw cancellationFailure;
    return result;
  } finally {
    actionSettled = true;
    stop();
    await cancellationTask;
  }
}

/**
 * Commit the typed cancel request before signalling the exact local owner.
 * This ordering lets a pre-admission owner persist a known no-effect terminal,
 * while an admitted child consumes the same durable request as authority.
 */
export async function requestActiveDelegationCancelThroughApplicationService(input: Readonly<{
  readonly delegationId: string;
  readonly io: CliIO;
  readonly reason: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface: "cli" | "tui";
}>): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1["delegation.cancel"]>> {
  const wait = () => new Promise<void>((resolve) => input.runtime.setTimer(resolve, 10));
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    let result: TaskApplicationActionResultV1<TaskApplicationActionResultMapV1["delegation.cancel"]>;
    try {
      result = await executeTaskActionThroughApplicationService({
        actionKind: "delegation.cancel",
        io: {
          stderr: { write: (value) => { stderr.push(value); } },
          stdout: { write: (value) => { stdout.push(value); } },
        },
        payload: Object.freeze({ delegationId: input.delegationId, reason: input.reason }),
        runtime: input.runtime,
        sessionId: input.sessionId,
        surface: input.surface,
      });
    } catch (error) {
      if (error instanceof ApplicationControlError && error.code === "control_operation_busy" && attempt < 511) {
        await wait();
        continue;
      }
      throw error;
    }
    const transientWriter = result.exitCode === 8 && result.envelope.operationId === null &&
      result.envelope.error?.code === "control_operation_busy";
    if (transientWriter && attempt < 511) {
      await wait();
      continue;
    }
    for (const value of stdout) input.io.stdout.write(value);
    for (const value of stderr) input.io.stderr.write(value);
    return result;
  }
  throw new TypeError("bounded Delegation cancellation retry did not return a result");
}

/**
 * Safety-control surface bridge for an already-active foreground Graph. The
 * Host resolves a fresh exact head; callers provide only the displayed Graph
 * identity and cannot signal the scheduler directly.
 */
export async function requestActiveGraphCancelThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly reason: string;
  readonly revision: number;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly sha256: string;
  readonly surface: "cli" | "tui";
}>): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1["graph.cancel"]>> {
  const wait = () => new Promise<void>((resolve) => input.runtime.setTimer(resolve, 10));
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    let result: TaskApplicationActionResultV1<TaskApplicationActionResultMapV1["graph.cancel"]>;
    try {
      result = await executeTaskActionThroughApplicationService({
        actionKind: "graph.cancel",
        io: {
          stderr: { write: (value) => { stderr.push(value); } },
          stdout: { write: (value) => { stdout.push(value); } },
        },
        payload: Object.freeze({ reason: input.reason, revision: input.revision, sha256: input.sha256 }),
        runtime: input.runtime,
        sessionId: input.sessionId,
        surface: input.surface,
      });
    } catch (error) {
      if (error instanceof ApplicationControlError && error.code === "control_operation_busy" && attempt < 511) {
        await wait();
        continue;
      }
      throw error;
    }
    const transientWriter = result.exitCode === 8 && result.envelope.operationId === null &&
      result.envelope.error?.code === "control_operation_busy";
    if (transientWriter && attempt < 511) {
      await wait();
      continue;
    }
    for (const value of stdout) input.io.stdout.write(value);
    for (const value of stderr) input.io.stderr.write(value);
    return result;
  }
  throw new TypeError("bounded Graph cancellation retry did not return a result");
}

function foregroundGraphSelector(input: TaskApplicationActionInputV1): Readonly<{
  readonly revision: number;
  readonly sha256: string;
}> | null {
  if (input.actionKind !== "graph.run" && input.actionKind !== "graph.resume") return null;
  if (typeof input.payload !== "object" || input.payload === null) return null;
  const payload = input.payload as Readonly<Record<string, unknown>>;
  return payload.execution === "foreground" && Number.isSafeInteger(payload.revision) &&
      typeof payload.sha256 === "string" && /^[a-f0-9]{64}$/u.test(payload.sha256)
    ? Object.freeze({ revision: payload.revision as number, sha256: payload.sha256 })
    : null;
}

async function commitForegroundGraphWithTypedCancellation<
  TActionKind extends TaskApplicationActionKindV1,
>(input: Readonly<{
  readonly input: TaskApplicationActionInputV1<TActionKind>;
  readonly prepared: PreparedTaskApplicationActionV1;
  readonly selector: Readonly<{ readonly revision: number; readonly sha256: string }>;
}>): Promise<TaskApplicationActionResultV1<TaskApplicationActionResultMapV1[TActionKind]>> {
  const state = preparedTaskApplicationActions.get(input.prepared);
  const preparedResponse = input.prepared.envelope.result;
  if (state === undefined || preparedResponse === null) throw new TypeError("prepared Graph action handle is unavailable");
  let actionSettled = false;
  let cancellationStarted = false;
  let cancellationFailure: unknown = null;
  let cancellationTask: Promise<void> = Promise.resolve();
  const wait = () => new Promise<void>((resolve) => input.input.runtime.setTimer(resolve, 10));
  const requestTypedCancellation = async () => {
    while (!actionSettled) {
      const active = activeForegroundGraphControlForRuntime(input.input.runtime, input.input.sessionId);
      if (
        active === null || active.graphRevision !== input.selector.revision ||
        active.graphSha256 !== input.selector.sha256 ||
        active.ownerPreparedActionSha256 !== preparedResponse.prepared.preparedActionSha256
      ) {
        await wait();
        continue;
      }
      const snapshot = await state.plane.sessionProjection.read({
        repositoryId: state.repositoryId,
        requestedHead: null,
        sessionId: state.sessionId,
      });
      const execution = snapshot.projection.projection.taskExecution as TaskExecutionProjectionV1 | null;
      if (
        execution === null || execution.status !== "running" ||
        execution.graph.revision !== input.selector.revision ||
        execution.graph.graphSha256 !== input.selector.sha256
      ) {
        await wait();
        continue;
      }
      const cancelled = await requestActiveGraphCancelThroughApplicationService({
        io: input.input.io,
        reason: "CLI interrupt requested foreground Graph cancellation",
        revision: input.selector.revision,
        runtime: input.input.runtime,
        sessionId: input.input.sessionId,
        sha256: input.selector.sha256,
        surface: "cli",
      });
      if (cancelled.exitCode === 0) return;
      if (cancelled.envelope.error?.code !== "control_stale_projection") {
        throw new TypeError(cancelled.envelope.error?.message ?? "typed Graph cancellation was not accepted");
      }
    }
  };
  const stop = input.input.runtime.onCancel(() => {
    if (cancellationStarted || actionSettled) return;
    cancellationStarted = true;
    cancellationTask = requestTypedCancellation().catch((error: unknown) => {
      cancellationFailure = error;
      input.input.io.stderr.write(`control_operation_busy: ${error instanceof Error ? error.message : "typed Graph cancellation failed"}\n`);
    });
  });
  try {
    const result = await commitPreparedTaskActionThroughApplicationService(input.prepared, input.input.actionKind);
    actionSettled = true;
    await cancellationTask;
    if (cancellationFailure !== null) throw cancellationFailure;
    return result;
  } finally {
    actionSettled = true;
    stop();
    await cancellationTask;
  }
}

export async function querySessionViewThroughApplicationService(input: {
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface?: "cli" | "tui";
}): Promise<Readonly<{
  readonly exitCode: 0 | 1 | 2 | 8;
  readonly value: ProductSessionProjectionBodyV1 | null;
}>> {
  if (input.runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("application control state root is unavailable");
  }
  const plane = await planeForRuntime(input.runtime, input.io);
  const context = contextForRuntime(plane, input.runtime, input.surface ?? "cli");
  const repository = await registerCurrentRepository(plane, context, input.runtime, input.io);
  if (!("repositoryId" in repository)) {
    return Object.freeze({ exitCode: renderFailure(repository, input.io), value: null });
  }
  const adoptionFailure = await ensureCatalogedSession({
    context,
    io: input.io,
    plane,
    repositoryId: repository.repositoryId,
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  if (adoptionFailure !== null) {
    return Object.freeze({ exitCode: renderFailure(adoptionFailure, input.io), value: null });
  }
  const queried = await plane.queries.query(context, {
    atVersion: null,
    pageCursor: null,
    payload: {},
    queryKind: "session.view",
    requestId: input.runtime.randomUUID(),
    resourceScope: {
      kind: "session",
      repositoryId: repository.repositoryId,
      sessionId: input.sessionId,
      teamId: null,
    },
    schemaVersion: 1,
  });
  if (queried.status !== "ok" || queried.result === null) {
    return Object.freeze({ exitCode: renderFailure(queried, input.io), value: null });
  }
  return Object.freeze({ exitCode: 0, value: queried.result.value as ProductSessionProjectionBodyV1 });
}
