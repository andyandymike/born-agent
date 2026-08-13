import {
  runAgentLoop,
  type InheritedAgentCall,
} from "../agent/agent-loop.js";
import {
  resolveAgentConfig,
  resolveAgentContextRuntime,
} from "../agent/agent-config.js";
import type {
  AgentCommandOptions,
  AgentExitCode,
  AgentTerminal,
} from "../agent/agent-types.js";
import { BudgetTracker } from "../agent/budget-tracker.js";
import { RunResourceScope } from "../agent/run-resource-scope.js";
import {
  classifyRunExecutionError,
  RunTerminator,
  RunTerminationStateError,
  type TerminalRunEventDraftV1,
} from "../agent/run-terminator.js";
import {
  AGENT_SYSTEM_INSTRUCTIONS,
  READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS,
} from "../agent/system-instructions.js";
import {
  agentModeSchema,
  agentModeSourceSchema,
  resolveAgentMode,
} from "../agent/agent-mode.js";
import { systemInstructionsForAgentMode } from "../agent/mode-system-instructions.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import {
  EventPersistenceError,
  EventPublisher,
} from "../events/event-publisher.js";
import type { RunEvent } from "../events/run-event.js";
import type { RunEventRenderer } from "../events/event-publisher.js";
import {
  BackendPreflightError,
} from "../model/backend-factory.js";
import type {
  BackendContinuation,
  ModelBackend,
} from "../model/model-backend.js";
import type { BackendCreationRequest } from "../model/backend-factory.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { createTurnBoundaryRecorder } from "../sessions/turn-boundary-recorder.js";
import {
  type ToolDefinition,
  type ToolRegistration,
  type ToolRegistryLike,
} from "../tools/tool-types.js";
import type { AgentToolRegistryOptions } from "../tools/create-agent-tool-registry.js";
import { McpConfigLoader } from "../mcp/mcp-config-loader.js";
import { McpCoreError } from "../mcp/mcp-errors.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { McpEventAppender } from "../mcp/mcp-approval-gate.js";
import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import { ArtifactSessionRuntime } from "../artifacts/artifact-session-runtime.js";
import {
  AgentContextRuntime,
} from "../context/agent-context-runtime.js";
import {
  AgentContextController,
  type ContextEventAppender,
} from "../context/agent-context-controller.js";
import type {
  Phase10ContextRunEventData,
  Phase10ContextRunEventType,
} from "../context/context-event-schema.js";
import { RootAgentsLoader } from "../repository-rules/root-agents-loader.js";
import { NestedAgentsLoader } from "../repository-rules/nested-agents-loader.js";
import {
  RepositoryRuleChangeDetector,
  RepositoryRulesStaleError,
  type RepositoryRuleManifestChange,
} from "../repository-rules/repository-rule-change-detector.js";
import { RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";
import { RepositoryRuleObservationTracker } from "../repository-rules/repository-rule-observation-binding.js";
import { selectRepositoryRuleContext } from "../context/repository-rule-context-selector.js";
import type { NestedRepositoryRuleSet } from "../repository-rules/repository-rule-manifest.js";
import { repositoryRuleManifestIdentityDescriptor } from "../repository-rules/repository-rule-manifest-schema.js";
import { RepositorySourceSnapshotter } from "../repository-intelligence/source-snapshotter.js";
import { RepositoryIntelligenceError } from "../repository-intelligence/repository-intelligence-error.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { buildWorkspaceResumeFingerprint } from "../resume/workspace-resume-fingerprint-builder.js";
import {
  persistWorkspaceResumeFingerprint,
  type WorkspaceResumeFingerprint,
  workspaceResumeFingerprintSha256,
} from "../resume/workspace-resume-fingerprint.js";
import type {
  Phase13SandboxRunEventData,
  Phase13SandboxRunEventType,
  SandboxEventAppender,
} from "../execution/docker/sandbox-event-schema.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type EffectiveRuntimePolicy,
  type ResolvedProviderPolicyRequest,
} from "../policy/policy-resolver.js";
import { persistRuntimePolicyEvidence } from "../policy/policy-evidence.js";
import { credentialSecretsForPolicy } from "../policy/provider-access-policy.js";
import { DockerAcquisitionError } from "../execution/docker/acquisition/docker-acquisition-errors.js";
import { BUILT_IN_DOCKER_ARTIFACT_ID } from "../execution/docker/acquisition/docker-artifact-registry.js";
import {
  dockerExecutionImageIdentitySha256,
  persistDockerExecutionImageIdentity,
  type DockerArtifactExecutionConfig,
} from "../execution/docker/acquisition/docker-image-identity.js";
import { TaskStateMachine } from "../coordination/task-state-machine.js";
import { RunStartPlanner } from "../coordination/run-start-planner.js";
import {
  GoalChangeLedgerError,
  assertGoalChangePlanPreflight,
  assertGoalChangeWorkspaceMatches,
  goalChangeLedgerSha256,
  projectGoalChangeLedger,
} from "../coordination/goal-change-ledger.js";
import {
  GoalExecutionBaselineError,
  captureGoalExecutionBaseline,
} from "../coordination/goal-execution-baseline.js";
import type { GoalExecutionBaselineCapturedData } from "../coordination/goal-change-event-schema.js";
import type { Phase16RunBinding } from "../events/phase16-run-event-extension.js";
import {
  BundledFakeModelQualificationGate,
  ModelQualificationError,
} from "../model/model-qualification-gate.js";
import { DurableAgentPlanStore } from "../plans/agent-plan-store.js";
import { createUpdatePlanTool } from "../plans/update-plan-tool.js";
import {
  projectTaskContext,
  taskContextSourceEventIds,
} from "../coordination/task-context-projection.js";
import {
  VerifiedGoalChangeSeed,
  goalChangeAttributionScope,
} from "../coordination/goal-change-seed.js";
import { CollaborativeCompletionPolicy } from "../completion/collaborative-completion-policy.js";
import { VerifiedCompletionPolicy } from "../completion/completion-policy.js";
import { OutcomeReportBuilder, type OutcomeReport } from "../coordination/outcome-report.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { CapabilityError } from "../capabilities/capability-errors.js";
import type { CapabilitySnapshotV1 } from "../capabilities/capability-types.js";
import {
  appendPreparedCapabilitySnapshotArtifact,
  prepareCapabilityRunSnapshot,
  type PreparedCapabilityRunSnapshot,
} from "../capabilities/capability-run-snapshot.js";
import type { CapabilityPlatformLike } from "../capabilities/capability-platform.js";
import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import { SkillRuntime } from "../skills/skill-runtime.js";
import { createSkillTools } from "../skills/skill-tools.js";
import { SkillError } from "../skills/skill-errors.js";
import { FrozenSkillCatalog } from "../skills/skill-catalog.js";
import type {
  Phase18SkillRunEventData,
  Phase18SkillRunEventType,
} from "../skills/skill-event-schema.js";
import { HookRuntime } from "../hooks/hook-runtime.js";
import type { EffectHookPipeline } from "../hooks/hook-pipeline.js";
import type { HookCommandRunnerLike } from "../hooks/hook-command-runner.js";
import { HookError } from "../hooks/hook-errors.js";
import type {
  Phase18HookRunEventData,
  Phase18HookRunEventType,
} from "../hooks/hook-event-schema.js";
import { projectHookDurableFacts } from "../hooks/hook-durable-facts.js";
import type { CapabilityContentLease } from "../plugins/plugin-lifecycle.js";
import { createFrozenCapabilityMcpConfig } from "../mcp/mcp-capability-config.js";
import { parseExplicitMcpPromptSelection } from "../mcp/mcp-prompt-selection.js";
import { createProposeDelegationTool } from "../delegation/propose-delegation-tool.js";
import { RestrictedToolRegistry } from "../tools/restricted-tool-registry.js";
import { projectAcceptedChildReceipts } from "../delegation/receipts/parent-receipt-projector.js";
import type { DelegatedChildRunBindingV1 } from "../events/phase20-run-event-extension.js";
import type { ChatProvider } from "../chat/types.js";
import type { ModelEvidence } from "../completion/completion-types.js";
import type { CheckpointStore } from "../checkpoints/checkpoint-store.js";
import type { DockerArtifactAcquirer } from "../execution/docker/acquisition/docker-artifact-acquirer.js";
import type { ModelQualificationGate } from "../model/model-qualification-gate.js";
import type {
  RepositoryNavigationEventSink,
  RepositoryNavigationService,
} from "../repository-intelligence/navigation-service.js";
import { buildChildToolProfile } from "../delegation/context/child-tool-profile.js";
import { delegatedRuntimeToolCatalog } from "../delegation/context/delegated-tool-catalog.js";
import type { ApplicationCommitBindingV1 } from "../control-plane/application-protocol.js";
import type { ApplicationCancelRequestBindingV1 } from "../events/phase21-run-control-event-schema.js";
import {
  persistedTaskUserOrigin,
  type AuthenticatedTaskMutationBindingV1,
} from "../coordination/task-control-plane.js";

export interface ResumedAgentExecution {
  readonly backend: ModelBackend;
  readonly capabilitySnapshot?: CapabilitySnapshotV1;
  readonly continuation: BackendContinuation | null;
  readonly fingerprint: WorkspaceResumeFingerprint;
  readonly inheritedCall: InheritedAgentCall | null;
  readonly mode: "canonical_degraded" | "exact";
  readonly modelTask: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRunId: string;
  readonly writer: SessionWriter;
}

export interface FreshTaskExecution {
  /** PHASE21: exact application operation that authorized this new run. */
  readonly applicationCommit?: ApplicationCommitBindingV1;
  readonly applicationCancellation?: Readonly<{
    readonly hostEmergencyReason?: () => "tui_surface_fatal" | undefined;
    readonly signal: AbortSignal;
    readonly terminalBinding: () => ApplicationCancelRequestBindingV1 | undefined;
  }>;
  readonly authenticatedMutation?: AuthenticatedTaskMutationBindingV1;
  readonly capabilitySnapshot?: CapabilitySnapshotV1;
  readonly delegatedCapabilityIds?: readonly string[];
  readonly modelTask: string;
  readonly onTaskNodeStarted?: () => void;
  readonly onRunStarted?: (event: Extract<RunEvent, { type: "run.started" }>) => Promise<void> | void;
  readonly runId: string;
  /** Durable session/artifact authority root when execution runs in another workspace. */
  readonly sessionWorkspace?: string;
  readonly sessionId: string;
  readonly sourceRunId?: string;
  readonly taskNodeBinding?: NonNullable<Extract<RunEvent, { type: "run.started" }>["data"]["task_node_binding"]>;
  readonly delegatedChildBinding?: DelegatedChildRunBindingV1;
  readonly delegatedToolIds?: readonly string[];
  readonly delegatedToolProfileSha256?: string;
  readonly writer: SessionWriter;
}

/** Surface-owned presentation receives facts; it never participates in execution authority. */
export interface AgentExecutionPresentationPortV1 extends RunEventRenderer {
  renderDiagnostic(message: string): void;
  renderLegacyCompletionReport(report: string, terminal: "completed" | "incomplete"): void;
  renderOutcomeReport(report: OutcomeReport, successful: boolean): void;
  renderStorageError(): void;
  renderVerbose(value: string): void;
}

