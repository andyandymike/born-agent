import { randomUUID } from "node:crypto";

import type { CliRuntime } from "./types.js";
import { OpenAIStreamingChatClient } from "../providers/openai/openai-streaming-chat-client.js";
import { JsonlSessionWriter } from "../sessions/jsonl-session-writer.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";
import { createReadonlyToolRegistry } from "../tools/create-readonly-tool-registry.js";

export interface NodeRuntimeOptions {
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
    createToolRegistry: createReadonlyToolRegistry,
    env: options.env,
    isReadableDirectory,
    nodeVersion: options.nodeVersion,
    now: Date.now,
    onCancel: options.onCancel,
    platform: options.platform,
    randomUUID,
    runExecutable,
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => new Date().toISOString(),
    version: options.version,
  };
}
