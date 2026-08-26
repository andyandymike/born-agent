import type { AgentCommandOptions, AgentExitCode } from "../../agent/agent-types.js";
import { executeAgentExecution } from "../../agent/agent-execution-service.js";
import {
  createAgentExecutionPresentationPort,
  createAgentExecutionRuntimePort,
} from "../../cli/agent-execution-ports.js";
import type { CliIO, CliRuntime } from "../../cli/types.js";
import { isDomainHarnessRuntime } from "../../coordination/domain-harness.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import type { ApplicationEnvelopeV1, AuthenticatedCallContextV1 } from "../application-protocol.js";
import { ApplicationControlError } from "../application-errors.js";
import type { PreparedActionResponseV1 } from "../application-service.js";
import { createPhase21ALocalControlPlane } from "../local-control-plane.js";
import {
  processLocalApplicationHosts,
  type LocalApplicationHost,
} from "../local-application-host.js";
import {
  agentSessionMessagePayloadV1Schema,
  type AgentSessionMessagePayloadV1,
  type ChatExecutionPortV1,
} from "../use-cases/session-message-action.js";
import { CliGraphCompositeOwnerPort } from "./graph-composite-cli-port.js";
import { CliGraphCancelOwnerPort } from "./graph-cancel-cli-port.js";
import { CliDelegationCompositeOwnerPort } from "./delegation-composite-cli-port.js";
import {
  createDelegationOwnerInteractionPort,
  createDelegationOwnerRuntimePort,
} from "../../cli/delegation-owner-ports.js";
import type { SessionResumeOwnerPortV1 } from "../use-cases/session-resume-action.js";
import type { TaskSurfaceQueryOperationPortV1 } from "../use-cases/task-surface-queries.js";
import {
  preparedReviewFailure,
  reviewPreparedApplicationAction,
} from "./prepared-action-reviewer.js";

function exitForEnvelope(envelope: ApplicationEnvelopeV1<unknown>): AgentExitCode {
  const code = envelope.error?.code ?? "control_operation_corrupt";
  if (["control_operation_busy", "control_resync_required", "control_stale_projection", "control_session_not_started"].includes(code)) return 8;
  if (["control_authentication_failed", "control_authorization_denied", "control_payload_invalid", "control_target_invalid", "control_unknown_action"].includes(code)) return 2;
  return 1;
}

export function reportApplicationFailure(envelope: ApplicationEnvelopeV1<unknown>, io: CliIO): AgentExitCode {
  io.stderr.write(`${envelope.error?.code ?? "control_operation_corrupt"}: ${envelope.error?.message ?? "application control failed"}\n`);
  return exitForEnvelope(envelope);
}

export async function reviewPreparedBeforeCommit(
  envelope: ApplicationEnvelopeV1<PreparedActionResponseV1>,
  plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>,
  runtime: CliRuntime,
  io: CliIO,
  surface: "cli" | "tui",
): Promise<ApplicationEnvelopeV1<PreparedActionResponseV1> | null> {
  if (envelope.status !== "ok" || envelope.result === null) return null;
  const decision = await reviewPreparedApplicationAction({
    io,
    prepared: envelope.result,
    runtime,
    surface,
  });
  let resolvedDecision = decision;
  if (
    resolvedDecision === "confirmed" &&
    Date.parse(envelope.result.prepared.expiresAt) <= Date.parse(runtime.timestamp())
  ) resolvedDecision = "expired";
  if (resolvedDecision === "confirmed") {
    const target = envelope.result.prepared.target;
    let current = true;
    if (target.kind === "new_repository") {
      const head = await plane.repositories.head();
      current = head.revision === target.expectedCatalogVersion.revision &&
        head.catalogSha256 === target.expectedCatalogVersion.sha256;
    } else if (target.kind === "new_session") {
      const head = await plane.sessions.head(target.catalogScope.repositoryId);
      current = head.revision === target.expectedCatalogVersion.revision &&
        head.catalogSha256 === target.expectedCatalogVersion.sha256;
    } else if (
      target.resourceScope.kind === "session" &&
      target.expectedVersion.kind === "session_ledger_head"
    ) {
      const snapshot = await plane.sessionProjection.read({
        repositoryId: target.resourceScope.repositoryId,
        requestedHead: null,
        sessionId: target.resourceScope.sessionId,
      });
      current = sha256Canonical(snapshot.head.publicHead) ===
        sha256Canonical(target.expectedVersion.head);
    }
    if (!current) resolvedDecision = "stale";
  }
  if (resolvedDecision === "confirmed") return null;
  const failure = preparedReviewFailure(resolvedDecision);
  return Object.freeze({
    ...envelope,
    error: Object.freeze({ code: failure.code, message: failure.message }),
    result: null,
    status: "rejected",
  });
}

