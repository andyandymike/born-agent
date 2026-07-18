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
import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  EventPersistenceError,
  EventPublisher,
} from "../events/event-publisher.js";
import { ConsoleEventRenderer } from "../render/console-event-renderer.js";
import {
  BackendPreflightError,
} from "../model/backend-factory.js";
import type {
  BackendContinuation,
  ModelBackend,
} from "../model/model-backend.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
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

async function closeResumedWriter(
  execution: ResumedAgentExecution | undefined,
): Promise<void> {
  await execution?.writer.close().catch(() => undefined);
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
      await closeResumedWriter(resumedExecution);
      return error.exitCode;
    }
    renderer.renderDiagnostic("runtime policy internal error");
    await closeResumedWriter(resumedExecution);
    return 1;
  }
  let resolvedOptions = options;
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
        await closeResumedWriter(resumedExecution);
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
          await closeResumedWriter(resumedExecution);
          return error.exitCode;
        }
        renderer.renderDiagnostic("docker_acquisition_internal: Docker acquisition failed internally");
        await closeResumedWriter(resumedExecution);
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
    await closeResumedWriter(resumedExecution);
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
  let backend: ModelBackend;
  try {
    // PHASE8: factory preflight freezes one provider/model and proves required
    // tools, complete usage and cancellation before a session or request exists.
    backend =
      resumedExecution?.backend ??
      runtime.createModelBackend({
        ...(policyRequest.endpoint === undefined ? {} : { endpoint: policyRequest.endpoint }),
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
      await closeResumedWriter(resumedExecution);
      return error.exitCode;
    }
    if (
      error instanceof Error &&
      "exitCode" in error &&
      (error.exitCode === 2 || error.exitCode === 4)
    ) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      await closeResumedWriter(resumedExecution);
      return error.exitCode;
    }
    renderer.renderDiagnostic("internal protocol error");
    await closeResumedWriter(resumedExecution);
    return 1;
  }
  const secrets = credentialSecretsForPolicy(
    effectivePolicy,
    config.provider,
    runtime.env,
  );
  const modelEvidence = runtime.agentModelEvidence(config.provider);
  if (config.taskProfile === "coding" && modelEvidence === null) {
    renderer.renderDiagnostic(
      "usage/config error: coding profile requires a deterministic fake backend or literal-loopback Ollama",
    );
    await closeResumedWriter(resumedExecution);
    return 2;
  }
  const contextRuntimeResult = resolveAgentContextRuntime(
    config,
    backend.contextCapacity,
  );
  if (!contextRuntimeResult.ok) {
    renderer.renderDiagnostic(
      `usage/config error: ${contextRuntimeResult.error}`,
    );
    await closeResumedWriter(resumedExecution);
    return 2;
  }
  const sessionId = resumedExecution?.sessionId ?? runtime.randomUUID();
  const runId = resumedExecution?.runId ?? runtime.randomUUID();
  let workspaceResumeFingerprint = resumedExecution?.fingerprint;
  if (workspaceResumeFingerprint === undefined) {
    try {
      workspaceResumeFingerprint = await buildWorkspaceResumeFingerprint({
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
  let writer: SessionWriter;
  try {
    writer =
      resumedExecution?.writer ??
      (await runtime.createSessionWriter(runtime.cwd, sessionId));
    runtime.observeSessionWriter?.(writer);
  } catch {
    renderer.renderStorageError();
    return 1;
  }

  const publisher = new EventPublisher({
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
    await publisher.publish({
      data: {
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
          config.taskProfile === "read-only"
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
      },
      type: "run.started",
    });
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
                  await writer.appendArtifactEvent!(eventRunId, event);
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
        systemInstructions:
          config.taskProfile === "read-only"
            ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
            : AGENT_SYSTEM_INSTRUCTIONS,
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
      resumedExecution?.modelTask ?? config.task,
      config,
      {
        budget,
        clock: runtime,
        context,
        instructions:
          config.taskProfile === "read-only"
            ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
            : AGENT_SYSTEM_INSTRUCTIONS,
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
        renderCompletionReport: (report, terminal) =>
          terminal === "completed"
            ? io.stdout.write(report)
            : io.stderr.write(report),
        secrets,
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

  try {
    await writer.close();
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
