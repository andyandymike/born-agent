import type { AgentCommandOptions } from "../agent/agent-types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { executeAgent } from "../commands/agent.js";
import { executeSessionsResume } from "../commands/sessions.js";
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
import { TuiApprovalPrompt } from "./tui-approval-prompt.js";
import { SessionFileWatcher } from "./session-file-watcher.js";
import {
  TuiController,
  type TuiCorePort,
  type TuiCoreRunResult,
  type TuiDelegationIntent,
  type TuiGraphIntent,
} from "./tui-controller.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import type {
  Phase16MutationIntent,
  Phase16StartIntent,
} from "./phase16-user-intent.js";
import { RepositoryInvalidationWatcher } from "../repository-intelligence/repository-invalidation-watcher.js";
import { RepositoryRefreshCoordinator } from "../repository-intelligence/repository-refresh-coordinator.js";
import {
  executeGraphApprove,
  executeGraphCancel,
  executeGraphEnqueue,
  executeGraphPromote,
  executeGraphOriginVerify,
  executeGraphResume,
  executeGraphRun,
} from "../commands/graph.js";
import {
  executeDelegationsApprove,
  executeDelegationsCancel,
  executeDelegationsPrepare,
  executeDelegationsReject,
  executeDelegationsResume,
  executeDelegationsStart,
} from "../commands/delegations.js";

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

async function executeTuiGraphCommand(intent: TuiGraphIntent, runtime: CliRuntime, io: CliIO): Promise<number> {
  switch (intent.type) {
    case "approve":
      return executeGraphApprove({ json: false, revision: String(intent.revision), sessionId: intent.sessionId, sha256: intent.sha256 }, runtime, io);
    case "enqueue":
      return executeGraphEnqueue({ background: intent.background, json: false, revision: String(intent.revision), runtimeProfile: "local-free", sessionId: intent.sessionId, sha256: intent.sha256 }, runtime, io);
    case "run":
      return executeGraphRun({ background: intent.background, json: false, sessionId: intent.sessionId }, runtime, io);
    case "cancel":
      return executeGraphCancel({ json: false, reason: intent.reason, revision: String(intent.revision), sessionId: intent.sessionId, sha256: intent.sha256 }, runtime, io);
    case "resume":
      return executeGraphResume({ background: intent.background, foreground: !intent.background, json: false, revision: String(intent.revision), sessionId: intent.sessionId, sha256: intent.sha256, takeover: false }, runtime, io);
    case "promote":
      return executeGraphPromote({ attemptId: intent.attemptId, json: false, nodeId: intent.nodeId, revision: String(intent.revision), sessionId: intent.sessionId, sha256: intent.sha256 }, runtime, io);
    case "verify_origin":
      return executeGraphOriginVerify({ json: false, promotionOperation: intent.promotionOperation, revision: String(intent.revision), sessionId: intent.sessionId, sha256: intent.sha256 }, runtime, io);
  }
}

async function executeTuiDelegationCommand(
  intent: TuiDelegationIntent,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  const common = {
    delegationId: intent.delegationId,
    expectedSessionSeq: intent.expectedSessionSeq,
    inputSurface: "tui" as const,
    json: false,
    sessionId: intent.sessionId,
  };
  if (intent.action === "approve") {
    return executeDelegationsApprove({ ...common, queue: true, revision: String(intent.revision), sha256: intent.sha256 }, runtime, io);
  }
  if (intent.action === "reject") {
    return executeDelegationsReject({ ...common, reason: intent.reason ?? "Rejected from TUI", revision: String(intent.revision), sha256: intent.sha256 }, runtime, io);
  }
  if (intent.action === "cancel") {
    return executeDelegationsCancel({ ...common, reason: intent.reason ?? "Cancelled from TUI" }, runtime, io);
  }
  let state = await new SessionCatalog(runtime.cwd).read(intent.sessionId);
  let revision = [...state.delegations.revisions].reverse().find((candidate) => candidate.delegationId === intent.delegationId);
  if (revision?.status === "approved") {
    const queued = await executeDelegationsResume(common, runtime, io);
    if (queued !== 0) return queued;
    state = await new SessionCatalog(runtime.cwd).read(intent.sessionId);
    revision = [...state.delegations.revisions].reverse().find((candidate) => candidate.delegationId === intent.delegationId);
  }
  if (revision?.status === "queued" && revision.envelope === null) {
    const prepared = await executeDelegationsPrepare({ ...common, expectedSessionSeq: state.delegations.lastSessionSeq }, runtime, io);
    if (prepared !== 0) return prepared;
  }
  return executeDelegationsStart({
    delegationId: intent.delegationId,
    inputSurface: "tui",
    json: false,
    sessionId: intent.sessionId,
  }, runtime, io);
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
    agentOptions(
      input.options,
      input.modelTask,
      input.mode,
      input.modeSource,
    ),
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
  session: Awaited<ReturnType<SessionCatalog["read"]>>,
): Pick<
  Parameters<typeof executeSessionsResume>[0],
  "continueApprovedPlan" | "planRevision" | "planSha256"
