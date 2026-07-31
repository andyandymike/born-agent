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
} from "../agent/agent-types.js";
import { BudgetTracker } from "../agent/budget-tracker.js";
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
import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  EventPersistenceError,
  EventPublisher,
} from "../events/event-publisher.js";
import type { RunEvent } from "../events/run-event.js";
import { ConsoleEventRenderer } from "../render/console-event-renderer.js";
import {
  BackendPreflightError,
} from "../model/backend-factory.js";
import type {
  BackendContinuation,
  ModelBackend,
} from "../model/model-backend.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { createTurnBoundaryRecorder } from "../sessions/turn-boundary-recorder.js";
import {
  FatalToolExecutionError,
  type RegisteredTool,
} from "../tools/tool-types.js";
import { McpConfigLoader } from "../mcp/mcp-config-loader.js";
import { McpCoreError } from "../mcp/mcp-errors.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
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
import type { RepositoryRulesChangeDetection } from "../repository-rules/repository-rule-set.js";
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
import { OutcomeReportBuilder } from "../coordination/outcome-report.js";
import { renderOutcomeReport } from "../coordination/outcome-report-renderer.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";

export interface ResumedAgentExecution {
  readonly backend: ModelBackend;
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
  readonly modelTask: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly writer: SessionWriter;
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

export async function executeAgent(
  options: AgentCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
  resumedExecution?: ResumedAgentExecution,
  freshTaskExecution?: FreshTaskExecution,
): Promise<AgentExitCode> {
  // PHASE4: 命令边界负责配置、真实资源装配和关闭；循环策略全部下沉到 runAgentLoop。
  const renderer = new ConsoleEventRenderer(io, options.verbose);
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
  const phase16Requested = options.mode !== undefined;
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
    ...(phase16Requested ? { taskProfile: modeTaskProfile } : {}),
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
  let writer: SessionWriter;
  try {
    writer =
      resumedExecution?.writer ??
      freshTaskExecution?.writer ??
      (await runtime.createSessionWriter(runtime.cwd, sessionId));
    runtime.observeSessionWriter?.(writer);
  } catch {
    renderer.renderStorageError();
    return 1;
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
          origin: {
            input_surface: options.inputSurface ?? "cli",
            kind: "user",
          },
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
  // PHASE4: CLI 的 SIGINT 只转成用户 signal；AgentLoop 再负责映射 run.cancelled/130。
  const stopListening = runtime.onCancel(() => userController.abort());
  let exitCode: AgentExitCode;
  let mcpManager: McpClientManager | undefined;

  try {
    // PHASE4: run.started 先保存完整预算合同；后续重建器据此验证每个 budget terminal。
    const runStartedData: Extract<
      RunEvent,
      { type: "run.started" }
    >["data"] = {
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
        ...(resumedExecution === undefined
          ? {}
          : {
              resume_mode: resumedExecution.mode,
              resume_of_run_id: resumedExecution.sourceRunId,
            }),
        report_format: config.reportFormat,
        require_verification: config.requireVerification,
        request_timeout_ms: config.requestTimeoutMs,
        task_profile: config.taskProfile,
        tools:
          phase16Binding?.agent_mode === "plan"
            ? [
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                "search",
                "update_plan",
              ]
            : config.taskProfile === "read-only"
            ? [
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                "search",
              ]
            : [
                "apply_patch",
                "finish_task",
                "list_files",
                "read_file",
                ...(writer.appendArtifactEvent === undefined
                  ? []
                  : ["read_artifact"]),
                "run_command",
                "search",
                ...(phase16Binding === undefined ? [] : ["update_plan"]),
              ],
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
    if (phase16Binding === undefined) {
      await publisher.publish({ data: runStartedData, type: "run.started" });
    } else {
      await publisher.publishPhase16RunStarted(
        runStartedData,
        phase16Binding,
      );
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
    const decodedEvents = () => writer.readDecodedEvents?.() ?? publisher.events;
    const runInstructions =
      phase16Binding === undefined
        ? config.taskProfile === "read-only"
          ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
          : AGENT_SYSTEM_INSTRUCTIONS
        : systemInstructionsForAgentMode(phase16Binding.agent_mode);
    const phase16TaskState =
      phase16Binding === undefined || writer.readDecodedEvents === undefined
        ? undefined
        : () => TaskStateMachine.project(writer.readDecodedEvents!());
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
            workspace: runtime.cwd,
          });
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

    let rulesLoader: RootAgentsLoader | undefined;
    let repositoryRules;
    let repositoryRulesEventId: string | undefined;
    if (
      artifactRuntime !== undefined &&
      writer.appendRunEventWithId !== undefined
    ) {
      const rulesEventId = runtime.randomUUID();
      repositoryRulesEventId = rulesEventId;
      rulesLoader = await RootAgentsLoader.create(runtime.cwd, {
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
        io.stderr.write(
          repositoryRules.snapshot.state === "missing"
            ? "repository_rules path=AGENTS.md state=missing\n"
            : `repository_rules path=AGENTS.md sha256=${repositoryRules.snapshot.contentSha256}\n`,
        );
      }
    }

    let rulesChangeRecorded = false;
    const persistRulesChange = async (
      change: RepositoryRulesChangeDetection,
    ): Promise<void> => {
      if (!change.changed || rulesChangeRecorded) return;
      const current = change.current;
      try {
        await writer.appendRunEvent!(runId, "repository.rules.changed", {
          ...(current.state === "loaded"
            ? { current_content_sha256: current.contentSha256 }
            : current.state === "missing"
              ? { current_content_sha256: null }
              : { current_error_code: current.errorCode }),
          current_state: current.state,
          frozen_content_sha256:
            change.frozen.state === "loaded"
              ? change.frozen.contentSha256
              : null,
          frozen_state: change.frozen.state,
          reason: change.reason,
          relative_path: "AGENTS.md",
        });
      } catch (error) {
        throw new EventPersistenceError(error);
      }
      rulesChangeRecorded = true;
      if (config.verbose) {
        io.stderr.write(`repository_rules changed reason=${change.reason}\n`);
      }
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
          io.stderr.write(
            `context estimated_input_tokens=${estimate.estimated_input_tokens} absolute_input_tokens=${estimate.absolute_input_tokens} context_window_tokens=${estimate.context_window_tokens} epoch=${estimate.epoch}\n`,
          );
        } else if (type === "context.plan.created") {
          const plan = data as Phase10ContextRunEventData<"context.plan.created">;
          io.stderr.write(
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
      ...(rulesLoader === undefined || repositoryRules === undefined
        ? {}
        : {
            beforePlan: async () => {
              await persistRulesChange(
                await rulesLoader!.detectChange(repositoryRules!),
              );
            },
          }),
      eventAppender: contextEvents,
      events: decodedEvents,
      initialEpoch: initialContextEpoch,
      runtime: new AgentContextRuntime({
        budget: contextRuntimeResult.value.budget,
        estimator: contextRuntimeResult.value.estimator,
        ...(repositoryRules === undefined ? {} : { repositoryRules }),
        ...(repositoryRulesEventId === undefined
          ? {}
          : { repositoryRulesEventId }),
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
    let additionalTools: readonly RegisteredTool[] = [];
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
      if (loadedMcp.status === "missing") {
        throw new McpCoreError("mcp_config_missing", "local MCP config is missing");
      }
      const selected = mcpServerIds.map((serverId) => {
        const server = loadedMcp.servers[serverId];
        if (server === undefined) {
          throw new McpCoreError("mcp_config_invalid", `unknown MCP server id: ${serverId}`);
        }
        return server;
      });
      const prompt = runtime.createApprovalPrompt(io);
      mcpManager = runtime.createMcpClientManager({
        events: {
          append: async (type, data) => {
            try {
              await writer.appendRunEvent!(runId, type, data);
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          },
        },
        prompt,
        secrets,
      });
      additionalTools = await mcpManager.startSelected({
        configs: selected,
        reservedModelNames:
          config.taskProfile === "read-only"
            ? ["list_files", "read_artifact", "read_file", "search"]
            : [
                "apply_patch",
                "finish_task",
                "list_files",
                "read_artifact",
                "read_file",
                "run_command",
                "search",
                ...(phase16Binding === undefined ? [] : ["update_plan"]),
              ],
        signal: userController.signal,
        workspaceRealPath: loadedMcp.workspaceRealPath,
      });
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
      phase16Binding === undefined
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
    const tools = await runtime.createAgentToolRegistry({
      ...(additionalTools.length === 0 ? {} : { additionalTools }),
      approvalMode: config.editApproval,
      approvalPrompt: runtime.createApprovalPrompt(io),
      ...(artifactRuntime === undefined ? {} : { artifactRuntime }),
      caseInsensitivePaths: runtime.platform === "win32",
      commandApprovalMode: config.commandApproval,
      commandTimeoutMs: config.commandTimeoutMs,
      ...(config.dockerSandbox === undefined
        ? {}
        : { dockerSandbox: config.dockerSandbox }),
      executorKind: config.executor,
      maxCommandOutputBytes: config.maxCommandOutputBytes,
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
              completionPolicy: new CollaborativeCompletionPolicy({
                base: new VerifiedCompletionPolicy(),
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
      reportFormat: config.reportFormat,
      runId,
      ...(sandboxEvents === undefined ? {} : { sandboxEvents }),
      secrets,
      taskProfile: config.taskProfile,
      ...(updatePlanTool === undefined ? {} : { updatePlanTool }),
      sessionId,
      timestamp: runtime.timestamp,
      workspace: runtime.cwd,
    });
    const turnBoundaryRecorder = createTurnBoundaryRecorder(
      writer,
      backend,
      runtime.cwd,
      runtime.createCheckpointStore === undefined
        ? {}
        : { createCheckpointStore: runtime.createCheckpointStore },
    );
    const terminal = await runAgentLoop(
      resumedExecution?.modelTask ?? freshTaskExecution?.modelTask ?? config.task,
      config,
      {
        ...(phase16Binding === undefined
          ? {}
          : { agentMode: phase16Binding.agent_mode }),
        budget,
        ...(phase16Binding?.agent_mode !== "build" ||
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
        renderCompletionReport: (report, terminal) => {
          // PHASE16: the Goal-level OutcomeReport is the only product report
          // for tracked runs. Legacy runs retain the Phase7 RunReport surface.
          if (phase16Binding === undefined) {
            (terminal === "completed" ? io.stdout : io.stderr).write(report);
          }
        },
        secrets,
        ...(phase16TaskState === undefined
          ? {}
          : { taskState: phase16TaskState }),
        tools,
      },
      userController.signal,
    );
    exitCode = terminal.exitCode;
  } catch (error) {
    // PHASE4: EventPersistenceError 表示 writer 已不可信，不能尝试再补 terminal event。
    const wasUserCancelled = userController.signal.aborted;
    if (!wasUserCancelled) userController.abort();
    if (error instanceof EventPersistenceError) {
      renderer.renderStorageError();
      exitCode = 1;
    } else if (error instanceof FatalToolExecutionError && error.kind === "storage") {
      renderer.renderStorageError();
      if (error.workspaceMayHaveChanged) {
        renderer.renderDiagnostic(
          "workspace may have changed; inspect the run-local diff before continuing",
        );
      }
      exitCode = 1;
    } else if (
      error instanceof FatalToolExecutionError &&
      error.kind === "user_cancelled"
    ) {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            duration_ms: snapshot.elapsedMs,
            output_chars: publisher.outputLength,
            reason: "user",
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.cancelled",
        });
        exitCode = 130;
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
        exitCode = 1;
      }
    } else if (error instanceof FatalToolExecutionError) {
      const commandStateUnknown =
        error.kind === "ambiguous_command_state";
      const mcpStateUnknown = error.kind === "ambiguous_mcp_state";
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            category: "internal",
            code: commandStateUnknown
              ? "ambiguous_command_state"
              : mcpStateUnknown
                ? "ambiguous_mcp_state"
                : "ambiguous_patch_state",
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
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic(
            commandStateUnknown
              ? "command effect or process cleanup is ambiguous"
              : mcpStateUnknown
                ? "MCP call effect is ambiguous"
                : "workspace state is ambiguous",
          );
        }
      }
      exitCode = 1;
    } else if (error instanceof McpCoreError) {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            category:
              error.code === "mcp_approval_denied" ||
              error.code === "mcp_permission_denied"
                ? "permission"
                : "protocol",
            code: error.code,
            duration_ms: snapshot.elapsedMs,
            message: error.message.slice(0, 500),
            output_chars: publisher.outputLength,
            retryable: false,
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.failed",
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        }
      }
      exitCode = 1;
    } else if (wasUserCancelled) {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            duration_ms: snapshot.elapsedMs,
            output_chars: publisher.outputLength,
            reason: "user",
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.cancelled",
        });
        exitCode = 130;
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
        exitCode = 1;
      }
    } else {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
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
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
      }
      exitCode = 1;
    }
  } finally {
    stopListening();
    if (mcpManager !== undefined) {
      try {
        await mcpManager.stopAll();
      } catch {
        renderer.renderDiagnostic("MCP process cleanup could not be verified");
        exitCode = 1;
      }
    }
  }

  if (phase16Binding !== undefined && writer.readDecodedEvents !== undefined) {
    try {
      const outcome = new OutcomeReportBuilder().build(
        reconstructMultiRunSession(writer.readDecodedEvents()),
      );
      const rendered = renderOutcomeReport(outcome, config.reportFormat);
      (exitCode === 0 ? io.stdout : io.stderr).write(rendered);
    } catch {
      renderer.renderDiagnostic("Phase 16 OutcomeReport projection failed");
      exitCode = 1;
    }
  }

  try {
    await writer.close();
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
