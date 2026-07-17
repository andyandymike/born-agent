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
import { createProductionBackendFactory } from "../model/backend-factory.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";
import { createReadonlyToolRegistry } from "../tools/create-readonly-tool-registry.js";
import { createAgentToolRegistry } from "../tools/create-agent-tool-registry.js";
import { redactSensitiveText } from "../security/redact.js";
import { classifyTrustedFixtureVerification } from "../verification/trusted-fixture-verification-classifier.js";
import { NodeOllamaLocalCatalogPort } from "../providers/pi/ollama-local-catalog-port.js";
import type { TuiHost } from "../tui/tui-host.js";
import { McpClientManager } from "../mcp/mcp-client-manager.js";
import { McpServerLauncher } from "../mcp/mcp-server-launcher.js";
import { DockerExecutionPreparer } from "../execution/docker/docker-execution-preparer.js";
import { DockerExecutor } from "../execution/docker/docker-executor.js";
import { NodeDockerCliAdapter } from "../execution/docker/docker-cli-adapter.js";
import { NodeWorkspaceSnapshotSource } from "../execution/snapshot/node-workspace-snapshot-adapters.js";
import { runDockerSandboxDoctor } from "../execution/docker/docker-doctor.js";
import { NodeEvalRuntime } from "../evals/eval-runtime.js";
import { reconcilePersistedContainers } from "../execution/docker/container-reconciliation-runtime.js";

export interface NodeRuntimeOptions {
  readonly approvalInput: ApprovalLineReader;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly evalAssetsRoot?: string;
  readonly execPath: string;
  readonly killProcess: (
    processIdentity: number,
    signal: NodeJS.Signals | 0,
  ) => void;
  readonly nodeVersion: string;
  readonly onCancel: (listener: () => void) => () => void;
  readonly platform: NodeJS.Platform;
  readonly tuiHost?: TuiHost;
  readonly version: string;
}

