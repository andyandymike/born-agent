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

export interface OutputWriter {
  write(value: string): void;
}

export interface CliIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}

export interface CliRuntime extends StreamingChatRuntime, DoctorRuntime {
  agentModelEvidence(provider: ChatProvider): ModelEvidence | null;
  createAgentToolRegistry(
    options: AgentToolRegistryOptions,
  ): Promise<ToolRegistryLike>;
  createApprovalPrompt(io: CliIO): ApprovalPrompt;
  readonly createMcpClientManager?: (options: {
    readonly events: McpEventAppender;
    readonly prompt: ApprovalPrompt;
    readonly secrets?: readonly (string | undefined)[];
  }) => McpClientManager;
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
  readonly tuiHost?: TuiHost;
  readonly version: string;
}