function payloadFromOptions(options: AgentCommandOptions): AgentSessionMessagePayloadV1 {
  const {
    dockerArtifactExecution: _dockerArtifactExecution,
    inputSurface: _inputSurface,
    modeSource,
    providerSource: _providerSource,
    ...wire
  } = options;
  void _dockerArtifactExecution;
  void _inputSurface;
  void _providerSource;
  return Object.freeze(agentSessionMessagePayloadV1Schema.parse({
    ...wire,
    command: "agent",
    ...(options.mode === undefined
      ? {}
      : { modeSelection: modeSource === "tui_default" ? "surface_default" : "explicit" }),
  }));
}

function optionsFromPayload(
  payload: AgentSessionMessagePayloadV1,
  surface: "cli" | "tui",
): AgentCommandOptions {
  const { command: _command, modeSelection, ...options } = payload;
  void _command;
  const modeSource = payload.mode === undefined
    ? undefined
    : surface === "cli"
      ? "explicit_cli" as const
      : modeSelection === "surface_default"
        ? "tui_default" as const
        : "explicit_tui" as const;
  const candidate = {
    ...options,
    inputSurface: surface,
    ...(modeSource === undefined ? {} : { modeSource }),
  };
  return Object.freeze(Object.fromEntries(
    Object.entries(candidate).filter((entry) => entry[1] !== undefined),
  )) as unknown as AgentCommandOptions;
}

function hostForStateRoot(stateRoot: string): LocalApplicationHost | null {
  return processLocalApplicationHosts.peek(stateRoot);
}

export function brokerForStateRoot(stateRoot: string) {
  const host = hostForStateRoot(stateRoot);
  if (host === null) {
    throw new ApplicationControlError("control_operation_busy", "application Host is not initialized");
  }
  return host.broker;
}

export function activeForegroundGraphControlForRuntime(
  runtime: CliRuntime,
  sessionId: string,
) {
  return runtime.controlPlaneStateRoot === undefined
    ? null
    : hostForStateRoot(runtime.controlPlaneStateRoot)?.activeOwners.foregroundGraphs.active(sessionId) ?? null;
}

export function activeDelegationControlForRuntime(runtime: CliRuntime, sessionId: string) {
  return runtime.controlPlaneStateRoot === undefined
    ? null
    : hostForStateRoot(runtime.controlPlaneStateRoot)?.activeOwners.delegations.active(sessionId) ?? null;
}

export function abortActiveOwnerCompositeForRuntime(runtime: CliRuntime, sessionId: string) {
  if (runtime.controlPlaneStateRoot === undefined) return null;
  const active = hostForStateRoot(runtime.controlPlaneStateRoot)?.activeOwners.ownerComposites.active(sessionId) ?? null;
  if (active === null) return null;
  active.requestAbort();
  return Object.freeze({
    actionKind: active.actionKind,
    ownerApplicationOperationId: active.ownerApplicationOperationId,
    ownerPreparedActionSha256: active.ownerPreparedActionSha256,
  });
}

export function hasActiveOwnerCompositeForRuntime(runtime: CliRuntime, sessionId: string): boolean {
  return runtime.controlPlaneStateRoot !== undefined &&
    (hostForStateRoot(runtime.controlPlaneStateRoot)?.activeOwners.ownerComposites.active(sessionId) ?? null) !== null;
}

export type TuiSurfaceFatalOwnerOutcomeV1 =
  | Readonly<{
      readonly kind: "signalled_exact_owner";
      readonly ownerApplicationOperationId: string;
      readonly ownerKind: "delegation" | "graph" | "owner_composite" | "run";
    }>
  | Readonly<{ readonly kind: "unknown_owner" }>;

/**
 * The TUI renderer/source is a Host concern. Its fatal path must never invoke
 * a typed human cancellation action, nor a raw process cancellation. Select
 * one process-local owner registered for the exact session and signal only
 * that owner. When no exact owner is provable, leave the ApplicationService
 * operation untouched so its normal reconciliation fails closed.
 */