export function createNodeRuntime(options: NodeRuntimeOptions): CliRuntime {
  // PHASE2: 这里把可测试的接口接到真实 Node 能力：UUID、时钟、文件、timer、SDK。
  // 单元测试会替换这些依赖，因此无需真的访问网络、磁盘或等待超时。
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
  const createCleanup = () =>
    new NodeProcessTreeCleanup({
      isProcessAlive,
      killProcess: options.killProcess,
      platform: options.platform,
      ...(options.platform === "win32"
        ? { taskkill: createTaskkillArgvRunner(spawn) }
        : {}),
      timers,
    });
  const permissionEngine = new PermissionEngine(localFreeOnlyPermissionPolicy);
  return {
    // PHASE8: loopback selection alone is not live verification. Coding
    // completion remains closed until a separate immutable Ollama evidence run
    // exists; read-only runs do not need to claim that stronger status.
    agentModelEvidence: () => null,
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: (io) =>
      new TerminalApprovalPrompt({
        ...options.approvalInput,
        output: io.stderr,
      }),
    createMcpClientManager: ({ events, prompt }) => {
      const launcher = new McpServerLauncher({
        cleanup: createCleanup(),
        environment: options.env,
        events,
        now: () => performance.now(),
        permissionEngine,
        platform: options.platform,
        prompt,
        randomUUID,
        workspace: options.cwd,
      });
      return new McpClientManager({
        events,
        launcher,
        permissionEngine,
        prompt,
        randomUUID,
        secrets: [options.env.OPENAI_API_KEY, options.env.ANTHROPIC_API_KEY],
      });
    },
    createAgentToolRegistry: async (registryOptions) => {
      if (registryOptions.taskProfile === "read-only") {
        return createReadonlyToolRegistry(
          registryOptions.workspace,
          registryOptions.secrets ?? [],
          registryOptions.artifactRuntime,
          registryOptions.additionalTools ?? [],
        );
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
      const cleanup = createCleanup();
      const localExecutor = new LocalExecutor({
        clock: { now: () => performance.now() },
        platform: options.platform,
        processTreeCleanup: cleanup,
        redact: (value) =>
          redactSensitiveText(value, registryOptions.secrets ?? []),
        spawn: createNodeSpawnAdapter(spawn),
        timers,
      });
      const executorKind = registryOptions.executorKind ?? "local";
      // PHASE13: The factory chooses an isolation backend only after permission
      // policy/config are frozen. Permission authorizes the exact action;
      // LocalExecutor or DockerExecutor separately controls its OS boundary.
      const executionBackend =
        executorKind === "local"
          ? { executor: localExecutor, preparer: executionPreparer }
          : await (async () => {
              if (
                registryOptions.dockerSandbox === undefined ||
                registryOptions.sandboxEvents === undefined ||
                !["linux", "win32"].includes(options.platform)
              ) {
                throw new TypeError("Docker executor requires validated config, durable sandbox events, and a supported host platform");
              }
              const docker = new NodeDockerCliAdapter(options.env);
              const source = await NodeWorkspaceSnapshotSource.create(
                registryOptions.workspace,
              );
              const sandbox = registryOptions.dockerSandbox;
              return {
                executor: new DockerExecutor({
                  clock: { now: () => performance.now() },
                  events: registryOptions.sandboxEvents,
                  randomUUID,
                  redact: (value) =>
                    redactSensitiveText(value, registryOptions.secrets ?? []),
                  runtime: docker,
                }),
                preparer: new DockerExecutionPreparer({
                  hostPlatform: options.platform as "linux" | "win32",
                  imageInspector: docker,
                  imagePolicy: {
                    ...(sandbox.expectedLockfileSha256 === undefined
                      ? {}
                      : { expectedLockfileSha256: sandbox.expectedLockfileSha256 }),
                    image: sandbox.image,
                    imagePath: sandbox.imagePath,
                    runtime: sandbox.runtime,
                    runtimeVersion: sandbox.runtimeVersion,
                    supportsCUtf8: sandbox.supportsCUtf8,
                    wrapperSha256: sandbox.wrapperSha256,
                  },
                  limits: sandbox.limits,
                  localPreparer: executionPreparer,
                  runId: registryOptions.runId,
                  source,
                }),
              };
            })();
      return createAgentToolRegistry({
        ...registryOptions,
        executionPreparer: executionBackend.preparer,
        executor: executionBackend.executor,
        permissionContext: (prepared) =>
          prepared.environmentEvidence?.executor === "docker"
            ? {}
            : createTrustedLocalFixturePermissionContext(
                prepared.actionIdentity,
              ) ?? {},
        permissionEngine,
        verificationClassifier: classifyTrustedFixtureVerification,
      });
    },
    createSessionWriter: V2SessionWriter.create,
    // PHASE14: construct credential-aware provider machinery only for ordinary model commands; `born eval` owns a separate no-credential runtime.
    createModelBackend: (request) => createProductionBackendFactory(options.env).create(request),
    cwd: options.cwd,
    // PHASE3: production runtime 在这里装配固定只读 Registry；测试可替换为 FakeToolRegistry。
    createToolRegistry: createReadonlyToolRegistry,
    env: options.env,
    execPath: options.execPath,
    evalRuntime: new NodeEvalRuntime({
      workspace: options.cwd,
      ...(options.evalAssetsRoot === undefined ? {} : { assetsRoot: options.evalAssetsRoot }),
      timestamp: () => new Date().toISOString(),
      randomUUID,
      onCancel: options.onCancel,
      version: options.version,
      nodeVersion: options.nodeVersion,
      platform: options.platform,
      dockerEnvironment: options.env,
      ...(options.env.BORN_DOCKER_IMAGE === undefined
        ? {}
        : { graderImage: options.env.BORN_DOCKER_IMAGE }),
    }),
    isReadableDirectory,
    nodeVersion: options.nodeVersion,
    // PHASE4: duration budgets use a monotonic clock so wall-clock adjustments cannot
    // accidentally extend or prematurely exhaust a run; timestamps remain UTC wall time.
    now: () => performance.now(),
    onCancel: options.onCancel,
    platform: options.platform,
    randomUUID,
    refreshLocalModelCatalog: (request) =>
      new NodeOllamaLocalCatalogPort().refresh(request),
    reconcileDockerContainers: ({ appender, events }) =>
      reconcilePersistedContainers(
        events,
        new NodeDockerCliAdapter(options.env),
        appender,
      ),
    runExecutable,
    runDockerSandboxDoctor: (config) =>
      runDockerSandboxDoctor(config, new NodeDockerCliAdapter(options.env)),
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => new Date().toISOString(),
    ...(options.tuiHost === undefined ? {} : { tuiHost: options.tuiHost }),
    version: options.version,
  };
}
