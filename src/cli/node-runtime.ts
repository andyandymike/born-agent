import { randomUUID } from "node:crypto";

import type { CliRuntime } from "./types.js";
import { OpenAIStreamingChatClient } from "../providers/openai/openai-streaming-chat-client.js";
import { JsonlSessionWriter } from "../sessions/jsonl-session-writer.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";

export interface NodeRuntimeOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  readonly onCancel: (listener: () => void) => () => void;
  readonly platform: NodeJS.Platform;
  readonly version: string;
}

export function createNodeRuntime(options: NodeRuntimeOptions): CliRuntime {
  return {
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createSessionWriter: JsonlSessionWriter.create,
    createStreamingChatClient: (configuration) =>
      configuration.provider === "openai"
        ? new OpenAIStreamingChatClient({ apiKey: configuration.apiKey })
        : new OpenAIStreamingChatClient({
            apiKey: "ollama",
            baseURL: configuration.baseURL,
            includeStore: false,
            providerName: "Ollama",
          }),
    cwd: options.cwd,
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