export function requestTuiSurfaceFatalForRuntime(
  runtime: CliRuntime,
  sessionId: string | null | undefined,
): TuiSurfaceFatalOwnerOutcomeV1 {
  if (runtime.controlPlaneStateRoot === undefined || sessionId === null || sessionId === undefined) {
    return Object.freeze({ kind: "unknown_owner" });
  }
  const reason = Object.freeze({ reason: "tui_surface_fatal" as const });
  const host = hostForStateRoot(runtime.controlPlaneStateRoot);
  if (host === null) return Object.freeze({ kind: "unknown_owner" });
  const run = host.broker.requestHostEmergencyStop(sessionId, reason);
  if (run !== null) {
    return Object.freeze({
      kind: "signalled_exact_owner",
      ownerApplicationOperationId: run.ownerApplicationOperationId,
      ownerKind: "run",
    });
  }
  const graph = host.activeOwners.foregroundGraphs.active(sessionId);
  if (graph !== null) {
    graph.requestHostEmergencyStop(reason);
    return Object.freeze({
      kind: "signalled_exact_owner",
      ownerApplicationOperationId: graph.ownerApplicationOperationId,
      ownerKind: "graph",
    });
  }
  const delegation = host.activeOwners.delegations.active(sessionId);
  if (delegation !== null) {
    delegation.requestHostEmergencyStop(reason);
    return Object.freeze({
      kind: "signalled_exact_owner",
      ownerApplicationOperationId: delegation.ownerApplicationOperationId,
      ownerKind: "delegation",
    });
  }
  const composite = host.activeOwners.ownerComposites.active(sessionId);
  if (composite !== null) {
    composite.requestHostEmergencyStop(reason);
    return Object.freeze({
      kind: "signalled_exact_owner",
      ownerApplicationOperationId: composite.ownerApplicationOperationId,
      ownerKind: "owner_composite",
    });
  }
  return Object.freeze({ kind: "unknown_owner" });
}

/**
 * PHASE21: a surface client identity belongs to the Host process lifecycle,
 * not to one command invocation. Reusing it lets a TUI issue several typed
 * actions without appearing to be a succession of unrelated clients; the
 * transport-specific reconnect generation remains a later surface concern.
 */
export function contextForRuntime(
  plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>,
  _runtime: CliRuntime,
  surface: "cli" | "tui",
): AuthenticatedCallContextV1 {
  return plane.context(surface);
}

export async function registerCurrentRepository(
  plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>,
  context: AuthenticatedCallContextV1,
  runtime: CliRuntime,
  io: CliIO,
): Promise<ApplicationEnvelopeV1<unknown> | { readonly repositoryId: string }> {
  const preview = await plane.repositories.previewRoot(runtime.cwd);
  const existing = (await plane.repositories.list()).find(
    (candidate) => candidate.status === "active" && candidate.canonicalRootIdentitySha256 === preview.canonicalRootIdentitySha256,
  );
  if (existing !== undefined) return Object.freeze({ repositoryId: existing.repositoryId });
  const head = await plane.repositories.head();
  const payload = { root: runtime.cwd };
  const prepared = await plane.actions.prepare(context, {
    actionKind: "repository.register",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: [
      "repository.register.prepare.v1",
      preview.canonicalRootIdentitySha256,
      String(head.revision),
      runtime.randomUUID(),
    ].join("."),
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      catalogScope: plane.repositories.resourceScope,
      expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
      kind: "new_repository",
    },
  });
  if (prepared.status !== "ok" || prepared.result === null) return prepared;
  const reviewRejection = await reviewPreparedBeforeCommit(
    prepared,
    plane,
    runtime,
    io,
    context.surface.surface === "tui" ? "tui" : "cli",
  );
  if (reviewRejection !== null) return reviewRejection;
  const committed = await plane.actions.commit(context, {
    idempotencyKey: `repository.register.commit.v1.${prepared.result.prepared.preparedActionId}`,
    preparedActionId: prepared.result.prepared.preparedActionId,
    preparedActionSha256: prepared.result.prepared.preparedActionSha256,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
  });
  return committed.status === "ok" && committed.resourceScope?.kind === "repository"
    ? Object.freeze({ repositoryId: committed.resourceScope.repositoryId })
    : committed;
}

/**
 * PHASE21: legacy discovery is a typed catalog mutation. The Host action reads
 * and binds the exact first raw event; adapters never write catalog facts or
 * reinterpret historical JSONL principal identity. A legacy-local projection
 * has no authenticated team principal or audit authority and can never be
 * upgraded into a team audit record by the current caller.
 */
