import type { AgentCommandOptions } from "../agent/agent-types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { isDomainHarnessRuntime } from "../coordination/domain-harness.js";
import { executeAgent } from "../commands/agent.js";
import {
  abortActiveOwnerCompositeForRuntime,
  activeDelegationControlForRuntime,
  executeAgentThroughApplicationService,
  executeExistingSessionAgentThroughApplicationService,
  hasActiveOwnerCompositeForRuntime,
  requestTuiSurfaceFatalForRuntime,
  requestActiveRunCancelThroughApplicationService,
} from "../control-plane/adapters/agent-cli-adapter.js";
import {
  executeTaskActionThroughApplicationService,
  registerTaskPreparedActionReviewer,
  requestActiveGraphCancelThroughApplicationService,
} from "../control-plane/adapters/task-cli-adapter.js";
import {
  createSessionsResumePhase9ExecutionPort,
  executeSessionsResume,
} from "../commands/sessions.js";
import {
  executeSessionResumeThroughRuntimeAdapter,
  type SessionResumeRuntimeRequestV1,
} from "../control-plane/adapters/session-resume-runtime-adapter.js";
import {
  renderTaskCommandFailure,
  taskMutationContext,
  taskWriterFactory,
} from "../commands/task-control-plane-command.js";
import { GoalManager } from "../goals/goal-manager.js";
import { PlanFileLoader } from "../plans/plan-file-loader.js";
import { PlanStore } from "../plans/plan-store.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { SessionCatalog } from "../sessions/session-catalog.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
} from "../events/phase16-run-event-extension.js";
import { ApprovalController } from "./approval-controller.js";
import { PersistedEventSource } from "./persisted-event-source.js";
import { TuiAbortBridge } from "./tui-abort-bridge.js";
import { requestTuiHumanCancel } from "./tui-human-cancel-authority.js";
import { TuiApprovalPrompt } from "./tui-approval-prompt.js";
import { SessionFileWatcher } from "./session-file-watcher.js";
import { createTuiSessionProjectionPort } from "./tui-session-projection-port.js";
import type { TuiSessionProjectionPort } from "./tui-session-projection-port.js";
import {
  executeTuiDelegationApplicationAction,
  executeTuiGraphApplicationAction,
} from "./tui-application-action-port.js";
import type { ProductSessionProjectionBodyV1 } from "../control-plane/session-projection-service.js";
import {
  TuiController,
} from "./tui-controller.js";
import {
  createTuiApplicationFacade,
  type TuiCoreRunResult,
  type TuiSessionSnapshot,
} from "./tui-application-facade.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import type {
  Phase16MutationIntent,
  Phase16StartIntent,
} from "../coordination/phase16-user-intent.js";
import { RepositoryInvalidationWatcher } from "../repository-intelligence/repository-invalidation-watcher.js";
import { RepositoryRefreshCoordinator } from "../repository-intelligence/repository-refresh-coordinator.js";

export interface TuiCommandOptions
  extends Omit<AgentCommandOptions, "task" | "verbose"> {
  readonly allowDegradedResume: boolean;
  readonly inspectSessionId?: string;
  readonly resumeSessionId: string | undefined;
  readonly task: string | undefined;
}

const MAX_EPHEMERAL_DIAGNOSTIC_CHARS = 2_048;

async function captureCoreRun(
  run: (io: CliIO) => Promise<number>,
): Promise<TuiCoreRunResult> {
  let diagnostic = "";
  const io: CliIO = {
    stderr: {
      write: (value) => {
        if (diagnostic.length >= MAX_EPHEMERAL_DIAGNOSTIC_CHARS) return;
        diagnostic += value.slice(
          0,
          MAX_EPHEMERAL_DIAGNOSTIC_CHARS - diagnostic.length,
        );
      },
    },
    // Durable model/tool facts reach the TUI through PersistedEventSource.
    stdout: { write: () => undefined },
  };
  const exitCode = await run(io);
  const normalized = diagnostic.replace(/\s+/gu, " ").trim();
  return { diagnostic: normalized.length === 0 ? null : normalized, exitCode };
}

function usage(io: CliIO, message: string): 2 {
  io.stderr.write(`usage/config error: ${message}\n`);
  return 2;
}

