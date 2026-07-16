import type { StreamingChatRuntime } from "../chat/run-streaming-chat.js";
import type { DoctorRuntime } from "../doctor/types.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { AgentToolRegistryOptions } from "../tools/create-agent-tool-registry.js";
import type { ToolRegistryLike } from "../tools/tool-types.js";
import type { ChatProvider } from "../chat/types.js";
import type { ModelEvidence } from "../completion/completion-types.js";

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
  readonly execPath: string;
  readonly version: string;
}