export async function adoptLegacySessionThroughApplicationService(
  plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>,
  context: AuthenticatedCallContextV1,
  runtime: CliRuntime,
  repositoryId: string,
  sessionId: string,
  io: CliIO,
): Promise<ApplicationEnvelopeV1<unknown> | { readonly sessionId: string }> {
  const catalog = await plane.sessions.project(repositoryId);
  if (catalog.entries.some((entry) => entry.sessionId === sessionId)) return Object.freeze({ sessionId });
  const payload = Object.freeze({ sessionId });
  const semantic = sha256Canonical({
    action_kind: "session.adopt_legacy",
    catalog_head: catalog.head,
    repository_id: repositoryId,
    schema_version: 1,
    session_id: sessionId,
  });
  const prepared = await plane.actions.prepare(context, {
    actionKind: "session.adopt_legacy",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: context.surface.surface === "tui"
      ? `session.adopt-legacy.prepare.v1.${runtime.randomUUID()}`
      : `session.adopt-legacy.prepare.v1.${semantic}`,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      catalogScope: plane.sessions.resourceScope(repositoryId),
      expectedCatalogVersion: { kind: "revision", revision: catalog.head.revision, sha256: catalog.head.catalogSha256 },
      kind: "new_session",
    },
  });
  if (prepared.status !== "ok" || prepared.result === null) return prepared;
  const reviewRejection = await reviewPreparedBeforeCommit(
    prepared,
    plane,
    runtime,
    io,
    context.surface.surface === "tui" ? "tui" : "cli",
  );
  if (reviewRejection !== null) return reviewRejection;
  const committed = await plane.actions.commit(context, {
    idempotencyKey: `session.adopt-legacy.commit.v1.${semantic}`,
    preparedActionId: prepared.result.prepared.preparedActionId,
    preparedActionSha256: prepared.result.prepared.preparedActionSha256,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
  });
  return committed.status === "ok" &&
      committed.resourceScope?.kind === "session" &&
      committed.resourceScope.sessionId === sessionId
    ? Object.freeze({ sessionId })
    : committed;
}

async function applicationHostForRuntime(runtime: CliRuntime, io: CliIO): Promise<LocalApplicationHost> {
  if (runtime.controlPlaneStateRoot === undefined) throw new TypeError("application control state root is unavailable");
  return processLocalApplicationHosts.getOrCreate({
    stateRoot: runtime.controlPlaneStateRoot,
    createPlane: async (host) => createPhase21ALocalControlPlane({
      activeDelegations: host.activeOwners.delegations,
      broker: host.broker,
      chatExecution: host.chatExecution,
      delivery: host.delivery,
      delegationCompositeOwnerFactory: (signer, activeSessionWriterObserverFactory) => new CliDelegationCompositeOwnerPort({
        activeDelegations: host.activeOwners.delegations,
        activeSessionWriterObserverFactory,
        interaction: createDelegationOwnerInteractionPort(runtime, io),
        runtime: createDelegationOwnerRuntimePort(runtime, io),
        signer,
      }),
      graphCompositeOwnerFactory: (signer) => new CliGraphCompositeOwnerPort({
        activeOwnerComposites: host.activeOwners.ownerComposites,
        foregroundGraphControls: host.activeOwners.foregroundGraphs,
        io,
        runtime,
        signer,
      }),
      graphCancelOwnerFactory: (signer) => new CliGraphCancelOwnerPort({
        foregroundGraphControls: host.activeOwners.foregroundGraphs,
        runtime,
        signer,
      }),
      taskSurfaceOperations: Object.freeze({
        inspectDelegationOperationSidecars: runtime.inspectDelegationOperationSidecars ??
          (() => Promise.resolve(Object.freeze([]))),
        ...(runtime.observeBackgroundWorkerLive === undefined ? {} : {
          observeBackgroundWorkerLive: async (input: Parameters<NonNullable<TaskSurfaceQueryOperationPortV1["observeBackgroundWorkerLive"]>>[0]) => runtime.observeBackgroundWorkerLive!({
            current: input.current,
            repositoryId: input.repositoryId,
            sessionId: input.sessionId,
          }),
        }),
      }),
      launcher: {
        launch: async (input) => Object.freeze({
          exitCode: await executeAgentExecution(
            optionsFromPayload(input.payload, input.surface),
            createAgentExecutionRuntimePort(runtime, io),
            createAgentExecutionPresentationPort(
              io,
              input.payload.verbose,
              input.payload.reportFormat === "json" ? "json" : "text",
            ),
            undefined,
            {
              applicationCommit: input.applicationCommit,
              applicationCancellation: input.applicationCancellation,
              authenticatedMutation: input.authenticatedMutation,
              ...(input.payload.memoryMode === "local"
                ? {
                    localMemory: {
                      canonicalRootIdentitySha256: input.canonicalRootIdentitySha256,
                      ownerPrincipalId: input.applicationCommit.principalId,
                      repositoryId: input.repositoryId,
                      stateRoot: runtime.controlPlaneStateRoot!,
                      workspace: input.repositoryRoot,
                    },
                    afterTerminalPersisted: async () => {
                      const [
                        { Ml1MemoryService },
                        { SqliteEpisodeStore },
                      ] = await Promise.all([
                        // MEMORY-ML1: off 路径不加载 node:sqlite；ML3 local read发生在request前，write仍只在durable terminal后。
                        import("../../memory/product/memory-service.js"),
                        import("../../memory/store/sqlite-episode-store.js"),
                      ]);
                      const store = await SqliteEpisodeStore.create({
                        stateRoot: runtime.controlPlaneStateRoot!,
                      });
                      try {
                        const result = await new Ml1MemoryService({
                          repositoryId: input.repositoryId,
                          scope: Object.freeze({
                            applicationRepositoryId: input.repositoryId,
                            canonicalRootIdentitySha256: input.canonicalRootIdentitySha256,
                            ownerPrincipalId: input.applicationCommit.principalId,
                          }),
                          store,
                          workspace: input.repositoryRoot,
                        }).ingestCompletedRun(input.sessionId, input.runId);
                        if (result.status === "not_admitted") {
                          io.stderr.write(`memory_episode_not_admitted: ${result.reason}\n`);
                        }
                      } finally {
                        store.close();
                      }
                    },
                  }
                : {}),
              modelTask: input.payload.task,
              onRunStarted: input.onRunStarted,
              runId: input.runId,
              sessionId: input.sessionId,
              sessionWorkspace: input.repositoryRoot,
              writer: input.writer,
            },
          ),
        }),
      },
      sessionResumeOwner: host.sessionResumeOwner,
      stateRoot: runtime.controlPlaneStateRoot!,
    }),
  });
}

