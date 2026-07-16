import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { CliRuntime } from "./types.js";
import type { ApprovalLineReader } from "../approvals/approval-types.js";
import { TerminalApprovalPrompt } from "../approvals/terminal-approval-prompt.js";
import { OpenAIStreamingChatClient } from "../providers/openai/openai-streaming-chat-client.js";
import { JsonlSessionWriter } from "../sessions/jsonl-session-writer.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";
import { createReadonlyToolRegistry } from "../tools/create-readonly-tool-registry.js";
import { createAgentToolRegistry } from "../tools/create-agent-tool-registry.js";

export interface NodeRuntimeOptions {
  readonly approvalInput: ApprovalLineReader;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  readonly onCancel: (listener: () => void) => () => void;
  readonly platform: NodeJS.Platform;
  readonly version: string;
}

export function createNodeRuntime(options: NodeRuntimeOptions): CliRuntime {
  // PHASE2: 这里把可测试的接口接到真实 Node 能力：UUID、时钟、文件、timer、SDK。
  // 单元测试会替换这些依赖，因此无需真的访问网络、磁盘或等待超时。
  return {
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: (io) =>
      new TerminalApprovalPrompt({
        ...options.approvalInput,
        output: io.stderr,
      }),
    createAgentToolRegistry,
    createSessionWriter: JsonlSessionWriter.create,
    createModelTurnClient: (configuration) =>
      configuration.provider === "openai"
        ? new OpenAIStreamingChatClient({ apiKey: configuration.apiKey })
        : new OpenAIStreamingChatClient({
            apiKey: "ollama",
            baseURL: configuration.baseURL,
            includeEncryptedReasoning: false,
            includeStore: false,
            providerName: "Ollama",
          }),
    cwd: options.cwd,
    // PHASE3: production runtime 在这里装配固定只读 Registry；测试可替换为 FakeToolRegistry。
    createToolRegistry: createReadonlyToolRegistry,
    env: options.env,
    isReadableDirectory,
    nodeVersion: options.nodeVersion,
    // PHASE4: duration budgets use a monotonic clock so wall-clock adjustments cannot
    // accidentally extend or prematurely exhaust a run; timestamps remain UTC wall time.
    now: () => performance.now(),
    onCancel: options.onCancel,
    platform: options.platform,
    randomUUID,
    runExecutable,
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => new Date().toISOString(),
    version: options.version,
  };
}
