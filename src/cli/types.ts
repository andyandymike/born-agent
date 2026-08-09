import type { StreamingChatRuntime } from "../chat/run-streaming-chat.js";
import type { DoctorRuntime } from "../doctor/types.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { AgentToolRegistryOptions } from "../tools/create-agent-tool-registry.js";
import type { ToolRegistryLike } from "../tools/tool-types.js";
import type { ChatProvider } from "../chat/types.js";
import type { ModelEvidence } from "../completion/completion-types.js";
import type { CheckpointStore } from "../checkpoints/checkpoint-store.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import type { TuiHost } from "../tui/tui-host.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { McpEventAppender } from "../mcp/mcp-approval-gate.js";
import type {
  OllamaLocalCatalogRefreshRequest,
  OllamaLocalModelDiscovery,
} from "../providers/pi/ollama-local-catalog-port.js";
import type { ResolvedDockerSandboxConfig } from "../agent/agent-types.js";
import type { DockerSandboxDoctorReport } from "../execution/docker/docker-doctor.js";
import type { EvalCliRuntime } from "../evals/eval-cli.js";
import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import type {
  ContainerRecoveryEventAppender,
  ContainerRecoveryResult,
} from "../execution/docker/container-reconciliation-runtime.js";
import type { DockerArtifactAcquirer } from "../execution/docker/acquisition/docker-artifact-acquirer.js";
import type { ModelQualificationGate } from "../model/model-qualification-gate.js";
import type { RepositoryNavigationEventSink, RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import type { CapabilityPlatformLike } from "../capabilities/capability-platform.js";
import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { EffectHookPipeline } from "../hooks/hook-pipeline.js";
import type { PluginLifecycleLike } from "../plugins/plugin-lifecycle.js";
import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import type { HookCommandRunnerLike } from "../hooks/hook-command-runner.js";
import type { TaskAttemptExecutor } from "../scheduling/deterministic-task-scheduler.js";
import type { ManagedWorktreeManager } from "../worktrees/managed-worktree-manager.js";
import type { WorktreePromotionRuntime } from "../worktrees/promotion-runtime.js";
import type { BackgroundWorkerLauncher } from "../background/background-worker-launcher.js";
import type { BackgroundWorkerRuntimeResultV1 } from "../background/background-worker-runtime.js";
import type { BackgroundWorkerLiveObservationV1 } from "../background/background-worker-live-status.js";
import type { BackgroundExecutableDescriptorV1 } from "../background/background-schema.js";
import type { TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { HookCommandOperationReconciliationResult } from "../hooks/hook-command-operation-reconciler.js";
import type { PluginLeaseReconciliationResultV1 } from "../plugins/plugin-lifecycle.js";
import type { BackgroundWorkerTakeoverResultV1 } from "../background/background-worker-takeover.js";

export interface OutputWriter {
  write(value: string): void;
}

export interface CliIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}

export interface CliRuntime extends StreamingChatRuntime, DoctorRuntime {
  readonly hooksSuppressed?: boolean;
  agentModelEvidence(provider: ChatProvider): ModelEvidence | null;
  createAgentToolRegistry(
    options: AgentToolRegistryOptions,
  ): Promise<ToolRegistryLike>;
  readonly createRepositoryNavigationService?: (
    workspace: string,
    secrets: readonly string[],
    events?: RepositoryNavigationEventSink,
  ) => Promise<RepositoryNavigationService>;
  createApprovalPrompt(io: CliIO): ApprovalPrompt;
  readonly createCapabilityPlatform?: (
    workspace: string,
  ) => CapabilityPlatformLike;
  readonly createHookCommandRunner?: (options: {
    readonly content: FrozenCapabilityContentSource;
    readonly prompt: ApprovalPrompt;
    readonly secrets: readonly (string | undefined)[];
    readonly workspace: string;
  }) => HookCommandRunnerLike;
  readonly runInternalHookCommandSupervisor?: (input: {
    readonly invocationId: string;
    readonly runId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly reconcileHookCommandOperations?: (input: {
    readonly sessionId: string;
    readonly writer: V2SessionWriter;
  }) => Promise<HookCommandOperationReconciliationResult>;
  readonly reconcilePluginLeases?: (input: {
    readonly sessionId: string;
    readonly writer: V2SessionWriter;
  }) => Promise<PluginLeaseReconciliationResultV1>;
  readonly reconcileBackgroundWorkerTakeover?: (input: {
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly sessionId: string;
  }) => Promise<BackgroundWorkerTakeoverResultV1>;
  readonly createTaskAttemptExecutor?: (options: {
    readonly approvalMode?: "defer" | "interactive";
    readonly io: CliIO;
    readonly runtimeProfileId: string;
    readonly sessionId: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) => TaskAttemptExecutor;
  readonly createBackgroundWorkerLauncher?: (options: {
    readonly sessionId: string;
  }) => BackgroundWorkerLauncher;
  readonly doctorBackgroundWorker?: () => Promise<BackgroundExecutableDescriptorV1>;
  readonly runInternalGraphWorker?: (options: {
    readonly io: CliIO;
    readonly operationId: string;
    readonly repositoryId: string;
  }) => Promise<BackgroundWorkerRuntimeResultV1>;
  readonly observeBackgroundWorkerLive?: (options: {
    readonly sessionId: string;
  }) => Promise<BackgroundWorkerLiveObservationV1 | null>;
  readonly queueBackgroundWorkerCancel?: (options: {
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly reason: string;
    readonly sessionId: string;
  }) => Promise<{ readonly controlSha256: string; readonly operationId: string; readonly requestId: string; readonly workerId: string }>;
  readonly createManagedWorktreeManager?: (options: {
    readonly io: CliIO;
    readonly sessionId: string;
  }) => Promise<ManagedWorktreeManager>;
  readonly createWorktreePromotionRuntime?: (options: {
    readonly io: CliIO;
    readonly sessionId: string;
  }) => Promise<WorktreePromotionRuntime>;
  readonly createMcpClientManager?: (options: {
    readonly artifacts?: ArtifactSessionRuntimeLike;
    readonly events: McpEventAppender;
    readonly hooks?: EffectHookPipeline;
    readonly prompt: ApprovalPrompt;
    readonly recency?: () => number;
    readonly secrets?: readonly (string | undefined)[];
  }) => McpClientManager;
  readonly createPluginLifecycle?: (workspace: string) => PluginLifecycleLike;
  readonly createCheckpointStore?: (
    workspace: string,
  ) => Promise<CheckpointStore>;
  refreshLocalModelCatalog(
    request: OllamaLocalCatalogRefreshRequest,
  ): Promise<readonly OllamaLocalModelDiscovery[]>;
  readonly runDockerSandboxDoctor?: (
    config: ResolvedDockerSandboxConfig,
  ) => Promise<DockerSandboxDoctorReport>;
  readonly execPath: string;
  readonly evalRuntime?: EvalCliRuntime;
  readonly dockerArtifactAcquirer?: DockerArtifactAcquirer;
  readonly reconcileDockerContainers?: (input: {
    readonly appender: ContainerRecoveryEventAppender;
    readonly events: readonly DecodedRunEvent[];
  }) => Promise<ContainerRecoveryResult>;
  readonly observeSessionWriter?: (writer: SessionWriter) => void;
  readonly modelQualificationGate?: ModelQualificationGate;
  /** Host capability for strict Goal/Plan replay and short-lived v2 writers. */
  readonly supportsPhase16TaskState?: boolean;
  readonly tuiHost?: TuiHost;
  readonly version: string;
}