export async function planeForRuntime(runtime: CliRuntime, io: CliIO) {
  return (await applicationHostForRuntime(runtime, io)).plane;
}

export async function registerChatExecutionForRuntime(input: Readonly<{
  readonly execution: ChatExecutionPortV1;
  readonly payloadSha256: string;
  readonly runtime: CliRuntime;
  readonly io: CliIO;
}>): Promise<() => void> {
  return (await applicationHostForRuntime(input.runtime, input.io))
    .registerChatExecution(input.payloadSha256, input.execution);
}

export async function registerSessionResumeOwnerForRuntime(input: Readonly<{
  readonly io: CliIO;
  readonly owner: SessionResumeOwnerPortV1;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<() => void> {
  return (await applicationHostForRuntime(input.runtime, input.io))
    .registerSessionResumeOwner(input.sessionId, input.owner);
}

export async function disposeApplicationHostForStateRoot(stateRoot: string): Promise<void> {
  await processLocalApplicationHosts.dispose(stateRoot);
}

async function requestRunCancelThroughPlane(input: Readonly<{
  readonly context: AuthenticatedCallContextV1;
  readonly idempotencySeed?: string;
  readonly io: CliIO;
  readonly retryOwnerGenerationSha256?: string;
  readonly plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>;
  readonly repositoryId: string;
  readonly runId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface: "cli" | "tui";
}>): Promise<AgentExitCode> {
  try {
    const retryFence = async (): Promise<"durable" | "retry" | "stop"> => {
      if (input.retryOwnerGenerationSha256 === undefined) return "stop";
      const barrier = await input.plane.sessions.readRunCancelBarrier(
        input.repositoryId,
        input.sessionId,
        input.runId,
      );
      if (
        barrier.owner?.fact.ownerGenerationSha256 !== input.retryOwnerGenerationSha256 ||
        barrier.terminal !== null
      ) return "stop";
      if (barrier.request !== null) return "durable";
      const active = input.plane.broker.activeRunControl(input.sessionId);
      return active !== null &&
          active.runId === input.runId &&
          active.ownerGenerationSha256 === input.retryOwnerGenerationSha256
        ? "retry"
        : "stop";
    };
    let lastTransient: ApplicationEnvelopeV1<unknown> | null = null;
    const maximumAttempts = input.retryOwnerGenerationSha256 === undefined ? 1 : 64;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (attempt > 0) {
        const fence = await retryFence();
        if (fence === "durable") return 0;
        if (fence !== "retry") break;
        await new Promise<void>((resolve) => input.runtime.setTimer(resolve, 10));
      }
      const snapshot = await input.plane.sessionProjection.read({
        repositoryId: input.repositoryId,
        requestedHead: null,
        sessionId: input.sessionId,
      });
      const payload = Object.freeze({ reason: "user" as const, runId: input.runId });
      const prepared = await input.plane.actions.prepare(input.context, {
        actionKind: "run.cancel",
        payload,
        payloadSha256: sha256Canonical(payload),
        // Every retry is a distinct, exact-head prepare. Reusing the original
        // key would recover the stale prepared identity and could never
        // converge after an owner append between prepare and commit.
        prepareIdempotencyKey: input.idempotencySeed === undefined
          ? `run.cancel.prepare.${input.runId}.${snapshot.head.publicHead.sequence}.${input.runtime.randomUUID()}`
          : [
              "run.cancel.prepare",
              input.idempotencySeed,
              sha256Canonical(snapshot.head.publicHead),
              String(attempt),
            ].join("."),
        requestId: input.runtime.randomUUID(),
        schemaVersion: 1,
        target: {
          expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
          kind: "existing_resource",
          resourceScope: snapshot.resourceScope,
        },
      });
      if (prepared.status !== "ok" || prepared.result === null) {
        if (prepared.error?.code === "control_stale_projection") {
          const fence = await retryFence();
          if (fence === "durable") return 0;
          if (fence === "retry") {
            lastTransient = prepared;
            continue;
          }
        }
        return reportApplicationFailure(prepared, input.io);
      }
      const reviewRejection = await reviewPreparedBeforeCommit(
        prepared,
        input.plane,
        input.runtime,
        input.io,
        input.surface,
      );
      if (reviewRejection !== null) {
        if (reviewRejection.error?.code === "control_stale_projection") {
          const fence = await retryFence();
          if (fence === "durable") return 0;
          if (fence === "retry") {
            lastTransient = reviewRejection;
            continue;
          }
        }
        return reportApplicationFailure(reviewRejection, input.io);
      }
      const committed = await input.plane.actions.commit(input.context, {
        idempotencyKey: `run.cancel.commit.${input.runId}.${prepared.result.prepared.preparedActionId}`,
        preparedActionId: prepared.result.prepared.preparedActionId,
        preparedActionSha256: prepared.result.prepared.preparedActionSha256,
        requestId: input.runtime.randomUUID(),
        schemaVersion: 1,
      });
      if (committed.status !== "ok") {
        const operation = await input.plane.operations.findByPreparedAction(
          prepared.result.prepared.preparedActionId,
        );
        if (operation === null && committed.error?.code === "control_stale_projection") {
          const fence = await retryFence();
          if (fence === "durable") return 0;
          if (fence === "retry") {
            lastTransient = committed;
            continue;
          }
        }
        return reportApplicationFailure(committed, input.io);
      }
      input.io.stderr.write(`cancel requested: ${input.runId}\n`);
      return 0;
    }
    const fence = await retryFence();
    if (fence === "durable") return 0;
    if (lastTransient !== null) return reportApplicationFailure(lastTransient, input.io);
    input.io.stderr.write("control_operation_busy: exact active run owner disappeared before cancellation was durable\n");
    return 8;
  } catch (error) {
    if (error instanceof ApplicationControlError) {
      input.io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

/**
 * PHASE21: TUI cancellation first commits an exact run/owner-generation
 * request through the application service. The active owner port signals only
 * after the request event has crossed the session append+sync boundary.
 */
export async function requestActiveRunCancelThroughApplicationService(
  input: Readonly<{ readonly runId: string; readonly sessionId: string }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<AgentExitCode> {
  if (runtime.controlPlaneStateRoot === undefined) return 2;
  const plane = await planeForRuntime(runtime, io);
  const context = contextForRuntime(plane, runtime, "tui");
  const repository = await registerCurrentRepository(plane, context, runtime, io);
  if (!("repositoryId" in repository)) return reportApplicationFailure(repository, io);
  return requestRunCancelThroughPlane({
    context,
    io,
    plane,
    repositoryId: repository.repositoryId,
    runId: input.runId,
    runtime,
    sessionId: input.sessionId,
    surface: "tui",
  });
}

const TERMINAL_OPERATION_STATES = new Set([
  "blocked_stale",
  "blocked_unknown_effect",
  "completed",
  "failed_internal",
  "rejected_known_not_started",
]);

async function waitForExactCliActionOwner(input: Readonly<{
  readonly actionKind: "session.message.submit" | "session.resume";
  readonly isActionSettled: () => boolean;
  readonly preparedActionId: string;
  readonly plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>;
  readonly repositoryId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<Readonly<{ readonly ownerGenerationSha256: string; readonly runId: string }> | null> {
  while (!input.isActionSettled()) {
    const operation = await input.plane.operations.findByPreparedAction(input.preparedActionId);
    const active = input.plane.broker.activePort(input.sessionId)?.runControl;
    if (
      operation !== null &&
      operation.actionKind === input.actionKind &&
      active !== undefined &&
      active.ownerApplicationOperationId === operation.operationId
    ) {
      const barrier = await input.plane.sessions.readRunCancelBarrier(
        input.repositoryId,
        input.sessionId,
        active.runId,
      );
      if (
        barrier.terminal !== null ||
        barrier.request !== null
      ) return null;
      if (
        barrier.owner?.fact.ownerGenerationSha256 === active.ownerGenerationSha256 &&
        barrier.observations.some((observation) => observation.observationKind === "started")
      ) return Object.freeze({
        ownerGenerationSha256: active.ownerGenerationSha256,
        runId: active.runId,
      });
    }
    if (operation !== null && TERMINAL_OPERATION_STATES.has(operation.state)) return null;
    await new Promise<void>((resolve) => {
      input.runtime.setTimer(resolve, 10);
    });
  }
  return null;
}

/**
 * Product CLI SIGINT is a surface action, not execution-core authority. This
 * bridge waits for the exact long-running operation and its durable owner
 * fence, then commits run.cancel through the same typed ApplicationService.
 */
export async function commitCliApplicationActionWithTypedCancellation(input: Readonly<{
  readonly actionKind: "session.message.submit" | "session.resume";
  readonly context: AuthenticatedCallContextV1;
  readonly idempotencyKey: string;
  readonly io: CliIO;
  readonly plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>;
  readonly preparedActionId: string;
  readonly preparedActionSha256: string;
  readonly repositoryId: string;
  readonly requestId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<ApplicationEnvelopeV1<unknown>> {
  let actionSettled = false;
  let cancellationTask: Promise<AgentExitCode | null> | null = null;
  const stopListening = input.runtime.onCancel(() => {
    if (cancellationTask !== null) return;
    cancellationTask = (async () => {
      const owner = await waitForExactCliActionOwner({
        actionKind: input.actionKind,
        isActionSettled: () => actionSettled,
        preparedActionId: input.preparedActionId,
        plane: input.plane,
        repositoryId: input.repositoryId,
        runtime: input.runtime,
        sessionId: input.sessionId,
      });
      if (owner === null) return null;
      return requestRunCancelThroughPlane({
        context: input.context,
        idempotencySeed: `cli-sigint.${input.preparedActionId}`,
        io: input.io,
        plane: input.plane,
        repositoryId: input.repositoryId,
        retryOwnerGenerationSha256: owner.ownerGenerationSha256,
        runId: owner.runId,
        runtime: input.runtime,
        sessionId: input.sessionId,
        surface: "cli",
      });
    })();
  });
  try {
    const committed = await input.plane.actions.commit(input.context, {
      idempotencyKey: input.idempotencyKey,
      preparedActionId: input.preparedActionId,
      preparedActionSha256: input.preparedActionSha256,
      requestId: input.requestId,
      schemaVersion: 1,
    });
    actionSettled = true;
    if (cancellationTask !== null) await cancellationTask;
    return committed;
  } finally {
    actionSettled = true;
    stopListening();
  }
}

export async function commitCliSessionMessageWithTypedCancellation(input: Readonly<{
  readonly context: AuthenticatedCallContextV1;
  readonly idempotencyKey: string;
  readonly io: CliIO;
  readonly plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>;
  readonly preparedActionId: string;
  readonly preparedActionSha256: string;
  readonly repositoryId: string;
  readonly requestId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<ApplicationEnvelopeV1<unknown>> {
  return commitCliApplicationActionWithTypedCancellation({
    ...input,
    actionKind: "session.message.submit",
  });
}

async function submitMessage(input: {
  readonly context: AuthenticatedCallContextV1;
  readonly expectedHead: NonNullable<ApplicationEnvelopeV1<unknown>["ledgerHead"]>;
  readonly io: CliIO;
  readonly options: AgentCommandOptions;
  readonly plane: Awaited<ReturnType<typeof createPhase21ALocalControlPlane>>;
  readonly repositoryId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}): Promise<AgentExitCode> {
  const payload = payloadFromOptions(input.options);
  const resourceScope = {
    kind: "session" as const,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    teamId: null,
  };
  const preparedMessage = await input.plane.actions.prepare(input.context, {
    actionKind: "session.message.submit",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: [
      "session.message.submit.prepare.v1",
      input.repositoryId,
      input.sessionId,
      String(input.expectedHead.sequence),
      input.runtime.randomUUID(),
    ].join("."),
    requestId: input.runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head: input.expectedHead, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope,
    },
  });
  if (preparedMessage.status !== "ok" || preparedMessage.result === null) return reportApplicationFailure(preparedMessage, input.io);
  const reviewRejection = await reviewPreparedBeforeCommit(
    preparedMessage,
    input.plane,
    input.runtime,
    input.io,
    input.options.inputSurface ?? "cli",
  );
  if (reviewRejection !== null) return reportApplicationFailure(reviewRejection, input.io);
  const commitInput = {
    context: input.context,
    idempotencyKey: `session.message.submit.commit.v1.${preparedMessage.result.prepared.preparedActionId}`,
    io: input.io,
    plane: input.plane,
    preparedActionId: preparedMessage.result.prepared.preparedActionId,
    preparedActionSha256: preparedMessage.result.prepared.preparedActionSha256,
    repositoryId: input.repositoryId,
    requestId: input.runtime.randomUUID(),
    runtime: input.runtime,
    sessionId: input.sessionId,
  } as const;
  const committed = (input.options.inputSurface ?? "cli") === "cli"
    ? await commitCliSessionMessageWithTypedCancellation(commitInput)
    : await input.plane.actions.commit(input.context, {
        idempotencyKey: commitInput.idempotencyKey,
        preparedActionId: commitInput.preparedActionId,
        preparedActionSha256: commitInput.preparedActionSha256,
        requestId: commitInput.requestId,
        schemaVersion: 1,
      });
  if (committed.status !== "ok" || committed.result === null) return reportApplicationFailure(committed, input.io);
  const result = committed.result as Readonly<{ readonly exitCode?: unknown }>;
  return typeof result.exitCode === "number" && [0, 1, 2, 3, 4, 5, 6, 7, 8, 130].includes(result.exitCode)
    ? result.exitCode as AgentExitCode
    : 1;
}

/**
 * Product Agent starts use the typed prepare/commit service. Direct execution
 * exists only behind the explicit test/eval DomainHarness capability.
 */
export async function executeAgentThroughApplicationService(
  options: AgentCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<AgentExitCode> {
  if (isDomainHarnessRuntime(runtime)) {
    return executeAgentExecution(
      options,
      createAgentExecutionRuntimePort(runtime, io),
      createAgentExecutionPresentationPort(
        io,
        options.verbose,
        options.reportFormat === "json" ? "json" : "text",
      ),
    );
  }
  const plane = await planeForRuntime(runtime, io);
  const context = contextForRuntime(plane, runtime, options.inputSurface ?? "cli");
  const repository = await registerCurrentRepository(plane, context, runtime, io);
  if (!("repositoryId" in repository)) return reportApplicationFailure(repository, io);
  const sessionHead = await plane.sessions.head(repository.repositoryId);
  const preparedSession = await plane.actions.prepare(context, {
    actionKind: "session.create",
    payload: {},
    payloadSha256: sha256Canonical({}),
    prepareIdempotencyKey: [
      "session.create.prepare.v1",
      repository.repositoryId,
      String(sessionHead.revision),
      sessionHead.catalogSha256,
      runtime.randomUUID(),
    ].join("."),
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      catalogScope: plane.sessions.resourceScope(repository.repositoryId),
      expectedCatalogVersion: { kind: "revision", revision: sessionHead.revision, sha256: sessionHead.catalogSha256 },
      kind: "new_session",
    },
  });
  if (preparedSession.status !== "ok" || preparedSession.result === null) return reportApplicationFailure(preparedSession, io);
  const reviewRejection = await reviewPreparedBeforeCommit(
    preparedSession,
    plane,
    runtime,
    io,
    options.inputSurface ?? "cli",
  );
  if (reviewRejection !== null) return reportApplicationFailure(reviewRejection, io);
  const created = await plane.actions.commit(context, {
    idempotencyKey: `session.create.commit.v1.${preparedSession.result.prepared.preparedActionId}`,
    preparedActionId: preparedSession.result.prepared.preparedActionId,
    preparedActionSha256: preparedSession.result.prepared.preparedActionSha256,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
  });
  if (
    created.status !== "ok" ||
    created.resourceScope?.kind !== "session" ||
    created.ledgerHead === null
  ) return reportApplicationFailure(created, io);
  return submitMessage({
    context,
    expectedHead: created.ledgerHead,
    io,
    options,
    plane,
    repositoryId: repository.repositoryId,
    runtime,
    sessionId: created.resourceScope.sessionId,
  });
}

export async function executeExistingSessionAgentThroughApplicationService(
  input: {
    readonly expectedSessionSeq: number;
    readonly options: AgentCommandOptions;
    readonly sessionId: string;
  },
  runtime: CliRuntime,
  io: CliIO,
): Promise<AgentExitCode> {
  if (runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("existing-session application adapter requires a Host control state root");
  }
  const plane = await planeForRuntime(runtime, io);
  const context = contextForRuntime(plane, runtime, input.options.inputSurface ?? "cli");
  const repository = await registerCurrentRepository(plane, context, runtime, io);
  if (!("repositoryId" in repository)) return reportApplicationFailure(repository, io);
  const adopted = await adoptLegacySessionThroughApplicationService(
    plane,
    context,
    runtime,
    repository.repositoryId,
    input.sessionId,
    io,
  );
  if ("status" in adopted) return reportApplicationFailure(adopted, io);
  const snapshot = await plane.sessionProjection.read({
    repositoryId: repository.repositoryId,
    requestedHead: null,
    sessionId: input.sessionId,
  });
  if (snapshot.head.publicHead.sequence !== input.expectedSessionSeq) {
    io.stderr.write(`stale_snapshot: expected session sequence ${String(input.expectedSessionSeq)}, current ${String(snapshot.head.publicHead.sequence)}\n`);
    return 2;
  }
  return submitMessage({
    context,
    expectedHead: snapshot.head.publicHead,
    io,
    options: input.options,
    plane,
    repositoryId: repository.repositoryId,
    runtime,
    sessionId: input.sessionId,
  });
}
