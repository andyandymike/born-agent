import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { CliRuntime } from "./types.js";
import type { ApprovalLineReader } from "../approvals/approval-types.js";
import { TerminalApprovalPrompt } from "../approvals/terminal-approval-prompt.js";
import { createDefaultExecutableRegistry } from "../execution/executable-registry.js";
import { ExecutionPreparer } from "../execution/execution-preparer.js";
import {
  createNodeSpawnAdapter,
  LocalExecutor,
} from "../execution/local-executor.js";
import {
  createTaskkillArgvRunner,
  NodeProcessTreeCleanup,
} from "../execution/process-tree-cleanup.js";
import { PermissionEngine } from "../permissions/permission-engine.js";
import { localFreeOnlyPermissionPolicy } from "../permissions/local-free-policy.js";
import { createTrustedLocalFixturePermissionContext } from "../permissions/trusted-local-fixture-manifest.js";
import { OpenAIStreamingChatClient } from "../providers/openai/openai-streaming-chat-client.js";
import { JsonlSessionWriter } from "../sessions/jsonl-session-writer.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";
import { createReadonlyToolRegistry } from "../tools/create-readonly-tool-registry.js";
import { createAgentToolRegistry } from "../tools/create-agent-tool-registry.js";
import { redactSensitiveText } from "../security/redact.js";
import { classifyTrustedFixtureVerification } from "../verification/trusted-fixture-verification-classifier.js";

export interface NodeRuntimeOptions {
  readonly approvalInput: ApprovalLineReader;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly killProcess: (
    processIdentity: number,
    signal: NodeJS.Signals | 0,
  ) => void;
  readonly nodeVersion: string;
  readonly onCancel: (listener: () => void) => () => void;
  readonly platform: NodeJS.Platform;
  readonly version: string;
}

export function createNodeRuntime(options: NodeRuntimeOptions): CliRuntime {
  // PHASE2: 这里把可测试的接口接到真实 Node 能力：UUID、时钟、文件、timer、SDK。
  // 单元测试会替换这些依赖，因此无需真的访问网络、磁盘或等待超时。
  return {
    agentModelEvidence: (provider) =>
      provider === "ollama"
        ? {
            backend: "ollama",
            endpointScope: "literal_loopback",
            kind: "local_live_verified",
            remoteBillableRequests: 0,
          }
        : null,
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: (io) =>
      new TerminalApprovalPrompt({
        ...options.approvalInput,
        output: io.stderr,
      }),
    createAgentToolRegistry: async (registryOptions) => {
      if (registryOptions.taskProfile === "read-only") {
        return createReadonlyToolRegistry(registryOptions.workspace);
      }
      const executableRegistry = createDefaultExecutableRegistry({
        execPath: options.execPath,
        hostEnvironment: options.env,
        platform: options.platform,
      });
      const executionPreparer = await ExecutionPreparer.create({
        hostEnvironment: options.env,
        platform: options.platform,
        registry: executableRegistry,
        workspace: registryOptions.workspace,
      });
      const timers = {
        clearTimeout: (handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
        setTimeout: (listener: () => void, delayMs: number) =>
          setTimeout(listener, delayMs),
      };
      const isProcessAlive = (processIdentity: number): boolean => {
        try {
          options.killProcess(processIdentity, 0);
          return true;
        } catch {
          return false;
        }
      };
      const cleanup = new NodeProcessTreeCleanup({
        isProcessAlive,
        killProcess: options.killProcess,
        platform: options.platform,
        ...(options.platform === "win32"
          ? { taskkill: createTaskkillArgvRunner(spawn) }
          : {}),
        timers,
      });
      const executor = new LocalExecutor({
        clock: { now: () => performance.now() },
        platform: options.platform,
        processTreeCleanup: cleanup,
        redact: (value) =>
          redactSensitiveText(value, registryOptions.secrets ?? []),
        spawn: createNodeSpawnAdapter(spawn),
        timers,
      });
      const permissionEngine = new PermissionEngine(
        localFreeOnlyPermissionPolicy,
      );
      return createAgentToolRegistry({
        ...registryOptions,
        executionPreparer,
        executor,
        permissionContext: (prepared) =>
          createTrustedLocalFixturePermissionContext(
            prepared.actionIdentity,
          ) ?? {},
        permissionEngine,
        verificationClassifier: classifyTrustedFixtureVerification,
      });
    },
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
    execPath: options.execPath,
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