function agentOptions(
  options: TuiCommandOptions,
  task: string,
  mode?: "build" | "plan",
  modeSource?: "explicit_tui" | "tui_default",
): AgentCommandOptions {
  return {
    artifactCaptureBytes: options.artifactCaptureBytes,
    commandApproval: options.commandApproval,
    commandTimeoutMs: options.commandTimeoutMs,
    completionPolicy: options.completionPolicy,
    contextCompactionThreshold: options.contextCompactionThreshold,
    contextReserveOutputTokens: options.contextReserveOutputTokens,
    contextWindowTokens: options.contextWindowTokens,
    editApproval: options.editApproval,
    executor: options.executor,
    dockerImage: options.dockerImage,
    maxDurationMs: options.maxDurationMs,
    maxCommandOutputBytes: options.maxCommandOutputBytes,
    maxSteps: options.maxSteps,
    maxTokens: options.maxTokens,
    maxToolOutputBytes: options.maxToolOutputBytes,
    mcpServerIds: options.mcpServerIds,
    mcpPromptArgumentsJson: options.mcpPromptArgumentsJson,
    mcpPromptSelection: options.mcpPromptSelection,
    ...(mode === undefined
      ? {}
      : {
          inputSurface: "tui" as const,
          mode,
          ...(modeSource === undefined ? {} : { modeSource }),
        }),
    model: options.model,
    policyConfig: options.policyConfig,
    policyProfile: options.policyProfile,
    provider: options.provider,
    reportFormat: options.reportFormat,
    requireVerification: options.requireVerification,
    requestTimeoutMs: options.requestTimeoutMs,
    sandboxCpus: options.sandboxCpus,
    sandboxMemoryMiB: options.sandboxMemoryMiB,
    sandboxPids: options.sandboxPids,
    sandboxTmpMiB: options.sandboxTmpMiB,
    skillArguments: options.skillArguments,
    skillSelections: options.skillSelections,
    task,
    taskProfile:
      mode === "plan"
        ? "read-only"
        : mode === "build"
          ? "coding"
          : options.taskProfile,
    verbose: false,
  };
}

function intentSession(
  intent: Phase16MutationIntent,
): { readonly expectedSessionSeq: number; readonly sessionId: string } {
  if (intent.sessionId === null || intent.expectedSessionSeq === null) {
    throw new RangeError("Phase 16 mutation requires an exact session snapshot");
  }
  return {
    expectedSessionSeq: intent.expectedSessionSeq,
    sessionId: intent.sessionId,
  };
}