/**
 * Host capabilities required by the agent owner.  Keeping this structural and
 * deliberately narrow so application callers never receive command-runtime
 * depending on command/terminal state.
 */
export interface AgentExecutionRuntimePortV1 {
  readonly cwd: string;
  readonly dockerArtifactAcquirer?: DockerArtifactAcquirer;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly hooksSuppressed?: boolean;
  readonly modelQualificationGate?: ModelQualificationGate;
  readonly platform: NodeJS.Platform;
  readonly supportsDelegationProposalTool?: true;
  agentModelEvidence(provider: ChatProvider): ModelEvidence | null;
  clearTimer(handle: unknown): void;
  createAgentToolRegistry(options: AgentToolRegistryOptions): Promise<ToolRegistryLike>;
  createApprovalPrompt(): ApprovalPrompt;
  readonly createCapabilityPlatform?: (workspace: string) => CapabilityPlatformLike;
  readonly createCheckpointStore?: (workspace: string) => Promise<CheckpointStore>;
  readonly createHookCommandRunner?: (options: {
    readonly content: FrozenCapabilityContentSource;
    readonly prompt: ApprovalPrompt;
    readonly secrets: readonly (string | undefined)[];
    readonly workspace: string;
  }) => HookCommandRunnerLike;
  readonly createMcpClientManager?: (options: {
    readonly artifacts?: ArtifactSessionRuntimeLike;
    readonly events: McpEventAppender;
    readonly hooks?: EffectHookPipeline;
    readonly prompt: ApprovalPrompt;
    readonly recency?: () => number;
    readonly secrets?: readonly (string | undefined)[];
  }) => McpClientManager;
  createModelBackend(request: BackendCreationRequest): ModelBackend;
  readonly createRepositoryNavigationService?: (
    workspace: string,
    secrets: readonly string[],
    events?: RepositoryNavigationEventSink,
  ) => Promise<RepositoryNavigationService>;
  createSessionWriter(workspace: string, sessionId: string): Promise<SessionWriter>;
  now(): number;
  readonly observeSessionWriter?: (writer: SessionWriter) => void;
  onCancel(listener: () => void): () => void;
  randomUUID(): string;
  setTimer(listener: () => void, delayMs: number): unknown;
  timestamp(): string;
}

async function closeInputWriter(
  resumedExecution: ResumedAgentExecution | undefined,
  freshTaskExecution: FreshTaskExecution | undefined,
): Promise<void> {
  await (resumedExecution?.writer ?? freshTaskExecution?.writer)
    ?.close()
    .catch(() => undefined);
}

function sameArtifactExecution(
  left: DockerArtifactExecutionConfig,
  right: DockerArtifactExecutionConfig,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.expectedLockfileSha256 === right.expectedLockfileSha256 &&
    left.imagePath === right.imagePath &&
    left.runtime === right.runtime &&
    left.runtimeVersion === right.runtimeVersion &&
    left.supportsCUtf8 === right.supportsCUtf8 &&
    left.wrapperSha256 === right.wrapperSha256 &&
    dockerExecutionImageIdentitySha256(left.imageIdentity) ===
      dockerExecutionImageIdentitySha256(right.imageIdentity)
  );
}

