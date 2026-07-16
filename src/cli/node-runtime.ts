import type { CliRuntime } from "./types.js";
import { OpenAIChatClient } from "../providers/openai/openai-chat-client.js";
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
    createChatClient: (configuration) =>
      configuration.provider === "openai"
        ? new OpenAIChatClient({ apiKey: configuration.apiKey })
        : new OpenAIChatClient({
            apiKey: "ollama",
            baseURL: configuration.baseURL,
            includeStore: false,
          }),
    cwd: options.cwd,
    env: options.env,
    isReadableDirectory,
    nodeVersion: options.nodeVersion,
    now: Date.now,
    onCancel: options.onCancel,
    platform: options.platform,
    runExecutable,
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    version: options.version,
  };
}