async function executeTuiMutation(
  intent: Phase16MutationIntent,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const binding = intentSession(intent);
    if (!isDomainHarnessRuntime(runtime)) {
      const common = {
        expectedSessionSeq: binding.expectedSessionSeq,
        io,
        runtime,
        sessionId: binding.sessionId,
        surface: "tui" as const,
      };
      switch (intent.type) {
        case "revise_goal":
          return (await executeTaskActionThroughApplicationService({
            ...common,
            actionKind: "goal.propose",
            payload: {
              baseRevision: intent.baseRevision,
              goalId: intent.goalId,
              objective: intent.objective,
              operation: "revise",
            },
          })).exitCode;
        case "abandon_goal":
          return (await executeTaskActionThroughApplicationService({
            ...common,
            actionKind: "goal.decide",
            payload: {
              decision: "abandon",
              goalId: intent.goalId,
              reason: intent.reason,
              revision: intent.revision,
            },
          })).exitCode;
        case "approve_plan":
          return (await executeTaskActionThroughApplicationService({
            ...common,
            actionKind: "plan.decide",
            payload: {
              decision: "approve",
              goalId: intent.goalId,
              goalRevision: intent.goalRevision,
              planId: intent.planId,
              revision: intent.revision,
              sha256: intent.sha256,
            },
          })).exitCode;
        case "reject_plan":
          return (await executeTaskActionThroughApplicationService({
            ...common,
            actionKind: "plan.decide",
            payload: {
              decision: "reject",
              goalId: intent.goalId,
              goalRevision: intent.goalRevision,
              planId: intent.planId,
              reason: intent.reason,
              revision: intent.revision,
              sha256: intent.sha256,
            },
          })).exitCode;
        case "replace_plan_from_file": {
          const editablePlan = await new PlanFileLoader().load(runtime.cwd, intent.path);
          return (await executeTaskActionThroughApplicationService({
            ...common,
            actionKind: "plan.propose",
            payload: {
              base: intent.base === null
                ? null
                : {
                    planId: intent.base.planId,
                    revision: intent.base.revision,
                    sha256: intent.base.planSha256,
                  },
              editablePlan,
              goalId: intent.goalId,
              goalRevision: intent.goalRevision,
            },
          })).exitCode;
        }
      }
    }
    const context = taskMutationContext(
      runtime,
      binding.sessionId,
      "tui",
      binding.expectedSessionSeq,
    );
    const writerFactory = taskWriterFactory(runtime);
    switch (intent.type) {
      case "revise_goal":
        await new GoalManager(writerFactory).reviseActiveGoal({
          baseRevision: intent.baseRevision,
          context,
          goalId: intent.goalId,
          objective: intent.objective,
        });
        return 0;
      case "abandon_goal":
        await new GoalManager(writerFactory).abandonActiveGoal({
          context,
          goalId: intent.goalId,
          reason: intent.reason,
          revision: intent.revision,
        });
        return 0;
      case "approve_plan":
        await new PlanStore(writerFactory).approveDraft({
          context,
          goalId: intent.goalId,
          goalRevision: intent.goalRevision,
          planId: intent.planId,
          revision: intent.revision,
          sha256: intent.sha256,
        });
        return 0;
      case "reject_plan":
        await new PlanStore(writerFactory).rejectDraft({
          context,
          goalId: intent.goalId,
          goalRevision: intent.goalRevision,
          planId: intent.planId,
          reason: intent.reason,
          revision: intent.revision,
          sha256: intent.sha256,
        });
        return 0;
      case "replace_plan_from_file": {
        const editablePlan = await new PlanFileLoader().load(
          runtime.cwd,
          intent.path,
        );
        await new PlanStore(writerFactory).replaceDraft({
          base:
            intent.base === null
              ? null
              : {
                  planId: intent.base.planId,
                  revision: intent.base.revision,
                  sha256: intent.base.planSha256,
                },
          context,
          editablePlan,
          goalId: intent.goalId,
          goalRevision: intent.goalRevision,
        });
        return 0;
      }
    }
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

function allocateRunId(
  session: ReturnType<typeof reconstructMultiRunSession>,
  runtime: CliRuntime,
): string {
  const used = new Set(session.runs.map((run) => run.runId));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = runtime.randomUUID();
    if (candidate !== session.sessionId && !used.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique TUI run id");
}

async function executeFreshTaskRun(
  input: {
    readonly expectedSessionSeq: number;
    readonly mode: "build" | "plan";
    readonly modeSource: "explicit_tui" | "tui_default";
    readonly modelTask: string;
    readonly options: TuiCommandOptions;
    readonly sessionId: string;
  },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  const runOptions = agentOptions(
    input.options,
    input.modelTask,
    input.mode,
    input.modeSource,
  );
  if (!isDomainHarnessRuntime(runtime)) {
    return executeExistingSessionAgentThroughApplicationService({
      expectedSessionSeq: input.expectedSessionSeq,
      options: runOptions,
      sessionId: input.sessionId,
    }, runtime, io);
  }
  const writer = await V2SessionWriter.openExisting(
    runtime.cwd,
    input.sessionId,
    { createEventId: runtime.randomUUID, timestamp: runtime.timestamp },
  );
  runtime.observeSessionWriter?.(writer);
  const session = reconstructMultiRunSession(writer.events);
  if (session.taskState.lastSessionSeq !== input.expectedSessionSeq) {
    await writer.close();
    io.stderr.write(
      `stale_snapshot: expected session sequence ${String(input.expectedSessionSeq)}, current ${String(session.taskState.lastSessionSeq)}\n`,
    );
    return 2;
  }
  const activeGoal = session.taskState.goals.find(
    (goal) => goal.content.goalId === session.taskState.activeGoalId,
  );
  if (activeGoal?.status !== "active") {
    await writer.close();
    io.stderr.write("active_goal_required: an active Goal is required\n");
    return 2;
  }
  return executeAgent(
    runOptions,
    runtime,
    io,
    undefined,
    {
      modelTask: input.modelTask,
      runId: allocateRunId(session, runtime),
      sessionId: input.sessionId,
      writer,
    },
  );
}

function continuationFields(
  taskState: NonNullable<ProductSessionProjectionBodyV1["taskState"]>,
): Pick<
  SessionResumeRuntimeRequestV1,
  "continueApprovedPlan" | "planRevision" | "planSha256"
> {
  const current = taskState.currentApprovedPlan;
  return current === null
    ? {}
    : {
        continueApprovedPlan: true,
        planRevision: String(current.revision),
        planSha256: current.planSha256,
      };
}

async function executeTuiSessionResume(
  request: SessionResumeRuntimeRequestV1,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  // Direct Phase 9 execution is available only to the explicit DomainHarness.
  if (isDomainHarnessRuntime(runtime)) {
    return executeSessionsResume(request, runtime, io);
  }
  const result = await executeSessionResumeThroughRuntimeAdapter({
    io,
    phase9: createSessionsResumePhase9ExecutionPort(runtime, io),
    request,
    runtime,
  });
  if (result.diagnostic !== null && result.diagnostic.code !== "session_resume_owner_rejected") {
    io.stderr.write(`${result.diagnostic.code}: ${result.diagnostic.message}\n`);
  }
  return result.exitCode;
}

function goalHasStartedRun(
  session: Pick<ProductSessionProjectionBodyV1, "runs">,
  goalId: string,
  goalRevision: number,
): boolean {
  return session.runs.some((run) => run.goalId === goalId && run.goalRevision === goalRevision);
}

function legacyTuiStartProjection(
  session: Awaited<ReturnType<SessionCatalog["read"]>>,
): Pick<ProductSessionProjectionBodyV1, "runs" | "taskState"> {
  return Object.freeze({
    runs: Object.freeze(session.runs.map((run) => {
      const binding = phase16RunBindingSchema.safeParse(Object.fromEntries(
        PHASE16_RUN_BINDING_KEYS.map((key) => [key, run.started.data[key]]),
      ));
      return Object.freeze({
        endSessionSeq: run.endSessionSeq,
        goalId: binding.success ? binding.data.goal_id : null,
        goalRevision: binding.success ? binding.data.goal_revision : null,
        runId: run.runId,
        startSessionSeq: run.startSessionSeq,
        status: run.status,
      });
    })),
    taskState: session.taskState,
  });
}

async function executeTuiStart(
  intent: Phase16StartIntent,
  selectedMode: "build" | "plan",
  modeSource: "explicit_tui" | "tui_default",
  options: TuiCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
  typedSessionPort: TuiSessionProjectionPort | null,
): Promise<number> {
  try {
    const catalog = typedSessionPort === null ? new SessionCatalog(runtime.cwd) : null;
    if (intent.type === "submit_idle_message" && intent.sessionId === null) {
      return executeAgentThroughApplicationService(
        agentOptions(options, intent.text, selectedMode, modeSource),
        runtime,
        io,
      );
    }
    if (intent.type === "start_new_goal" && intent.sessionId === null) {
      return executeAgentThroughApplicationService(
        agentOptions(options, intent.text, selectedMode, modeSource),
        runtime,
        io,
      );
    }
    if (intent.sessionId === null || intent.expectedSessionSeq === null) {
      io.stderr.write("stale_snapshot: existing run requires a session binding\n");
      return 2;
    }

    let expectedSessionSeq = intent.expectedSessionSeq;
    let message: string | undefined;
    let mode = selectedMode;
    if (intent.type === "start_new_goal") {
      if (isDomainHarnessRuntime(runtime)) {
        const writerFactory = taskWriterFactory(runtime);
        await new GoalManager(writerFactory).startNewGoal({
          context: taskMutationContext(
            runtime,
            intent.sessionId,
            "tui",
            expectedSessionSeq,
          ),
          objective: intent.text,
          parentGoalId: null,
          replaceActive:
            intent.currentGoalId === null || intent.currentGoalRevision === null
              ? null
              : {
                  confirmedAbandon: true,
                  goalId: intent.currentGoalId,
                  revision: intent.currentGoalRevision,
                },
        });
        const afterGoal = await catalog!.read(intent.sessionId);
        expectedSessionSeq = afterGoal.taskState.lastSessionSeq;
      } else {
        const application = await executeTaskActionThroughApplicationService({
          actionKind: "goal.propose",
          expectedSessionSeq,
          io,
          payload: {
            objective: intent.text,
            operation: "start_new",
            parentGoalId: null,
            replaceActive:
              intent.currentGoalId === null || intent.currentGoalRevision === null
                ? null
                : {
                    confirmedAbandon: true,
                    goalId: intent.currentGoalId,
                    revision: intent.currentGoalRevision,
                  },
          },
          runtime,
          sessionId: intent.sessionId,
          surface: "tui",
        });
        if (application.exitCode !== 0 || application.envelope.ledgerHead === null) {
          return application.exitCode;
        }
        expectedSessionSeq = application.envelope.ledgerHead.sequence;
      }
      message = intent.text;
    } else if (intent.type === "submit_idle_message") {
      message = intent.text;
    } else {
      mode = intent.mode;
    }

    const session: Pick<ProductSessionProjectionBodyV1, "runs" | "taskState"> = typedSessionPort === null
      ? legacyTuiStartProjection(await catalog!.read(intent.sessionId))
      : (await typedSessionPort.load(intent.sessionId)).projection;
    const taskState = session.taskState;
    if (taskState === null) {
      io.stderr.write("active_goal_required: this session has no task-state projection\n");
      return 2;
    }
    const activeGoal = taskState.goals.find(
      (goal) => goal.content.goalId === taskState.activeGoalId,
    );
    if (activeGoal?.status !== "active") {
      io.stderr.write("active_goal_required: an active Goal is required\n");
      return 2;
    }
    if (
      mode === "build" &&
      taskState.pendingDraft !== null
    ) {
      io.stderr.write(
        "plan_approval_required: reject or approve the pending Plan before Build\n",
      );
      return 2;
    }
    if (intent.type === "start_run_without_message") {
      if (
        intent.reason === "retry_goal_start" &&
        goalHasStartedRun(
          session,
          activeGoal.content.goalId,
          activeGoal.content.revision,
        )
      ) {
        io.stderr.write(
          "retry_goal_start_invalid: this Goal already has a durable run; use /continue\n",
        );
        return 2;
      }
      if (
        intent.reason === "approved_plan_build" &&
        (mode !== "build" ||
          taskState.currentApprovedPlan === null ||
          taskState.pendingDraft !== null)
      ) {
        io.stderr.write(
          "approved_plan_build_invalid: an exact approved Plan with no pending draft is required\n",
        );
        return 2;
      }
    }
    if (session.runs.length === 0) {
      return executeFreshTaskRun(
        {
          expectedSessionSeq,
          mode,
          modeSource,
          modelTask: message ?? activeGoal.content.objective,
          options,
          sessionId: intent.sessionId,
        },
        runtime,
        io,
      );
    }

    const continuePlan =
      mode === "build" && taskState.currentApprovedPlan !== null
        ? continuationFields(taskState)
        : {};
    return executeTuiSessionResume(
      {
        allowDegradedResume: options.allowDegradedResume,
        ...continuePlan,
        expectedSessionSeq,
        inputSurface: "tui",
        message,
        mode,
        modeSource,
        policyConfig: options.policyConfig,
        policyProfile: options.policyProfile,
        sessionId: intent.sessionId,
      },
      runtime,
      io,
    );
  } catch (error) {
    return renderTaskCommandFailure(error, io);
  }
}

export async function executeTui(
  options: TuiCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  if (options.task !== undefined && (options.resumeSessionId !== undefined || options.inspectSessionId !== undefined)) {
    return usage(io, "task, --resume, and --inspect-session are mutually exclusive");
  }
  if (options.resumeSessionId !== undefined && options.inspectSessionId !== undefined) {
    return usage(io, "--resume and --inspect-session are mutually exclusive");
  }
  if (
    options.mode !== undefined &&
    options.mode !== "plan" &&
    options.mode !== "build"
  ) {
    return usage(io, "agent mode must be plan or build");
  }
  const host = runtime.tuiHost;
  if (host === undefined || !host.stdinIsTTY || !host.stdoutIsTTY) {
    return usage(
      io,
      "born tui requires interactive stdin/stdout; use born agent instead",
    );
  }

  const abortBridge = new TuiAbortBridge();
  const controllerRef: { current?: TuiController } = {};
  const source = new PersistedEventSource({
    onEvent: (event) => controllerRef.current?.acceptPersistedEvent(event),
    onFatal: (error) => {
      io.stderr.write(`tui_event_source_fatal: ${error.code}: ${error.message}\n`);
      controllerRef.current?.handleSourceFatal();
    },
  });
  const approvalPrompt = new TuiApprovalPrompt(() => {
    if (controllerRef.current === undefined) {
      throw new Error("TUI approval prompt started before its controller");
    }
    return controllerRef.current.view;
  });
  let typedSessionPort: TuiSessionProjectionPort | null = null;
  const tuiRuntime: CliRuntime = {
    ...runtime,
    createApprovalPrompt: () => approvalPrompt,
    observeSessionWriter: (writer) => {
      runtime.observeSessionWriter?.(writer);
      // Product TUI refreshes through typed session queries. This legacy
      // callback remains an invalidation hint only and never exposes writer
      // events to the presentation source.
      if (typedSessionPort === null) source.observe(writer);
    },
    onCancel: abortBridge.onCancel,
  };
  // The process-local Application Host captures its owner ports when it is
  // first created for a state root. Bootstrap every TUI query and mutation
  // through the TUI runtime so that a read-only projection cannot initialize
  // the Host with the underlying CLI approval/presentation ports.
  if (!isDomainHarnessRuntime(runtime)) {
    typedSessionPort = await createTuiSessionProjectionPort(tuiRuntime, io);
  }
  const catalog = typedSessionPort === null ? new SessionCatalog(runtime.cwd) : null;
  const sessionFileWatcher = new SessionFileWatcher(runtime.cwd);
  let repositoryRefresh:
    | {
        readonly coordinator: RepositoryRefreshCoordinator;
        readonly service: Awaited<ReturnType<NonNullable<CliRuntime["createRepositoryNavigationService"]>>>;
      }
    | undefined;
  const getRepositoryRefresh = async () => {
    if (repositoryRefresh !== undefined) return repositoryRefresh;
    if (runtime.createRepositoryNavigationService === undefined) {
      throw new Error("repository navigation is unavailable");
    }
    const service = await runtime.createRepositoryNavigationService(runtime.cwd, []);
    const coordinator = new RepositoryRefreshCoordinator(service, {
      onState: (state) => controllerRef.current?.acceptRepositoryJobState(state),
    });
    repositoryRefresh = { coordinator, service };
    return repositoryRefresh;
  };
  const continuousPhase16 = runtime.supportsPhase16TaskState === true;
  let nextSkillSelections = [...(options.skillSelections ?? [])];
  let nextSkillArguments = options.skillArguments;
  let nextMcpPromptSelection = options.mcpPromptSelection;
  let nextMcpPromptArgumentsJson = options.mcpPromptArgumentsJson;
  const takeNextRunOptions = (): TuiCommandOptions => {
    const selected: TuiCommandOptions = {
      ...options,
      mcpPromptArgumentsJson: nextMcpPromptArgumentsJson,
      mcpPromptSelection: nextMcpPromptSelection,
      skillArguments: nextSkillArguments,
      skillSelections: nextSkillSelections,
    };
    nextMcpPromptSelection = undefined;
    nextMcpPromptArgumentsJson = undefined;
    nextSkillSelections = [];
    nextSkillArguments = undefined;
    return selected;
  };
  const core = createTuiApplicationFacade({
    activeDelegationOwner: () => {
      const sessionId = controllerRef.current?.view.session.id;
      return sessionId !== null && sessionId !== undefined &&
        activeDelegationControlForRuntime(tuiRuntime, sessionId) !== null;
    },
    activeOwnerComposite: () => {
      const sessionId = controllerRef.current?.view.session.id;
      return sessionId !== null && sessionId !== undefined &&
        hasActiveOwnerCompositeForRuntime(tuiRuntime, sessionId);
    },
    abortActiveOwnerRun: () => {
      // Renderer/source fatal is Host-owned and must not masquerade as Ctrl-C.
      // The selector is exact-session-bound and deliberately does nothing when
      // the current ApplicationService owner cannot be proven.
      requestTuiSurfaceFatalForRuntime(tuiRuntime, controllerRef.current?.view.session.id);
    },
    cancelActiveRun: () => {
      const view = controllerRef.current?.view;
      const graph = view?.taskExecution;
      if (
        !isDomainHarnessRuntime(runtime) && view?.session.id !== null &&
        view?.session.id !== undefined && graph !== null && graph !== undefined &&
        graph.status === "running"
      ) {
        void captureCoreRun((coreIo) => requestActiveGraphCancelThroughApplicationService({
          io: coreIo,
          reason: "TUI interrupt requested foreground Graph cancellation",
          revision: graph.graph.revision,
          runtime: tuiRuntime,
          sessionId: view.session.id!,
          sha256: graph.graph.graphSha256,
          surface: "tui",
        }).then((result) => result.exitCode));
        return;
      }
      const activeDelegationOwner = view?.session.id === null || view?.session.id === undefined
        ? null
        : activeDelegationControlForRuntime(tuiRuntime, view.session.id);
      const delegation = [...(view?.delegations.revisions ?? [])].reverse().find((revision) =>
        ["active", "waiting_approval", "cancelling", "reconciling"].includes(revision.status) ||
        (activeDelegationOwner?.delegationId === revision.delegationId && revision.status === "queued")
      );
      if (
        !isDomainHarnessRuntime(runtime) && view?.session.id !== null &&
        view?.session.id !== undefined && delegation !== undefined
      ) {
        void captureCoreRun((coreIo) => executeTuiDelegationApplicationAction({
          action: "cancel",
          delegationId: delegation.delegationId,
          expectedSessionSeq: view.session.lastSessionSeq,
          reason: "TUI interrupt requested delegated child cancellation",
          revision: delegation.delegationRevision,
          sessionId: view.session.id!,
          sha256: delegation.delegationSha256,
        }, tuiRuntime, coreIo).then((result) => result.exitCode));
        return;
      }
      if (
        !isDomainHarnessRuntime(runtime) && view?.session.id !== null &&
        view?.session.id !== undefined &&
        abortActiveOwnerCompositeForRuntime(tuiRuntime, view.session.id) !== null
      ) {
        // Owner-internal composite families have no public cancel action in
        // Phase 21A. The process-local registry exact-binds this signal to the
        // active ApplicationService operation; the effect runtime's final
        // admission fence decides whether cancellation is still pre-effect.
        return;
      }
      const exactTarget = view?.session.id !== null && view?.session.id !== undefined &&
          view.run !== null && view.run.status === "running"
        ? Object.freeze({ runId: view.run.id, sessionId: view.session.id })
        : null;
      requestTuiHumanCancel({
        applicationControlEnabled: !isDomainHarnessRuntime(runtime),
        exactTarget,
        legacyAbort: () => abortBridge.cancelActiveRun(),
        report: (diagnostic) => io.stderr.write(`${diagnostic}\n`),
        request: (target) => captureCoreRun((coreIo) =>
          requestActiveRunCancelThroughApplicationService(target, tuiRuntime, coreIo)),
      });
    },
    cancelRepositoryRefresh: () => repositoryRefresh?.coordinator.cancel(),
    loadSession: async (sessionId) => typedSessionPort === null
      ? (await catalog!.read(sessionId)).events as readonly TuiPersistedEvent[]
      : typedSessionPort.load(sessionId),
    delegationCommand: (intent) => executeTuiDelegationApplicationAction(intent, tuiRuntime, io),
    graphCommand: (intent) => executeTuiGraphApplicationAction(intent, tuiRuntime, io),
    selectMcpPrompt: async (selector: string, argumentsJson: string | undefined) => {
      const { parseExplicitMcpPromptSelection } = await import("../mcp/mcp-prompt-selection.js");
      const selection = parseExplicitMcpPromptSelection({
        argumentsJson,
        selectedServerIds: options.mcpServerIds ?? [],
        selector,
      });
      if (selection === undefined) throw new Error("MCP prompt selection is required");
      nextMcpPromptSelection = selection.selector;
      nextMcpPromptArgumentsJson = argumentsJson;
      return selection.selector;
    },
    ...(typedSessionPort === null ? {} : { typedSessionQueries: true }),
    ...(runtime.createPluginLifecycle === undefined
      ? {}
      : {
          listPlugins: async () => {
            const plugins = await runtime.createPluginLifecycle!(runtime.cwd).list();
            if (plugins.length === 0) return "Plugins: none installed.";
            return `Plugins: ${plugins.map((plugin) =>
              `${plugin.pluginId}@${plugin.pluginVersion}#${plugin.pluginSha256.slice(0, 12)}:${plugin.enabled ? "enabled-next-run" : "disabled"}`
            ).join(" | ")}`;
          },
        }),
    ...(runtime.createCapabilityPlatform === undefined
      ? {}
      : {
          selectSkill: async (selector: string, argumentsText: string) => {
            const registry = await runtime.createCapabilityPlatform!(runtime.cwd).buildRegistry();
            const record = registry.resolveUniqueReadOnly(selector);
            if (!record.enabled || record.identity.kind !== "skill") {
              throw new Error("selector must resolve to one enabled Skill");
            }
            nextSkillSelections = [record.identity.qualifiedId];
            nextSkillArguments = argumentsText;
            return record.identity.qualifiedId;
          },
        }),
    ...(continuousPhase16
      ? {
          mutateIntent: (intent: Phase16MutationIntent) =>
            captureCoreRun((coreIo) =>
              executeTuiMutation(intent, tuiRuntime, coreIo),
            ),
        }
      : {}),
    resumeSession: (sessionId, message) =>
      captureCoreRun((coreIo) =>
        executeTuiSessionResume(
          {
            allowDegradedResume: options.allowDegradedResume,
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            inputSurface: "tui",
            message,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            sessionId,
          },
          tuiRuntime,
          coreIo,
        ),
      ),
    startTask: (task) =>
      captureCoreRun((coreIo) =>
        executeAgentThroughApplicationService(agentOptions(takeNextRunOptions(), task), tuiRuntime, coreIo),
      ),
    ...(runtime.createRepositoryNavigationService === undefined
      ? {}
      : {
          refreshRepository: async () => {
            const refresh = await getRepositoryRefresh();
            await refresh.coordinator.refresh();
            return refresh.service.status();
          },
        }),
    watchSession: async (sessionId, onChange, onError) => {
      const stops: (() => void)[] = [];
      if (typedSessionPort !== null) {
        stops.push(typedSessionPort.subscribeInvalidations((invalidatedSessionId) => {
          if (invalidatedSessionId === sessionId) onChange("session");
        }));
      }
      try {
        stops.push(await sessionFileWatcher.watch(sessionId, { onChange, onError }));
      } catch (error) {
        for (const stop of stops.splice(0).reverse()) stop();
        throw error;
      }
      return () => {
        for (const stop of stops.splice(0).reverse()) stop();
      };
    },
    ...(continuousPhase16
      ? {
          startIntent: (
            intent: Phase16StartIntent,
            selectedMode: "build" | "plan",
            modeSource: "explicit_tui" | "tui_default",
          ) =>
            captureCoreRun((coreIo) =>
              executeTuiStart(
                intent,
                selectedMode,
                modeSource,
                takeNextRunOptions(),
                tuiRuntime,
                coreIo,
                typedSessionPort,
              ),
            ),
        }
      : {}),
  });
  let initialSnapshot: TuiSessionSnapshot = [];
  const initialSessionId = options.inspectSessionId ?? options.resumeSessionId;
  if (initialSessionId !== undefined) {
    try {
      initialSnapshot = await core.loadSession(initialSessionId);
    } catch {
      io.stderr.write("born tui: could not load the requested session\n");
      return 1;
    }
  }

  const renderer = host.createRenderer({
    onInput: (data) => controllerRef.current?.handleRawInput(data),
    // PHASE15: rendering/replay is not credential authority. Model command
    // assembly performs selected-provider redaction after policy resolution.
    secrets: [],
  });
  const approvalController = new ApprovalController(
    () => {
      if (controllerRef.current === undefined) {
        throw new Error("TUI approval controller is not initialized");
      }
      return controllerRef.current.view;
    },
    approvalPrompt,
  );
  const controller = new TuiController({
    approvalController,
    approvalViewChanged: () => approvalPrompt.notifyViewChanged(),
    core,
    createIntentId: runtime.randomUUID,
    initialMode:
      options.mode === "build" || options.mode === "plan"
        ? options.mode
        : "plan",
    initialModeSource:
      options.mode === "build" || options.mode === "plan"
        ? "explicit_tui"
        : "tui_default",
    renderer,
    source,
  });
  controllerRef.current = controller;
  const stopTypedSessionInvalidations = typedSessionPort?.subscribeInvalidations((sessionId) => {
    controller.acceptSessionInvalidation(sessionId);
  });
  // PHASE21: task actions now stop after Host preparation. The TUI renders the
  // exact id/hash/display and only releases this promise after a fresh key
  // decision; captureCoreRun no longer determines presentation ordering.
  const unregisterPreparedActionReviewer = registerTaskPreparedActionReviewer(
    tuiRuntime,
    (review) => controller.reviewPreparedAction(review),
  );

  let repositoryWatcher: RepositoryInvalidationWatcher | undefined;

  let exitCode: 0 | 1;
  try {
    controller.start(initialSnapshot);
    try {
      repositoryWatcher = await RepositoryInvalidationWatcher.create(
        runtime.cwd,
        (invalidation) => {
          controller.acceptRepositoryInvalidation(invalidation);
          repositoryRefresh?.coordinator.invalidate(invalidation);
        },
        {
          onError: () => {
            controller.setRepositoryWatchState("unavailable");
            repositoryRefresh?.coordinator.markWatchUnavailable();
          },
        },
      );
      controller.setRepositoryWatchState(repositoryWatcher.start());
    } catch {
      controller.setRepositoryWatchState("unavailable");
    }
    // PHASE11: run exit codes stay in durable events. The app remains alive
    // after completion/cancellation and returns only its own 0/1 lifecycle code.
    await controller.runInitial({
      ...(options.resumeSessionId === undefined || options.inspectSessionId !== undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
      ...(options.task === undefined ? {} : { task: options.task }),
    });
    exitCode = await controller.waitForExit();
  } catch {
    // The outer Host lifecycle catch has the same safety contract as a
    // renderer/source fatal: route only to an exact registered owner. Do not
    // fall back to the raw bridge, which would fabricate a user cancellation.
    requestTuiSurfaceFatalForRuntime(tuiRuntime, controllerRef.current?.view.session.id);
    exitCode = 1;
  } finally {
    unregisterPreparedActionReviewer();
    stopTypedSessionInvalidations?.();
    repositoryWatcher?.stop();
    await repositoryRefresh?.coordinator.stop();
    try {
      controller.stop();
    } catch {
      exitCode = 1;
    }
  }
  return exitCode;
}