export async function executeAgentExecution(
  options: AgentCommandOptions,
  runtime: AgentExecutionRuntimePortV1,
  presentation: AgentExecutionPresentationPortV1,
  resumedExecution?: ResumedAgentExecution,
  freshTaskExecution?: FreshTaskExecution,
): Promise<AgentExitCode> {
  // PHASE4: 命令边界负责配置、真实资源装配和关闭；循环策略全部下沉到 runAgentLoop。
  const renderer = presentation;
  let effectivePolicy: EffectiveRuntimePolicy;
  let policyRequest: ResolvedProviderPolicyRequest;
  try {
    effectivePolicy = resolveEffectiveRuntimePolicy(
      await loadRuntimePolicyRegistry({
        ...(options.policyConfig === undefined ? {} : { configPath: options.policyConfig }),
        env: runtime.env,
        platform: runtime.platform,
        workspace: runtime.cwd,
      }),
      options.policyProfile,
    );
    const requestedProvider = options.provider ?? runtime.env.BORN_PROVIDER;
    policyRequest = resolveProviderPolicyRequest(effectivePolicy, {
      endpoint:
        requestedProvider?.trim().toLowerCase() === "ollama" || requestedProvider === undefined
          ? runtime.env.BORN_OLLAMA_BASE_URL
          : undefined,
      model: options.model ?? runtime.env.BORN_MODEL,
      provider: requestedProvider,
      ...(options.providerSource === undefined
        ? {}
        : { source: options.providerSource }),
    });
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      await closeInputWriter(resumedExecution, freshTaskExecution);
      return error.exitCode;
    }
    renderer.renderDiagnostic("runtime policy internal error");
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 1;
  }
  const selectedAgentMode = (() => {
    try {
      if (options.modeSource !== undefined) {
        return {
          mode: agentModeSchema.parse(options.mode),
          source: agentModeSourceSchema.parse(options.modeSource),
        };
      }
      return resolveAgentMode({
        ...(options.mode === undefined ? {} : { explicitMode: options.mode }),
        surface: options.inputSurface ?? "cli",
      });
    } catch {
      return undefined;
    }
  })();
  if (selectedAgentMode === undefined) {
    renderer.renderDiagnostic("usage/config error: agent mode must be plan or build");
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  // PHASE16: the legacy CLI default remains the pre-Phase16 Build behavior.
  // Phase16 authority is entered only through an explicit Plan/Build surface;
  // the continuous TUI passes its visible default as an explicit host choice.
  const explicitModeRequested = options.mode !== undefined;
  const delegatedChildExecution =
    freshTaskExecution?.delegatedChildBinding !== undefined;
  // A delegated child is bound by its sealed capsule/envelope, not by the
  // parent's Phase 16 Goal/Plan state machine. Keeping these authorities
  // separate prevents the child model from inheriting the parent task graph.
  const phase16Requested = explicitModeRequested && !delegatedChildExecution;
  const modeTaskProfile =
    selectedAgentMode.mode === "plan" ? "read-only" : "coding";
  if (
    options.mode !== undefined &&
    options.taskProfile !== undefined &&
    options.taskProfile !== modeTaskProfile
  ) {
    renderer.renderDiagnostic(
      `usage/config error: ${selectedAgentMode.mode} mode requires task profile ${modeTaskProfile}`,
    );
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  let explicitMcpPrompt;
  try {
    explicitMcpPrompt = parseExplicitMcpPromptSelection({
      argumentsJson: options.mcpPromptArgumentsJson,
      selectedServerIds: options.mcpServerIds ?? [],
      selector: options.mcpPromptSelection,
    });
  } catch (error) {
    renderer.renderDiagnostic(
      `usage/config error: ${error instanceof McpCoreError ? error.message : "invalid MCP prompt selection"}`,
    );
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  if (
    phase16Requested &&
    selectedAgentMode.mode === "plan" &&
    ((options.mcpServerIds?.length ?? 0) > 0 ||
      options.executor !== undefined ||
      options.dockerImage !== undefined ||
      options.dockerArtifactExecution !== undefined)
  ) {
    renderer.renderDiagnostic(
      "usage/config error: Plan mode does not assemble MCP, command, or Docker execution",
    );
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  let resolvedOptions: AgentCommandOptions = {
    ...options,
    ...(explicitModeRequested ? { taskProfile: modeTaskProfile } : {}),
  };
  const requestedExecutor = options.executor ?? runtime.env.BORN_EXECUTOR;
  if (requestedExecutor === "docker") {
    const persistedArtifact = options.dockerArtifactExecution;
    const hasExplicitLegacyImage =
      options.dockerImage !== undefined ||
      (runtime.env.BORN_DOCKER_IMAGE !== undefined &&
        persistedArtifact === undefined);
    if (persistedArtifact !== undefined || !hasExplicitLegacyImage) {
      if (runtime.dockerArtifactAcquirer === undefined) {
        renderer.renderDiagnostic(
          "docker_acquisition_unavailable: runtime has no Docker acquisition port",
        );
        await closeInputWriter(resumedExecution, freshTaskExecution);
        return 3;
      }
      try {
        // PHASE15: selecting Docker authorizes only the package-owned artifact
        // ID. Prompt/repository/model text cannot supply an image, Dockerfile,
        // context, registry, or builder; the same acquisition service backs
        // both `docker prepare` and this missing-artifact path.
        const acquired =
          persistedArtifact === undefined
            ? await runtime.dockerArtifactAcquirer.prepare({
                artifactId: BUILT_IN_DOCKER_ARTIFACT_ID,
                policy: effectivePolicy,
              })
            : await runtime.dockerArtifactAcquirer.status({
                artifactId: persistedArtifact.artifactId,
                policy: effectivePolicy,
              });
        if (
          acquired.executionConfig === null ||
          (persistedArtifact !== undefined &&
            !sameArtifactExecution(
              persistedArtifact,
              acquired.executionConfig,
            ))
        ) {
          throw new DockerAcquisitionError(
            "docker_acquisition_identity_mismatch",
            "trusted Docker artifact is missing or changed since the run identity was recorded",
            3,
          );
        }
        resolvedOptions = {
          ...options,
          dockerArtifactExecution: acquired.executionConfig,
        };
      } catch (error) {
        if (error instanceof DockerAcquisitionError) {
          renderer.renderDiagnostic(`${error.code}: ${error.message}`);
          await closeInputWriter(resumedExecution, freshTaskExecution);
          return error.exitCode;
        }
        renderer.renderDiagnostic("docker_acquisition_internal: Docker acquisition failed internally");
        await closeInputWriter(resumedExecution, freshTaskExecution);
        return 1;
      }
    }
  }
  const configResult = resolveAgentConfig(
    {
      ...resolvedOptions,
      model: policyRequest.model,
      provider: policyRequest.provider,
    },
    {
      ...runtime.env,
      ...(policyRequest.provider === "ollama"
        ? { BORN_OLLAMA_BASE_URL: policyRequest.endpoint }
        : {}),
    },
  );
  if (!configResult.ok) {
    renderer.renderDiagnostic(`usage/config error: ${configResult.error}`);
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  let config = configResult.value;
  const selectedModelAccess = effectivePolicy.entry.profile.modelAccess;
  if (selectedModelAccess.kind === "remote_explicit") {
    config = Object.freeze({
      ...config,
      // Provider-reported token accounting is not a dollar hard cap, but the
      // smaller policy ceiling still bounds when this run stops at a turn edge.
      maxTokens: Math.min(
        config.maxTokens,
        selectedModelAccess.limits.maxReportedTotalTokensPerRun,
      ),
    });
  }
  const modelEvidence = runtime.agentModelEvidence(config.provider);
  if (
    !phase16Requested &&
    config.taskProfile === "coding" &&
    modelEvidence === null
  ) {
    renderer.renderDiagnostic(
      "usage/config error: restart with --task-profile read-only for local chat; coding profile requires verified model evidence",
    );
    await closeInputWriter(resumedExecution, freshTaskExecution);
    return 2;
  }
  const sessionId =
    resumedExecution?.sessionId ??
    freshTaskExecution?.sessionId ??
    runtime.randomUUID();
  const runId =
    resumedExecution?.runId ?? freshTaskExecution?.runId ?? runtime.randomUUID();
  const sessionWorkspace = freshTaskExecution?.sessionWorkspace ?? runtime.cwd;
  const taskNodeExecution = freshTaskExecution?.taskNodeBinding !== undefined;
  const independentTaskExecution = taskNodeExecution || delegatedChildExecution;
  let writer: SessionWriter;
  try {
    writer =
      resumedExecution?.writer ??
      freshTaskExecution?.writer ??
      (await runtime.createSessionWriter(sessionWorkspace, sessionId));
    runtime.observeSessionWriter?.(writer);
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  if (
    delegatedChildExecution &&
    writer.appendDelegatedChildRunStarted === undefined
  ) {
    renderer.renderDiagnostic(
      "delegation_child_protocol_invalid: session writer does not support delegated child run binding",
    );
    await writer.close().catch(() => undefined);
    return 2;
  }

  let capabilitySnapshot =
    resumedExecution?.capabilitySnapshot ?? freshTaskExecution?.capabilitySnapshot;
  let capabilityPlatform: CapabilityPlatformLike | undefined;
  let preparedCapabilitySnapshot: PreparedCapabilityRunSnapshot | undefined;
  if (runtime.createCapabilityPlatform !== undefined || capabilitySnapshot !== undefined) {
    try {
      if (
        writer.appendArtifactEvent === undefined &&
        writer.appendCapabilitySnapshotArtifact === undefined
      ) {
        throw new CapabilityError(
          "capability_artifact_integrity_failed",
          "Phase 18 runtime requires a full artifact-aware session writer",
        );
      }
      capabilityPlatform = runtime.createCapabilityPlatform?.(runtime.cwd);
      if (capabilitySnapshot === undefined) {
        if (capabilityPlatform === undefined) {
          throw new CapabilityError(
            "capability_state_invalid",
            "runtime cannot create the required capability snapshot",
            1,
          );
        }
        capabilitySnapshot = await capabilityPlatform.createSnapshot(runtime.timestamp());
      }
      const selectedSkills = options.skillSelections ?? [];
      if (options.skillArguments !== undefined && selectedSkills.length !== 1) {
        throw new SkillError(
          "skill_entry_invalid",
          "--skill-args requires exactly one --skill selection",
          2,
        );
      }
      const skillCatalog = new FrozenSkillCatalog(capabilitySnapshot, () => new Set());
      for (const selector of selectedSkills) skillCatalog.resolveUserSelector(selector);
      preparedCapabilitySnapshot = await prepareCapabilityRunSnapshot({
        existingEvents: writer.readDecodedEvents?.() ?? [],
        runId,
        sessionId,
        snapshot: capabilitySnapshot,
        workspace: sessionWorkspace,
      });
    } catch (error) {
      renderer.renderDiagnostic(
        error instanceof CapabilityError || error instanceof SkillError
          ? `${error.code}: ${error.message}`
          : "capability snapshot preflight failed",
      );
      await writer.close().catch(() => undefined);
      return error instanceof CapabilityError || error instanceof SkillError
        ? error.exitCode
        : 1;
    }
  }

  let phase16Binding: Phase16RunBinding | undefined;
  let pendingGoalBaseline:
    | {
        readonly data: GoalExecutionBaselineCapturedData;
        readonly eventId: string;
      }
    | undefined;
  let phase16Enabled =
    phase16Requested &&
    writer.appendTaskEvent !== undefined &&
    writer.appendPhase16RunStarted !== undefined &&
    writer.readDecodedEvents !== undefined;
  if (phase16Requested && !phase16Enabled && options.mode !== undefined) {
    renderer.renderDiagnostic(
      "usage/config error: this session writer does not support Phase 16 mode",
    );
    await writer.close().catch(() => undefined);
    return 2;
  }
  if (phase16Enabled) {
    try {
      let taskState;
      const existingEvents = writer.readDecodedEvents!();
      if (existingEvents.length === 0) {
        const goalId = runtime.randomUUID();
        await writer.appendTaskEvent!("goal.created", {
          goal_id: goalId,
          objective: config.task,
          origin: persistedTaskUserOrigin(
            options.inputSurface ?? "cli",
            freshTaskExecution?.authenticatedMutation,
          ),
          parent_goal_id: null,
          replaces_active_goal: null,
          revision: 1,
        });
        taskState = TaskStateMachine.project(writer.readDecodedEvents!());
      } else {
        taskState = TaskStateMachine.project(existingEvents);
        if (taskState.trackingMode !== "phase16") {
          if (options.mode !== undefined) {
            throw new ModelQualificationError(
              "model_unqualified",
              "legacy sessions require an explicit Goal before entering Plan/Build mode",
            );
          }
          phase16Enabled = false;
        }
      }
      if (phase16Enabled) {
        const qualificationGate =
          runtime.modelQualificationGate ??
          new BundledFakeModelQualificationGate(
            modelEvidence?.backend === "fake",
          );
        const qualification = await qualificationGate.requireQualified({
          ...(policyRequest.endpoint === undefined
            ? {}
            : { endpoint: policyRequest.endpoint }),
          mode: selectedAgentMode.mode,
          model: config.model,
          policyHash: effectivePolicy.evidence.profileSha256,
          policyProfileId: effectivePolicy.entry.profile.id,
          provider: config.provider,
          source: policyRequest.source,
        });
        if (resumedExecution !== undefined) {
          const sourceStart = existingEvents.find(
            (event) =>
              event.scope === "run" &&
              event.runId === resumedExecution.sourceRunId &&
              event.type === "run.started",
          );
          const sourceData = sourceStart?.data as
            | Readonly<Record<string, unknown>>
            | undefined;
          const previousEvidence = sourceData?.model_qualification_sha256;
          if (
            typeof previousEvidence === "string" &&
            previousEvidence !== qualification.evidenceSha256
          ) {
            throw new ModelQualificationError(
              "model_unqualified",
              "resume qualification evidence does not match the source run",
            );
          }
        }
        const activeGoal = taskState.goals.find(
          (goal) => goal.content.goalId === taskState.activeGoalId,
        );
        let goalChangeLedgerHash: string | null = null;
        if (selectedAgentMode.mode === "build" && activeGoal !== undefined) {
          const existingLedger = projectGoalChangeLedger(
            writer.readDecodedEvents!(),
            activeGoal.content.goalId,
            activeGoal.content.revision,
          );
          if (existingLedger === null) {
            const eventId = runtime.randomUUID();
            const data = await captureGoalExecutionBaseline({
              goalId: activeGoal.content.goalId,
              goalRevision: activeGoal.content.revision,
              workspace: runtime.cwd,
            });
            pendingGoalBaseline = { data, eventId };
            goalChangeLedgerHash = goalChangeLedgerSha256({
              baseline: { data, eventId, runId },
              goalId: activeGoal.content.goalId,
              goalRevision: activeGoal.content.revision,
              records: [],
            });
          } else {
            await assertGoalChangeWorkspaceMatches(existingLedger, runtime.cwd);
            goalChangeLedgerHash = existingLedger.ledgerSha256;
          }
        }
        const decision = new RunStartPlanner().plan({
          ...(options.continueApprovedPlan === undefined
            ? {}
            : { continueApprovedPlan: options.continueApprovedPlan }),
          goalChangeLedgerSha256: goalChangeLedgerHash,
          mode: selectedAgentMode,
          modelQualificationSha256: qualification.evidenceSha256,
          taskState,
        });
        if (decision.status === "denied") {
          renderer.renderDiagnostic(
            `usage/config error: ${decision.code}: ${decision.message}`,
          );
          await writer.close();
          return decision.exitCode;
        }
        phase16Binding = decision.binding;
      }
    } catch (error) {
      renderer.renderDiagnostic(
        error instanceof ModelQualificationError
          ? `usage/config error: ${error.code}: ${error.message}`
          : error instanceof GoalExecutionBaselineError ||
              error instanceof GoalChangeLedgerError
            ? `${error.code}: ${error.message}`
          : "task state or qualification preflight failed",
      );
      await writer.close().catch(() => undefined);
      return error instanceof ModelQualificationError
        ? error.exitCode
        : error instanceof GoalExecutionBaselineError &&
            error.code === "goal_baseline_too_large"
          ? 7
          : 1;
    }
  }

  let backend: ModelBackend;
  try {
    // PHASE16: qualification and exact task-state planning have already
    // succeeded, so backend construction cannot read a credential for a
    // missing, stale, corrupt, or mode-incompatible record.
    backend =
      resumedExecution?.backend ??
      runtime.createModelBackend({
        ...(policyRequest.endpoint === undefined
          ? {}
          : { endpoint: policyRequest.endpoint }),
        model: config.model,
        provider: config.provider,
        requirement: {
          cancellation: true,
          completeUsageForReportedTokenCeiling: true,
          streaming: true,
          tools: true,
        },
        runtimePolicy: effectivePolicy,
      });
    if (
      backend.identity.model !== config.model ||
      backend.identity.provider !== config.provider
    ) {
      throw new BackendPreflightError(
        "configuration_model_unknown",
        "preselected resume backend does not match the persisted provider/model",
      );
    }
  } catch (error) {
    if (error instanceof BackendPreflightError) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      await writer.close().catch(() => undefined);
      return error.exitCode;
    }
    if (
      error instanceof Error &&
      "exitCode" in error &&
      (error.exitCode === 2 || error.exitCode === 4)
    ) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      await writer.close().catch(() => undefined);
      return error.exitCode;
    }
    renderer.renderDiagnostic("internal protocol error");
    await writer.close().catch(() => undefined);
    return 1;
  }
  const secrets = credentialSecretsForPolicy(
    effectivePolicy,
    config.provider,
    runtime.env,
  );
  const contextRuntimeResult = resolveAgentContextRuntime(
    config,
    backend.contextCapacity,
  );
  if (!contextRuntimeResult.ok) {
    renderer.renderDiagnostic(
      `usage/config error: ${contextRuntimeResult.error}`,
    );
    await writer.close().catch(() => undefined);
    return 2;
  }
  let workspaceResumeFingerprint = resumedExecution?.fingerprint;
  if (workspaceResumeFingerprint === undefined) {
    try {
      workspaceResumeFingerprint = await buildWorkspaceResumeFingerprint({
        ...(phase16Binding === undefined
          ? {}
          : { agentMode: selectedAgentMode.mode }),
        backend,
        ...(capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshotSha256: capabilitySnapshot.snapshotSha256 }),
        config,
        platform: runtime.platform,
        workspace: runtime.cwd,
      });
    } catch {
      // A run remains useful when Git/source-state metadata is unavailable, but
      // the missing optional proof deliberately makes a later resume fail closed.
      workspaceResumeFingerprint = undefined;
    }
  }

  const publisher = new EventPublisher({
    ...(phase16Binding?.agent_mode !== "build" ||
    writer.readDecodedEvents === undefined
      ? {}
      : {
          completionAttribution: () => {
            const ledger = projectGoalChangeLedger(
              writer.readDecodedEvents!(),
              phase16Binding.goal_id,
              phase16Binding.goal_revision,
            );
            if (ledger === null) {
              throw new GoalChangeLedgerError(
                "goal_change_baseline_invalid",
                "Build completion requires its durable Goal execution baseline",
              );
            }
            return {
              changedPaths: ledger.netChangedPaths,
              scope: goalChangeAttributionScope(ledger),
            };
          },
        }),
    // PHASE4: 一个 agent run 仍使用一个 session/run id，所有 step 和工具事件共享同一审计流。
    randomUUID: runtime.randomUUID,
    renderer,
    runId,
    sessionId,
    timestamp: runtime.timestamp,
    writer,
  });
  const startedAt = runtime.now();
  const budget = new BudgetTracker(config, runtime, startedAt);
  const userController = new AbortController();
  const applicationCancellation = freshTaskExecution?.applicationCancellation;
  const forwardApplicationCancellation = (): void => userController.abort();
  if (applicationCancellation?.signal.aborted === true) {
    userController.abort();
  } else {
    applicationCancellation?.signal.addEventListener(
      "abort",
      forwardApplicationCancellation,
      { once: true },
    );
  }
  // PHASE21: an authenticated product run may only observe the Host-owned
  // application cancellation signal. Letting the execution core also consume
  // SIGINT would bypass the durable run.cancel request, owner-generation
  // fence, and terminal binding. Legacy/no-control-plane embedders retain the
  // original direct cancellation bridge.
  const stopListening = applicationCancellation === undefined
    ? runtime.onCancel(() => userController.abort())
    : () => undefined;
  let exitCode: AgentExitCode;
  let mcpManager: McpClientManager | undefined;
  let mcpStopped = false;
  let capabilityContentLeases: readonly CapabilityContentLease[] = [];
  let hookRuntime: HookRuntime | undefined;
  const resources = new RunResourceScope();
  resources.add("cancel-listeners", () => {
    stopListening();
    applicationCancellation?.signal.removeEventListener(
      "abort",
      forwardApplicationCancellation,
    );
  });
  resources.add("mcp", async () => {
    if (mcpManager === undefined || mcpStopped) return;
    await mcpManager.stopAll();
    mcpStopped = true;
  });
  resources.add("capability-content-leases", async () => {
    await Promise.all(capabilityContentLeases.map((lease) => lease.release()));
  });
  resources.add("session-writer", () => writer.close(), "persistence");
  const terminator = new RunTerminator({
    beforeTerminal: async (candidate) => {
      if (mcpManager !== undefined && !mcpStopped) {
        await mcpManager.stopAll();
        mcpStopped = true;
      }
      if (userController.signal.aborted) return;
      // AS5.1: terminal Hooks observe the final Host projection immediately
      // before the one durable terminal event, which must remain last.
      await hookRuntime?.run(
        "run.terminal",
        {
          action: {
            terminalState:
              candidate.type === "completed"
                ? "completed"
                : candidate.type === "cancelled"
                  ? "cancelled"
                  : candidate.type === "failed"
                    ? "failed"
                    : "blocked",
          },
          result: {
            exit_code: candidate.exitCode,
            terminal_type: candidate.type,
          },
        },
        userController.signal,
      );
    },
    publisher,
  });

  try {
    if (
      capabilityPlatform?.acquireContentLeases !== undefined &&
      preparedCapabilitySnapshot !== undefined &&
      preparedCapabilitySnapshot.snapshot.plugins.some((plugin) => plugin.source === "user_install")
    ) {
      if (writer.lockNonceSha256 === undefined) {
        throw new TypeError("frozen Plugin leases require an exact durable session-lock owner");
      }
      capabilityContentLeases = await capabilityPlatform.acquireContentLeases(
        preparedCapabilitySnapshot.snapshot,
        {
          runId,
          sessionId,
          sessionLockNonceSha256: writer.lockNonceSha256,
        },
      );
    }
    const delegationProposalEnabled =
      runtime.supportsDelegationProposalTool === true &&
      phase16Binding !== undefined &&
      !delegatedChildExecution;
    // PHASE4: run.started 先保存完整预算合同；后续重建器据此验证每个 budget terminal。
    const runStartedData: Extract<
      RunEvent,
      { type: "run.started" }
    >["data"] = {
        ...(freshTaskExecution?.applicationCommit === undefined
          ? {}
          : {
              application_commit: {
                action_kind: freshTaskExecution.applicationCommit.actionKind,
                authorization_decision_sha256: freshTaskExecution.applicationCommit.authorizationDecisionSha256,
                operation_id: freshTaskExecution.applicationCommit.operationId,
                prepared_action_sha256: freshTaskExecution.applicationCommit.preparedActionSha256,
                principal_id: freshTaskExecution.applicationCommit.principalId,
                schema_version: 1 as const,
              },
            }),
        command: "agent",
        command_approval: config.commandApproval,
        command_timeout_ms: config.commandTimeoutMs,
        completion_policy: config.completionPolicy,
        executor: config.executor,
        ...(config.dockerSandbox === undefined
          ? {}
          : {
              docker_sandbox: {
                image: config.dockerSandbox.image,
                image_digest: config.dockerSandbox.image.includes("@")
                  ? config.dockerSandbox.image.slice(
                      config.dockerSandbox.image.lastIndexOf("@") + 1,
                    )
                  : config.dockerSandbox.image,
                ...(config.dockerSandbox.imageIdentity === undefined
                  ? {}
                  : {
                      image_identity: persistDockerExecutionImageIdentity(
                        config.dockerSandbox.imageIdentity,
                      ),
                    }),
                ...(resolvedOptions.dockerArtifactExecution === undefined
                  ? {}
                  : {
                      artifact_contract: {
                        artifact_id:
                          resolvedOptions.dockerArtifactExecution.artifactId,
                        expected_lockfile_sha256:
                          resolvedOptions.dockerArtifactExecution
                            .expectedLockfileSha256,
                        image_path:
                          resolvedOptions.dockerArtifactExecution.imagePath,
                        runtime:
                          resolvedOptions.dockerArtifactExecution.runtime,
                        runtime_version:
                          resolvedOptions.dockerArtifactExecution.runtimeVersion,
                        supports_c_utf8:
                          resolvedOptions.dockerArtifactExecution.supportsCUtf8,
                        wrapper_sha256:
                          resolvedOptions.dockerArtifactExecution.wrapperSha256,
                      },
                    }),
                limits: {
                  cpus: config.dockerSandbox.limits.cpus,
                  memory_mib: config.dockerSandbox.limits.memoryMiB,
                  pids: config.dockerSandbox.limits.pids,
                  tmp_mib: config.dockerSandbox.limits.tmpMiB,
                },
                network: "none" as const,
                snapshot_mode: "disposable_copy" as const,
              },
            }),
        edit_approval: config.editApproval,
        input: { role: "user", text: config.task },
        max_duration_ms: config.maxDurationMs,
        max_command_output_bytes: config.maxCommandOutputBytes,
        max_steps: config.maxSteps,
        max_tokens: config.maxTokens,
        ...((config.mcpServerIds ?? []).length === 0
          ? {}
          : { mcp_servers: [...(config.mcpServerIds ?? [])] }),
        max_tool_output_bytes: config.maxToolOutputBytes,
        model: config.model,
        provider: config.provider,
        ...(resolvedOptions.providerSource === undefined
          ? {}
          : { provider_source: resolvedOptions.providerSource }),
        runtime_policy: persistRuntimePolicyEvidence(effectivePolicy.evidence),
        ...(resumedExecution !== undefined
          ? {
              resume_mode: resumedExecution.mode,
              resume_of_run_id: resumedExecution.sourceRunId,
            }
          : freshTaskExecution?.sourceRunId === undefined
            ? {}
            : {
                resume_mode: "canonical_degraded" as const,
                resume_of_run_id: freshTaskExecution.sourceRunId,
              }),
        report_format: config.reportFormat,
        require_verification: config.requireVerification,
        request_timeout_ms: config.requestTimeoutMs,
        task_profile: config.taskProfile,
        tools:
          (freshTaskExecution?.delegatedToolIds === undefined
            ? undefined
            : [...freshTaskExecution.delegatedToolIds]) ??
          (phase16Binding?.agent_mode === "plan"
            ? [
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                ...(runtime.createRepositoryNavigationService === undefined
                  ? []
                  : ["repository_outline", "find_symbol", "find_references"]),
                "search",
                ...(delegationProposalEnabled ? ["propose_delegation"] : []),
                ...(independentTaskExecution ? [] : ["update_plan"]),
              ]
            : config.taskProfile === "read-only"
            ? [
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                ...(runtime.createRepositoryNavigationService === undefined
                  ? []
                  : ["repository_outline", "find_symbol", "find_references"]),
                "search",
                ...(delegationProposalEnabled ? ["propose_delegation"] : []),
              ]
            : [
                "apply_patch",
                "finish_task",
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                ...(runtime.createRepositoryNavigationService === undefined
                  ? []
                  : ["repository_outline", "find_symbol", "find_references"]),
                "run_command",
                "search",
                ...(delegationProposalEnabled ? ["propose_delegation"] : []),
                ...(phase16Binding === undefined || independentTaskExecution ? [] : ["update_plan"]),
              ]),
        tools_enabled: true,
        workspace: runtime.cwd,
        ...(workspaceResumeFingerprint === undefined
          ? {}
          : {
              workspace_fingerprint: workspaceResumeFingerprintSha256(
                workspaceResumeFingerprint,
              ),
              workspace_resume_fingerprint:
                persistWorkspaceResumeFingerprint(workspaceResumeFingerprint),
            }),
      };
    const capabilityBoundRunStartedData = {
      ...runStartedData,
      ...(preparedCapabilitySnapshot === undefined
        ? {}
        : { capability_snapshot: preparedCapabilitySnapshot.binding }),
      ...(freshTaskExecution?.taskNodeBinding === undefined
        ? {}
        : { task_node_binding: freshTaskExecution.taskNodeBinding }),
    };
    // PHASE18: the exact snapshot object is durable before run.started, while
    // the event is the sole authority that selects those bytes for this run.
    const runStarted = delegatedChildExecution
      ? await publisher.publishDelegatedChildRunStarted(
          capabilityBoundRunStartedData,
          freshTaskExecution!.delegatedChildBinding!,
        )
      : phase16Binding === undefined
        ? await publisher.publish({
          data: capabilityBoundRunStartedData,
          type: "run.started",
        })
        : await publisher.publishPhase16RunStarted(
            capabilityBoundRunStartedData,
            phase16Binding,
          );
    await freshTaskExecution?.onRunStarted?.(
      runStarted as Extract<RunEvent, { type: "run.started" }>,
    );
    if (freshTaskExecution?.taskNodeBinding !== undefined) {
      if (writer.appendTaskGraphEvent === undefined) {
        throw new EventPersistenceError(new TypeError("Graph node run requires a TaskGraph-aware session writer"));
      }
      const binding = freshTaskExecution.taskNodeBinding;
      // PHASE19: the node-start fact is appended by the process that owns the
      // normal run writer, so scheduler observation cannot race a locked run.
      await writer.appendTaskGraphEvent("task_node.attempt.started", {
        attempt_id: binding.attempt_id,
        graph_id: binding.graph_id,
        graph_revision: binding.graph_revision,
        graph_sha256: binding.graph_sha256,
        node_id: binding.node_id,
        run_id: runId,
        scheduler_lease_nonce_sha256: binding.scheduler_lease_nonce_sha256,
      });
      freshTaskExecution.onTaskNodeStarted?.();
    }
    await publisher.publish({
      data: {
        adapter: backend.identity.adapter,
        adapter_version: backend.identity.adapterVersion,
        capabilities: backend.capabilities,
        ...(backend.resume.capability === "exact_checkpoint"
          ? {
              checkpoint_codec_version:
                backend.resume.checkpointCodec.codecVersion,
            }
          : {}),
        config_fingerprint: backend.identity.configFingerprint,
        model: backend.identity.model,
        provider: backend.identity.provider,
        resume_capability: backend.resume.capability,
      },
      type: "backend.selected",
    });
    if (pendingGoalBaseline !== undefined) {
      await publisher.publishGoalChangeEvent(
        "goal.execution.baseline.captured",
        pendingGoalBaseline.data,
        pendingGoalBaseline.eventId,
      );
    }
    if (preparedCapabilitySnapshot !== undefined) {
      await appendPreparedCapabilitySnapshotArtifact({
        originEventId: runStarted.event_id,
        prepared: preparedCapabilitySnapshot,
        runId,
        writer,
      });
    }
    if (writer.appendRunEvent === undefined) {
      throw new TypeError("agent session writer does not support Phase 10 events");
    }
    if (
      writer.persistenceProfile === "phase10_full" &&
      (writer.appendRunEventWithId === undefined ||
        writer.appendArtifactEvent === undefined ||
        writer.readDecodedEvents === undefined)
    ) {
      throw new TypeError(
        "Phase 10 production writer is missing durable event capabilities",
      );
    }
    const decodedEvents = () => {
      const durable = writer.readDecodedEvents?.();
      if (durable !== undefined) {
        return delegatedChildExecution
          ? durable.filter(
              (event) => event.scope === "run" && event.runId === runId,
            )
          : durable;
      }
      return delegatedChildExecution
        ? publisher.events.filter((event) => event.run_id === runId)
        : publisher.events;
    };
    const runInstructions =
      phase16Binding === undefined
        ? config.taskProfile === "read-only"
          ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
          : AGENT_SYSTEM_INSTRUCTIONS
        : systemInstructionsForAgentMode(phase16Binding.agent_mode);
    const exactPlanBinding =
      phase16Binding !== undefined &&
      phase16Binding.plan_id !== null &&
      phase16Binding.plan_revision !== null &&
      phase16Binding.plan_sha256 !== null
        ? {
            goalId: phase16Binding.goal_id,
            goalRevision: phase16Binding.goal_revision,
            planId: phase16Binding.plan_id,
            planRevision: phase16Binding.plan_revision,
            planSha256: phase16Binding.plan_sha256,
          }
        : null;
    const phase16TaskState =
      phase16Binding === undefined || writer.readDecodedEvents === undefined
        ? undefined
        : () => TaskStateMachine.project(writer.readDecodedEvents!());
    const acceptedChildReceipts =
      exactPlanBinding === null || writer.readDecodedEvents === undefined
        ? Object.freeze([])
        : await projectAcceptedChildReceipts({
            workspace: sessionWorkspace,
            sessionId,
            projection: reconstructMultiRunSession(writer.readDecodedEvents()).delegations,
            goalBinding: exactPlanBinding,
          });
    const artifactRuntime =
      writer.appendArtifactEvent === undefined
        ? undefined
        : await ArtifactSessionRuntime.create({
            budgets: {
              perArtifactBytes: config.artifactCaptureBytes ?? 4 * 1024 * 1024,
            },
            events: writer.readDecodedEvents?.() ?? [],
            eventAppender: {
              appendArtifactEvent: async (eventRunId, event) => {
                try {
                  return await writer.appendArtifactEvent!(eventRunId, event);
                } catch (error) {
                  throw new EventPersistenceError(error);
                }
              },
            },
            runId,
            secrets,
            sessionId,
            workspace: sessionWorkspace,
          });
    let skillRuntime: SkillRuntime | undefined;
    const hasFrozenSkills = preparedCapabilitySnapshot?.snapshot.plugins.some(
      (plugin) => plugin.components.some((component) => component.identity.kind === "skill"),
    ) ?? false;
    if (hasFrozenSkills && preparedCapabilitySnapshot !== undefined && capabilityPlatform !== undefined) {
      if (
        artifactRuntime === undefined ||
        writer.appendRunEventWithId === undefined
      ) {
        throw new TypeError("Phase 18 Skill runtime requires frozen content, artifacts, and durable event IDs");
      }
      skillRuntime = new SkillRuntime({
        artifacts: artifactRuntime,
        content: capabilityPlatform.createContentSource(preparedCapabilitySnapshot.snapshot),
        events: {
          append: async <TType extends Phase18SkillRunEventType>(
            type: TType,
            data: Phase18SkillRunEventData<TType>,
            eventId = runtime.randomUUID(),
          ): Promise<void> => {
            try {
              await writer.appendRunEventWithId!(runId, eventId, type, data);
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          },
        },
        randomUUID: runtime.randomUUID,
        recency: () => {
          const latest = writer.readDecodedEvents?.().at(-1);
          return latest?.sessionSeq ?? 0;
        },
        snapshot: preparedCapabilitySnapshot.snapshot,
      });
      const selectedSkills = options.skillSelections ?? [];
      if (options.skillArguments !== undefined && selectedSkills.length !== 1) {
        throw new SkillError(
          "skill_entry_invalid",
          "--skill-args requires exactly one --skill selection",
          2,
        );
      }
      for (const [index, selector] of selectedSkills.entries()) {
        await skillRuntime.activateUser(
          selector,
          index === 0 ? options.skillArguments ?? "" : "",
        );
      }
    }
    const hasFrozenHooks = runtime.hooksSuppressed !== true && (
      preparedCapabilitySnapshot?.snapshot.plugins.some(
        (plugin) => plugin.components.some((component) => component.identity.kind === "hook"),
      ) ?? false
    );
    if (hasFrozenHooks) {
      if (
        preparedCapabilitySnapshot === undefined ||
        artifactRuntime === undefined ||
        writer.appendRunEventWithId === undefined ||
        writer.readDecodedEvents === undefined
      ) {
        throw new TypeError(
          "Phase 18 Hook runtime requires a frozen snapshot, artifacts, and durable event IDs",
        );
      }
      hookRuntime = new HookRuntime({
        artifacts: artifactRuntime,
        ...(capabilityPlatform === undefined || runtime.createHookCommandRunner === undefined
          ? {}
          : {
              commandRunner: runtime.createHookCommandRunner({
                content: capabilityPlatform.createContentSource(preparedCapabilitySnapshot.snapshot),
                prompt: runtime.createApprovalPrompt(),
                secrets,
                workspace: runtime.cwd,
              }),
            }),
        events: {
          append: async <TType extends Phase18HookRunEventType>(
            type: TType,
            data: Phase18HookRunEventData<TType>,
            eventId = runtime.randomUUID(),
          ): Promise<void> => {
            try {
              await writer.appendRunEventWithId!(runId, eventId, type, data);
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          },
        },
        facts: () => projectHookDurableFacts({
          events: writer.readDecodedEvents!(),
          runId,
          ...(phase16TaskState === undefined
            ? {}
            : { taskState: phase16TaskState() }),
          verifications: publisher.currentVerificationCommandFacts(),
        }),
        randomUUID: runtime.randomUUID,
        runId,
        sessionId,
        ...(writer.lockNonceSha256 === undefined
          ? {}
          : { sessionLockNonceSha256: writer.lockNonceSha256 }),
        snapshot: preparedCapabilitySnapshot.snapshot,
        timestamp: runtime.timestamp,
        workspaceLogicalId: `sha256:${sha256Canonical({ workspace: runtime.cwd })}`,
      });
      const startedHookDecision = await hookRuntime.run(
        "run.started",
        {},
        userController.signal,
      );
      if (startedHookDecision.decision === "deny") {
        throw new HookError(
          "hook_gate_denied",
          `${startedHookDecision.code ?? "hook_gate_denied"}: ${startedHookDecision.message ?? "run start was denied by a lifecycle Hook"}`,
        );
      }
    }
    const goalChangeSeed =
      phase16Binding?.agent_mode !== "build" || artifactRuntime === undefined
        ? undefined
        : await (async () => {
            const ledger = projectGoalChangeLedger(
              writer.readDecodedEvents!(),
              phase16Binding.goal_id,
              phase16Binding.goal_revision,
            );
            if (ledger === null) {
              throw new GoalChangeLedgerError(
                "goal_change_baseline_invalid",
                "Build runtime requires its durable Goal execution baseline",
              );
            }
            return VerifiedGoalChangeSeed.hydrateAndVerify({
              artifactStore: artifactRuntime.store,
              projection: ledger,
            });
          })();

    let repositoryRules;
    let repositoryRulesEventId: string | undefined;
    let ruleChangeDetector: RepositoryRuleChangeDetector | undefined;
    let repositoryRuleScopeResolver: RepositoryRuleScopeResolver | undefined;
    let repositoryRuleObservationTracker:
      | RepositoryRuleObservationTracker
      | undefined;
    let nestedRepositoryRules: NestedRepositoryRuleSet | undefined;
    let repositoryRulesManifestEventId: string | undefined;
    if (
      artifactRuntime !== undefined &&
      writer.appendRunEventWithId !== undefined
    ) {
      const rulesEventId = runtime.randomUUID();
      const manifestEventId = runtime.randomUUID();
      repositoryRulesManifestEventId = manifestEventId;
      repositoryRulesEventId = rulesEventId;
      const sourceSnapshot = await (
        await RepositorySourceSnapshotter.create(runtime.cwd)
      ).snapshot(userController.signal);
      try {
        await writer.appendRunEventWithId(
          runId,
          runtime.randomUUID(),
          "repository.source.snapshot.captured",
          {
            coverage: sourceSnapshot.snapshot.coverage,
            entries_sha256: sourceSnapshot.snapshot.entriesSha256,
            file_count: sourceSnapshot.snapshot.entries.length,
            inventory_policy_sha256: sourceSnapshot.snapshot.inventoryPolicySha256,
            skipped_count: Object.values(sourceSnapshot.snapshot.skipped).reduce((total, value) => total + value, 0),
            source_kind: sourceSnapshot.snapshot.sourceKind,
            source_state_sha256: sourceSnapshot.snapshot.sourceStateSha256,
          },
        );
      } catch (error) {
        throw new EventPersistenceError(error);
      }
      const rulesLoader = await RootAgentsLoader.create(runtime.cwd, {
        artifactStore: {
          storeRepositoryRules: async (input) => {
            const stored = await artifactRuntime.materializeText({
              bytes: input.bytes,
              expectedSha256: input.expectedSha256,
              mediaType: input.mediaType,
              originEventId: rulesEventId,
            });
            return {
              artifactId: stored.artifactId,
              bytes: stored.bytes,
              relativeRef: stored.objectRef,
              sha256: stored.sha256,
            };
          },
        },
      });
      repositoryRules = await rulesLoader.loadForRun();
      try {
        await writer.appendRunEventWithId(
          runId,
          rulesEventId,
          "repository.rules.loaded",
          repositoryRules.snapshot.state === "missing"
            ? { relative_path: "AGENTS.md", state: "missing" }
            : {
                artifact_id: repositoryRules.snapshot.artifact.artifactId,
                bytes: repositoryRules.snapshot.contentBytes,
                content_sha256: repositoryRules.snapshot.contentSha256,
                object_ref: repositoryRules.snapshot.artifact.relativeRef,
                relative_path: "AGENTS.md",
                state: "loaded",
              },
        );
      } catch (error) {
        throw new EventPersistenceError(error);
      }
      if (config.verbose) {
        renderer.renderVerbose(
          repositoryRules.snapshot.state === "missing"
            ? "repository_rules path=AGENTS.md state=missing\n"
            : `repository_rules path=AGENTS.md sha256=${repositoryRules.snapshot.contentSha256}\n`,
        );
      }
      const nestedLoader = await NestedAgentsLoader.create(runtime.cwd, {
        artifactStore: {
          storeRepositoryRules: async (input) => {
            const stored = await artifactRuntime.materializeText({
              bytes: input.bytes,
              expectedSha256: input.expectedSha256,
              mediaType: input.mediaType,
              originEventId: manifestEventId,
            });
            return {
              artifactId: stored.artifactId,
              bytes: stored.bytes,
              relativeRef: stored.objectRef,
              sha256: stored.sha256,
            };
          },
        },
      });
      const nestedRules = await nestedLoader.loadForRun(
        sourceSnapshot.snapshot.sourceStateSha256,
        { preloadedRoot: repositoryRules },
      );
      nestedRepositoryRules = nestedRules;
      const manifestDescriptor = repositoryRuleManifestIdentityDescriptor(nestedRules.manifest);
      if (sha256Canonical(manifestDescriptor) !== nestedRules.manifest.manifestSha256) {
        throw new TypeError("repository rule manifest descriptor hash is inconsistent");
      }
      const manifestArtifact = await artifactRuntime.materializeText({
        bytes: Buffer.from(canonicalJson(manifestDescriptor), "utf8"),
        expectedSha256: nestedRules.manifest.manifestSha256,
        mediaType: "text/plain; charset=utf-8",
        originEventId: manifestEventId,
      });
      try {
        await writer.appendRunEventWithId(
          runId,
          manifestEventId,
          "repository.rules.manifest.loaded",
          {
            discovery_policy_sha256:
              nestedRules.manifest.discoveryPolicySha256,
            manifest_artifact_id: manifestArtifact.artifactId,
            manifest_object_ref: manifestArtifact.objectRef,
            manifest_sha256: nestedRules.manifest.manifestSha256,
            rule_count: nestedRules.manifest.entries.length,
            source_state_sha256: nestedRules.manifest.sourceStateSha256,
            total_content_bytes: nestedRules.totalContentBytes,
          },
        );
      } catch (error) {
        throw new EventPersistenceError(error);
      }
      ruleChangeDetector = new RepositoryRuleChangeDetector(
        nestedLoader,
        nestedRules,
      );
      repositoryRuleScopeResolver = new RepositoryRuleScopeResolver(
        nestedRules.manifest,
      );
      repositoryRuleObservationTracker = new RepositoryRuleObservationTracker(
        repositoryRuleScopeResolver,
      );
      for (const event of decodedEvents()) {
        if (
          event.type !== "tool.call.completed" ||
          event.data.repository_rule_binding === undefined ||
          event.data.repository_rule_binding.rule_manifest_sha256 !==
            nestedRules.manifest.manifestSha256
        ) {
          continue;
        }
        repositoryRuleObservationTracker.restore({
          ruleManifestSha256:
            event.data.repository_rule_binding.rule_manifest_sha256,
          ruleScopeTruncated:
            event.data.repository_rule_binding.rule_scope_truncated,
          targetScopes:
            event.data.repository_rule_binding.target_scopes.map((scope) => ({
              relativePath: scope.relative_path,
              scopeSha256: scope.scope_sha256,
            })),
        });
      }
      if (config.verbose) {
        renderer.renderVerbose(
          `repository_rule_manifest sha256=${nestedRules.manifest.manifestSha256} rules=${nestedRules.manifest.entries.length}\n`,
        );
      }
    }

    let rulesChangeRecorded = false;
    const persistRulesChange = async (
      change: RepositoryRuleManifestChange,
    ): Promise<void> => {
      if (!change.changed || rulesChangeRecorded) return;
      try {
        await writer.appendRunEvent!(runId, "repository.rules.changed", {
          change_scope: "manifest",
          current_identity_sha256:
            change.currentIdentity === null
              ? null
              : sha256Canonical(change.currentIdentity),
          frozen_manifest_sha256:
            repositoryRuleScopeResolver!.manifest.manifestSha256,
          reason: change.reason,
        });
      } catch (error) {
        throw new EventPersistenceError(error);
      }
      rulesChangeRecorded = true;
      if (config.verbose) {
        renderer.renderVerbose(`repository_rules changed reason=${change.reason}\n`);
      }
    };
    const assertRepositoryRulesFresh = async (): Promise<void> => {
      if (ruleChangeDetector === undefined) return;
      const change = await ruleChangeDetector.detect();
      if (!change.changed) return;
      await persistRulesChange(change);
      throw new RepositoryRulesStaleError();
    };

    const contextEvents: ContextEventAppender = {
      append: async <TType extends Phase10ContextRunEventType>(
        type: TType,
        data: Phase10ContextRunEventData<TType>,
      ): Promise<void> => {
        try {
          await writer.appendRunEvent!(runId, type, data);
        } catch (error) {
          throw new EventPersistenceError(error);
        }
        if (!config.verbose) return;
        if (type === "context.estimate.created") {
          const estimate = data as Phase10ContextRunEventData<"context.estimate.created">;
          renderer.renderVerbose(
            `context estimated_input_tokens=${estimate.estimated_input_tokens} absolute_input_tokens=${estimate.absolute_input_tokens} context_window_tokens=${estimate.context_window_tokens} epoch=${estimate.epoch}\n`,
          );
        } else if (type === "context.plan.created") {
          const plan = data as Phase10ContextRunEventData<"context.plan.created">;
          renderer.renderVerbose(
            `context_plan epoch=${plan.epoch} protected_tokens=${plan.protected_estimated_tokens} archived_items=${plan.archived_item_ids.length} compacted=${String(plan.compacted)}\n`,
          );
        }
      },
    };
    const existingPlans = decodedEvents().filter(
      (event) => event.type === "context.plan.created",
    );
    const initialContextEpoch = existingPlans.reduce(
      (maximum, event) => {
        const data = event.data as { readonly epoch?: unknown };
        return typeof data.epoch === "number" && Number.isSafeInteger(data.epoch)
          ? Math.max(maximum, data.epoch)
          : maximum;
      },
      0,
    );
    const context = new AgentContextController({
      backend,
      ...(ruleChangeDetector === undefined || repositoryRules === undefined
        ? {}
        : {
            beforePlan: async () => {
              await assertRepositoryRulesFresh();
            },
          }),
      eventAppender: contextEvents,
      events: decodedEvents,
      initialEpoch: initialContextEpoch,
      runtime: new AgentContextRuntime({
        budget: contextRuntimeResult.value.budget,
        estimator: contextRuntimeResult.value.estimator,
        capabilityContext: () => Object.freeze([
          ...(skillRuntime?.contextItems() ?? []),
          ...(mcpManager?.contextItems() ?? []),
        ]),
        ...(nestedRepositoryRules !== undefined &&
        repositoryRulesManifestEventId !== undefined &&
        repositoryRuleScopeResolver !== undefined &&
        repositoryRuleObservationTracker !== undefined
          ? {
              repositoryRuleContext: () =>
                selectRepositoryRuleContext(
                  nestedRepositoryRules!,
                  repositoryRuleScopeResolver!,
                  {
                    eventId: repositoryRulesManifestEventId!,
                    ...(repositoryRulesEventId === undefined
                      ? {}
                      : { rootEventId: repositoryRulesEventId }),
                    recency: (() => {
                      const event = decodedEvents().at(-1);
                      return event === undefined
                        ? 0
                        : "sessionSeq" in event
                          ? event.sessionSeq
                          : event.seq;
                    })(),
                    trustedTargetPaths:
                      repositoryRuleObservationTracker!.trustedTargetPaths(),
                  },
                ).items,
            }
          : repositoryRules === undefined || repositoryRulesEventId === undefined
            ? {}
            : { repositoryRules, repositoryRulesEventId }),
        systemInstructions: runInstructions,
        ...(phase16TaskState === undefined || phase16Binding === undefined
          ? {}
          : {
              taskContext: () => {
                const taskState = phase16TaskState();
                const goalChanges = projectGoalChangeLedger(
                  writer.readDecodedEvents!(),
                  phase16Binding.goal_id,
                  phase16Binding.goal_revision,
                );
                return {
                  projection: projectTaskContext({
                    ...(acceptedChildReceipts.length === 0
                      ? {}
                      : { acceptedChildReceipts }),
                    agentMode: phase16Binding.agent_mode,
                    ...(goalChanges === null
                      ? {}
                      : {
                          goalChanges: {
                            changedPaths: goalChanges.netChangedPaths,
                            ledgerSha256: goalChanges.ledgerSha256,
                          },
                        }),
                    taskState,
                  }),
                  recency: taskState.lastSessionSeq,
                  sourceEventIds: Object.freeze(
                    [
                      ...taskContextSourceEventIds(taskState),
                      ...(goalChanges === null
                        ? []
                        : [
                            goalChanges.baselineEventId,
                            ...goalChanges.records.map((record) => record.eventId),
                          ]),
                    ].sort((left, right) => left.localeCompare(right)),
                  ),
                };
              },
            }),
      }),
    });
    let additionalTools: readonly ToolRegistration<unknown>[] =
      skillRuntime === undefined ? [] : createSkillTools(skillRuntime);
    const mcpServerIds = config.mcpServerIds ?? [];
    if (mcpServerIds.length > 0) {
      if (
        runtime.createMcpClientManager === undefined ||
        writer.appendRunEvent === undefined
      ) {
        throw new McpCoreError(
          "mcp_config_invalid",
          "this runtime does not support durable MCP sessions",
        );
      }
      const loadedMcp = await new McpConfigLoader({ workspace: runtime.cwd }).load();
      const capabilityContent =
        capabilityPlatform === undefined || preparedCapabilitySnapshot === undefined
          ? undefined
          : capabilityPlatform.createContentSource(preparedCapabilitySnapshot.snapshot);
      const selected = await Promise.all(mcpServerIds.map(async (serverId) => {
        const configured = loadedMcp.status === "loaded"
          ? loadedMcp.servers[serverId]
          : undefined;
        if (configured !== undefined) return configured;
        const frozen = capabilityContent === undefined || preparedCapabilitySnapshot === undefined
          ? undefined
          : await createFrozenCapabilityMcpConfig({
              content: capabilityContent,
              hostExecutable: runtime.execPath,
              selector: serverId,
              snapshot: preparedCapabilitySnapshot.snapshot,
              workspace: runtime.cwd,
            });
        if (frozen === undefined) {
          throw new McpCoreError("mcp_config_invalid", `unknown MCP server id or frozen capability: ${serverId}`);
        }
        return frozen;
      }));
      const prompt = runtime.createApprovalPrompt();
      mcpManager = runtime.createMcpClientManager({
        ...(artifactRuntime === undefined ? {} : { artifacts: artifactRuntime }),
        events: {
          append: async (type, data, eventId) => {
            try {
              if (eventId !== undefined && writer.appendRunEventWithId !== undefined) {
                await writer.appendRunEventWithId(runId, eventId, type, data);
              } else {
                await writer.appendRunEvent!(runId, type, data);
              }
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          },
        },
        ...(hookRuntime === undefined ? {} : { hooks: hookRuntime }),
        prompt,
        recency: () => {
          const event = decodedEvents().at(-1);
          return event === undefined ? 0 : "sessionSeq" in event ? event.sessionSeq : event.seq;
        },
        secrets,
      });
      const mcpTools = await mcpManager.startSelected({
        configs: selected,
        reservedModelNames:
          config.taskProfile === "read-only"
            ? [
                "list_files",
                "read_artifact",
                "read_file",
                "search",
                ...(delegationProposalEnabled ? ["propose_delegation"] : []),
                ...additionalTools.map((tool) => tool.name),
              ]
            : [
                "apply_patch",
                "finish_task",
                "list_files",
                "read_artifact",
                "read_file",
                "run_command",
                "search",
                ...(delegationProposalEnabled ? ["propose_delegation"] : []),
                ...(phase16Binding === undefined ? [] : ["update_plan"]),
                ...additionalTools.map((tool) => tool.name),
              ],
        signal: userController.signal,
        workspaceRealPath:
          loadedMcp.status === "loaded" ? loadedMcp.workspaceRealPath : runtime.cwd,
      });
      additionalTools = Object.freeze([...additionalTools, ...mcpTools]);
      if (explicitMcpPrompt !== undefined) {
        if (writer.appendRunEventWithId === undefined) {
          throw new TypeError("Explicit MCP prompts require durable event IDs");
        }
        const promptRecord = mcpManager
          .listPrompts(explicitMcpPrompt.serverId)
          .find(
            (candidate) =>
              candidate.server_id === explicitMcpPrompt.serverId &&
              candidate.name === explicitMcpPrompt.promptName,
          );
        if (
          promptRecord === undefined ||
          typeof promptRecord.prompt_id !== "string"
        ) {
          throw new McpCoreError(
            "mcp_prompt_not_found",
            "MCP prompt selector has no exact frozen match",
          );
        }
        const invocationEventId = runtime.randomUUID();
        await writer.appendRunEventWithId(
          runId,
          invocationEventId,
          "mcp.prompt.user.invoked",
          {
            arguments_sha256: sha256Canonical(explicitMcpPrompt.argumentsValue),
            invocation_id: invocationEventId,
            selector: explicitMcpPrompt.selector,
            source: options.inputSurface === "tui" ? "tui" : "cli",
          },
        );
        await mcpManager.getPrompt({
          argumentsValue: explicitMcpPrompt.argumentsValue,
          invocationEventId,
          invocationSource: "explicit_user",
          promptId: promptRecord.prompt_id,
          signal: userController.signal,
        });
      }
    }
    const sandboxEvents: SandboxEventAppender | undefined =
      config.executor === "docker"
        ? writer.appendRunEvent === undefined
          ? undefined
          : {
              append: async <TType extends Phase13SandboxRunEventType>(
                type: TType,
                data: Phase13SandboxRunEventData<TType>,
              ): Promise<void> => {
                try {
                  await writer.appendRunEvent!(runId, type, data);
                } catch (error) {
                  throw new EventPersistenceError(error);
                }
              },
            }
        : undefined;
    if (config.executor === "docker" && sandboxEvents === undefined) {
      throw new TypeError("Docker executor requires durable Phase 13 event storage");
    }
    const updatePlanTool =
      phase16Binding === undefined || independentTaskExecution
        ? undefined
        : (() => {
            if (!(writer instanceof V2SessionWriter) || phase16TaskState === undefined) {
              throw new TypeError(
                "Phase 16 update_plan requires the durable V2 session writer",
              );
            }
            const binding = phase16Binding;
            return createUpdatePlanTool({
              context: (toolContext) => ({
                activeGoal: {
                  goalId: binding.goal_id,
                  revision: binding.goal_revision,
                },
                agentMode: binding.agent_mode,
                callId: toolContext.callId,
                runId,
                sessionId,
                step: toolContext.step,
                taskStateBeforeCall: phase16TaskState(),
                writer,
              }),
              store: new DurableAgentPlanStore(runtime.randomUUID),
            });
          })();
    const delegationProposalTool =
      !delegationProposalEnabled
        ? undefined
        : (() => {
            if (!(writer instanceof V2SessionWriter)) {
              throw new TypeError(
                "Phase 20 propose_delegation requires the durable V2 session writer",
              );
            }
            return createProposeDelegationTool({
              parentRunId: runId,
              randomUuid: runtime.randomUUID,
              sessionId,
              workspace: sessionWorkspace,
              writer,
            }) as ToolDefinition<unknown>;
          })();
    const repositoryNavigation = runtime.createRepositoryNavigationService === undefined
      ? undefined
      : await runtime.createRepositoryNavigationService(
          runtime.cwd,
          secrets.filter((value): value is string => value !== undefined),
          writer.appendRunEventWithId === undefined
            ? undefined
            : {
                indexInvalidated: async (data) => {
                  try {
                    await writer.appendRunEventWithId!(runId, runtime.randomUUID(), "repository.index.invalidated", data);
                  } catch (error) {
                    throw new EventPersistenceError(error);
                  }
                },
                indexSelected: async (data) => {
                  try {
                    await writer.appendRunEventWithId!(runId, runtime.randomUUID(), "repository.index.selected", data);
                  } catch (error) {
                    throw new EventPersistenceError(error);
                  }
                },
              },
        );
    if (repositoryNavigation !== undefined) {
      try {
        await repositoryNavigation.ensureCurrent({ allowBuild: false, signal: userController.signal });
      } catch (error) {
        if (
          !(error instanceof RepositoryIntelligenceError) ||
          !["repository_index_stale", "repository_index_corrupt"].includes(error.code)
        ) throw error;
      }
    }
    const baseTools = await runtime.createAgentToolRegistry({
      ...(additionalTools.length === 0 ? {} : { additionalTools }),
      approvalMode: config.editApproval,
      approvalPrompt: runtime.createApprovalPrompt(),
      ...(artifactRuntime === undefined ? {} : { artifactRuntime }),
      caseInsensitivePaths: runtime.platform === "win32",
      commandApprovalMode: config.commandApproval,
      commandTimeoutMs: config.commandTimeoutMs,
      ...(config.dockerSandbox === undefined
        ? {}
        : { dockerSandbox: config.dockerSandbox }),
      executorKind: config.executor,
      maxCommandOutputBytes: config.maxCommandOutputBytes,
      ...(hookRuntime === undefined ? {} : { hooks: hookRuntime }),
      ...(phase16Binding?.agent_mode !== "build" ||
        artifactRuntime === undefined ||
        goalChangeSeed === undefined ||
        phase16TaskState === undefined
        ? {}
        : {
            goalChange: {
              attributionScope: () => {
                const ledger = projectGoalChangeLedger(
                  writer.readDecodedEvents!(),
                  phase16Binding.goal_id,
                  phase16Binding.goal_revision,
                );
                if (ledger === null) {
                  throw new GoalChangeLedgerError(
                    "goal_change_baseline_invalid",
                    "Build completion requires its durable Goal execution baseline",
                  );
                }
                return goalChangeAttributionScope(ledger);
              },
              beforeCapture: (plan) => {
                const ledger = projectGoalChangeLedger(
                  writer.readDecodedEvents!(),
                  phase16Binding.goal_id,
                  phase16Binding.goal_revision,
                );
                if (ledger === null) {
                  throw new GoalChangeLedgerError(
                    "goal_change_baseline_invalid",
                    "Build patch requires its durable Goal execution baseline",
                  );
                }
                assertGoalChangePlanPreflight(ledger, plan, runId);
              },
              completionPolicy: independentTaskExecution
                ? new VerifiedCompletionPolicy()
                : new CollaborativeCompletionPolicy({
                    base: new VerifiedCompletionPolicy(),
                    delegations: () =>
                      reconstructMultiRunSession(writer.readDecodedEvents!()).delegations,
                    goalChanges: async () => {
                      const ledger = projectGoalChangeLedger(
                        writer.readDecodedEvents!(),
                        phase16Binding.goal_id,
                        phase16Binding.goal_revision,
                      );
                      if (ledger === null) {
                        throw new GoalChangeLedgerError(
                          "goal_change_baseline_invalid",
                          "Build completion requires its durable Goal execution baseline",
                        );
                      }
                      await assertGoalChangeWorkspaceMatches(ledger, runtime.cwd);
                      return ledger;
                    },
                    runBinding: phase16Binding,
                    taskState: phase16TaskState,
                  }),
              goalId: phase16Binding.goal_id,
              goalRevision: phase16Binding.goal_revision,
              seed: goalChangeSeed,
            },
          }),
      modelEvidence:
        modelEvidence ?? {
          backend: "fake",
          endpointScope: "in_process",
          kind: "contract_verified",
          remoteBillableRequests: 0,
        },
      now: runtime.now,
      publisher,
      randomUUID: runtime.randomUUID,
      ...(repositoryRuleScopeResolver === undefined ||
      repositoryRuleObservationTracker === undefined
        ? {}
        : {
            repositoryRules: {
              assertFresh: assertRepositoryRulesFresh,
              resolver: repositoryRuleScopeResolver,
              tracker: repositoryRuleObservationTracker,
            },
          }),
      ...(repositoryNavigation === undefined ? {} : { repositoryNavigation }),
      reportFormat: config.reportFormat,
      runId,
      ...(sandboxEvents === undefined ? {} : { sandboxEvents }),
      secrets,
      taskProfile: config.taskProfile,
        ...(independentTaskExecution ? { taskNodeExecution: true } : {}),
      ...(delegationProposalTool === undefined ? {} : { delegationProposalTool }),
      ...(updatePlanTool === undefined ? {} : { updatePlanTool }),
      sessionId,
      timestamp: runtime.timestamp,
      workspace: runtime.cwd,
    });
    if (
      freshTaskExecution?.delegatedToolIds !== undefined &&
      freshTaskExecution.delegatedToolProfileSha256 !== undefined
    ) {
      const runtimeProfile = buildChildToolProfile({
        taskProfile: config.taskProfile,
        requestedToolIds: freshTaskExecution.delegatedToolIds,
        policyToolIds: freshTaskExecution.delegatedToolIds,
        parentDelegableToolIds: freshTaskExecution.delegatedToolIds,
        catalog: delegatedRuntimeToolCatalog(baseTools.modelDefinitions),
      });
      if (runtimeProfile.profileSha256 !== freshTaskExecution.delegatedToolProfileSha256) {
        throw new TypeError("delegated tool schemas differ from the frozen child profile");
      }
    }
    const tools = freshTaskExecution?.delegatedToolIds === undefined
      ? baseTools
      : new RestrictedToolRegistry(baseTools, freshTaskExecution.delegatedToolIds);
    const turnBoundaryRecorder = createTurnBoundaryRecorder(
      writer,
      backend,
      runtime.cwd,
      runtime.createCheckpointStore === undefined
        ? {}
        : { createCheckpointStore: runtime.createCheckpointStore },
    );
    const outcome = await runAgentLoop(
      resumedExecution?.modelTask ?? freshTaskExecution?.modelTask ?? config.task,
      config,
      {
        ...(applicationCancellation === undefined
          ? {}
          : {
              applicationCancelRequest: applicationCancellation.terminalBinding,
              ...(applicationCancellation.hostEmergencyReason === undefined
                ? {}
                : { hostEmergencyReason: applicationCancellation.hostEmergencyReason }),
            }),
        ...(phase16Binding === undefined
          ? {}
          : { agentMode: phase16Binding.agent_mode }),
        budget,
        ...(independentTaskExecution || phase16Binding?.agent_mode !== "build" ||
        phase16TaskState === undefined ||
        writer.appendTaskEvent === undefined
          ? {}
          : {
              beforeVerifiedRunCompleted: async (accepted) => {
                const evaluated = [...writer.readDecodedEvents!()]
                  .reverse()
                  .find(
                    (event) =>
                      event.scope === "run" &&
                      event.runId === runId &&
                      event.type === "completion.evaluated" &&
                      event.data.effect === "accept" &&
                      event.data.call_id === accepted.callId,
                  );
                if (
                  evaluated === undefined ||
                  evaluated.scope !== "run" ||
                  evaluated.type !== "completion.evaluated"
                ) {
                  throw new Error(
                    "accepted completion has no exact durable evaluation event",
                  );
                }
                const state = phase16TaskState();
                const goal = state.goals.find(
                  (candidate) =>
                    candidate.content.goalId === phase16Binding.goal_id &&
                    candidate.content.revision === phase16Binding.goal_revision,
                );
                if (goal?.status !== "active") {
                  throw new Error("accepted completion Goal is no longer active");
                }
                try {
                  if (state.currentApprovedPlan !== null) {
                    const plan = state.currentApprovedPlan;
                    await writer.appendTaskEvent!("plan.completed", {
                      completion_evaluated_event_id: evaluated.eventId,
                      finish_task_call_id: accepted.callId,
                      goal_id: plan.goalId,
                      goal_revision: plan.goalRevision,
                      origin: { kind: "host_completion" },
                      plan_id: plan.planId,
                      plan_sha256: plan.planSha256,
                      revision: plan.revision,
                    });
                  }
                  await writer.appendTaskEvent!("goal.status.changed", {
                    completion_evaluated_event_id: evaluated.eventId,
                    finish_task_call_id: accepted.callId,
                    from: "active",
                    goal_id: phase16Binding.goal_id,
                    origin: { kind: "host_completion" },
                    revision: phase16Binding.goal_revision,
                    to: "completed",
                  });
                } catch (error) {
                  throw new EventPersistenceError(error);
                }
              },
            }),
        clock: runtime,
        context,
        instructions: runInstructions,
        model: backend,
        ...(resumedExecution?.inheritedCall !== null &&
        resumedExecution?.inheritedCall !== undefined
          ? { inheritedCall: resumedExecution.inheritedCall }
          : resumedExecution?.mode === "exact"
          ? {
              initialInput: {
                continuation:
                  resumedExecution.continuation ??
                  (() => {
                    throw new TypeError("exact resume requires a decoded checkpoint");
                  })(),
                kind: "resume_prompt" as const,
                text: resumedExecution.modelTask,
              },
            }
          : {}),
        ...(turnBoundaryRecorder === undefined
          ? {}
          : { persistTurnBoundary: turnBoundaryRecorder }),
        publisher,
        secrets,
        ...(phase16TaskState === undefined
          ? {}
          : { taskState: phase16TaskState }),
        tools,
      },
      userController.signal,
    );
    await terminator.terminate(outcome.terminal, outcome.terminalEvent);
    // PHASE16: the Goal-level OutcomeReport is the only product report for
    // tracked runs. Legacy runs retain the Phase7 RunReport surface.
    if (phase16Binding === undefined && outcome.completionReport !== undefined) {
      renderer.renderLegacyCompletionReport(
        outcome.completionReport.report,
        outcome.completionReport.terminal,
      );
    }
    exitCode = outcome.terminal.exitCode;
  } catch (error) {
    const wasUserCancelled = userController.signal.aborted;
    const hostEmergencyReason = applicationCancellation?.hostEmergencyReason?.();
    if (!wasUserCancelled) userController.abort();
    const classification = classifyRunExecutionError(error, {
      hostEmergencyReason,
      wasUserCancelled,
    });
    const snapshot = budget.snapshot();
    const publishFallback = async (
      terminal: AgentTerminal,
      event: TerminalRunEventDraftV1,
      diagnostic = "internal protocol error",
    ): Promise<boolean> => {
      try {
        await terminator.terminate(terminal, event);
        return true;
      } catch (publishError) {
        if (
          publishError instanceof EventPersistenceError ||
          (publishError instanceof RunTerminationStateError &&
            publishError.state === "persistence_failed")
        ) {
          terminator.markPersistenceFailed();
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic(diagnostic);
        }
        return false;
      }
    };

    switch (classification.kind) {
      case "persistence":
        // AS5.1: once writer persistence fails, RunTerminator permanently
        // forbids a compensating terminal write.
        terminator.markPersistenceFailed();
        renderer.renderStorageError();
        exitCode = 1;
        break;
      case "storage":
        terminator.markPersistenceFailed();
        renderer.renderStorageError();
        if (classification.workspaceMayHaveChanged) {
          renderer.renderDiagnostic(
            "workspace may have changed; inspect the run-local diff before continuing",
          );
        }
        exitCode = 1;
        break;
      case "host_surface_fatal":
        await publishFallback(
          { exitCode: 1, type: "failed" },
          {
            data: {
              category: "internal",
              code: "tui_surface_fatal",
              duration_ms: snapshot.elapsedMs,
              message: "TUI surface failed while this exact Host owner was active",
              output_chars: publisher.outputLength,
              retryable: false,
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.failed",
          },
        );
        exitCode = 1;
        break;
      case "user_cancelled": {
        const binding = applicationCancellation?.terminalBinding();
        const published = await publishFallback(
          { exitCode: 130, type: "cancelled" },
          {
            data: {
              ...(binding === undefined
                ? {}
                : { application_cancel_request: binding }),
              duration_ms: snapshot.elapsedMs,
              output_chars: publisher.outputLength,
              reason: "user",
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.cancelled",
          },
        );
        exitCode = published ? 130 : 1;
        break;
      }
      case "ambiguous_effect": {
        const commandStateUnknown =
          classification.effect === "ambiguous_command_state";
        const mcpStateUnknown = classification.effect === "ambiguous_mcp_state";
        await publishFallback(
          { exitCode: 1, type: "failed" },
          {
            data: {
              category: "internal",
              code: classification.effect,
              duration_ms: snapshot.elapsedMs,
              message: commandStateUnknown
                ? "command effect or process cleanup is ambiguous; inspect the workspace and running processes before continuing"
                : mcpStateUnknown
                  ? "MCP call effect is ambiguous; inspect external effects before resuming"
                  : "workspace state is ambiguous; inspect the diff before continuing",
              output_chars: publisher.outputLength,
              retryable: false,
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.failed",
          },
          commandStateUnknown
            ? "command effect or process cleanup is ambiguous"
            : mcpStateUnknown
              ? "MCP call effect is ambiguous"
              : "workspace state is ambiguous",
        );
        exitCode = 1;
        break;
      }
      case "hook": {
        const published = await publishFallback(
          { exitCode: 8, reason: "task_blocked", type: "incomplete" },
          {
            data: {
              duration_ms: snapshot.elapsedMs,
              output_chars: publisher.outputLength,
              reason: "task_blocked",
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.incomplete",
          },
        );
        if (published) {
          renderer.renderDiagnostic(
            `${classification.error.code}: ${classification.error.message}`,
          );
        }
        exitCode = published ? 8 : 1;
        break;
      }
      case "mcp":
        await publishFallback(
          { exitCode: 1, type: "failed" },
          {
            data: {
              category:
                classification.error.code === "mcp_approval_denied" ||
                classification.error.code === "mcp_permission_denied"
                  ? "permission"
                  : "protocol",
              code: classification.error.code,
              duration_ms: snapshot.elapsedMs,
              message: classification.error.message.slice(0, 500),
              output_chars: publisher.outputLength,
              retryable: false,
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.failed",
          },
        );
        exitCode = 1;
        break;
      case "internal":
        await publishFallback(
          { exitCode: 1, type: "failed" },
          {
            data: {
              category: "internal",
              code: "internal_error",
              duration_ms: snapshot.elapsedMs,
              message: "internal protocol error",
              output_chars: publisher.outputLength,
              retryable: false,
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.failed",
          },
        );
        exitCode = 1;
        break;
    }
  } finally {
    const failures = await resources.closePhase("runtime");
    for (const failure of failures) {
      renderer.renderDiagnostic(
        failure.name === "mcp"
          ? "MCP process cleanup could not be verified"
          : failure.name === "capability-content-leases"
            ? "capability content lease cleanup could not be verified"
            : "run listener cleanup could not be verified",
      );
      exitCode = 1;
    }
  }

  if (phase16Binding !== undefined && writer.readDecodedEvents !== undefined) {
    try {
      const outcome = new OutcomeReportBuilder().build(
        reconstructMultiRunSession(writer.readDecodedEvents()),
      );
      renderer.renderOutcomeReport(outcome, exitCode === 0);
    } catch {
      renderer.renderDiagnostic("Phase 16 OutcomeReport projection failed");
      exitCode = 1;
    }
  }

  const writerFailures = await resources.closePhase("persistence");
  if (writerFailures.length > 0) {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