> {
  const current = session.taskState.currentApprovedPlan;
  return current === null
    ? {}
    : {
        continueApprovedPlan: true,
        planRevision: String(current.revision),
        planSha256: current.planSha256,
      };
}

function goalHasStartedRun(
  session: Awaited<ReturnType<SessionCatalog["read"]>>,
  goalId: string,
  goalRevision: number,
): boolean {
  return session.runs.some((run) => {
    const binding = phase16RunBindingSchema.safeParse(
      Object.fromEntries(
        PHASE16_RUN_BINDING_KEYS.map((key) => [key, run.started.data[key]]),
      ),
    );
    return (
      binding.success &&
      binding.data.goal_id === goalId &&
      binding.data.goal_revision === goalRevision
    );
  });
}

async function executeTuiStart(
  intent: Phase16StartIntent,
  selectedMode: "build" | "plan",
  modeSource: "explicit_tui" | "tui_default",
  options: TuiCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const catalog = new SessionCatalog(runtime.cwd);
    if (intent.type === "submit_idle_message" && intent.sessionId === null) {
      return executeAgent(
        agentOptions(options, intent.text, selectedMode, modeSource),
        runtime,
        io,
      );
    }
    if (intent.type === "start_new_goal" && intent.sessionId === null) {
      return executeAgent(
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
      const afterGoal = await catalog.read(intent.sessionId);
      expectedSessionSeq = afterGoal.taskState.lastSessionSeq;
      message = intent.text;
    } else if (intent.type === "submit_idle_message") {
      message = intent.text;
    } else {
      mode = intent.mode;
    }

    const session = await catalog.read(intent.sessionId);
    const activeGoal = session.taskState.goals.find(
      (goal) => goal.content.goalId === session.taskState.activeGoalId,
    );
    if (activeGoal?.status !== "active") {
      io.stderr.write("active_goal_required: an active Goal is required\n");
      return 2;
    }
    if (
      mode === "build" &&
      session.taskState.pendingDraft !== null
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
          session.taskState.currentApprovedPlan === null ||
          session.taskState.pendingDraft !== null)
      ) {
        io.stderr.write(
          "approved_plan_build_invalid: an exact approved Plan with no pending draft is required\n",
        );
        return 2;
      }
    }
    if (session.lastRun === null) {
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
      mode === "build" && session.taskState.currentApprovedPlan !== null
        ? continuationFields(session)
        : {};
    return executeSessionsResume(
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
  const tuiRuntime: CliRuntime = {
    ...runtime,
    createApprovalPrompt: () => approvalPrompt,
    observeSessionWriter: (writer) => {
      runtime.observeSessionWriter?.(writer);
      source.observe(writer);
    },
    onCancel: abortBridge.onCancel,
  };
  const catalog = new SessionCatalog(runtime.cwd);
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
  const core: TuiCorePort = {
    cancelActiveRun: () => abortBridge.cancelActiveRun(),
    cancelRepositoryRefresh: () => repositoryRefresh?.coordinator.cancel(),
    loadSession: async (sessionId) =>
      (await catalog.read(sessionId)).events as readonly TuiPersistedEvent[],
    delegationCommand: (intent) => captureCoreRun((coreIo) =>
      executeTuiDelegationCommand(intent, tuiRuntime, coreIo)),
    graphCommand: (intent) => captureCoreRun((coreIo) => executeTuiGraphCommand(intent, tuiRuntime, coreIo)),
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
        executeSessionsResume(
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
        executeAgent(agentOptions(takeNextRunOptions(), task), tuiRuntime, coreIo),
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
    watchSession: (sessionId, onChange, onError) =>
      sessionFileWatcher.watch(sessionId, { onChange, onError }),
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
              ),
            ),
        }
      : {}),
  };
  let initialSnapshot: readonly TuiPersistedEvent[] = [];
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
    abortBridge.cancelActiveRun();
    exitCode = 1;
  } finally {
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
