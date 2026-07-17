import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentCommandOptions } from "../agent/agent-types.js";
import type { ApprovalPreview, ApprovalPrompt } from "../approvals/approval-types.js";
import {
  CheckpointStore,
  type CheckpointPrivacyVerifier,
} from "../checkpoints/checkpoint-store.js";
import type { CliRuntime } from "../cli/types.js";
import { createAgentToolRegistry as createProductionAgentToolRegistry } from "../tools/create-agent-tool-registry.js";
import { createReadonlyToolRegistry } from "../tools/create-readonly-tool-registry.js";
import { DockerExecutionPreparer } from "../execution/docker/docker-execution-preparer.js";
import { DockerExecutor } from "../execution/docker/docker-executor.js";
import { reconcilePersistedContainers } from "../execution/docker/container-reconciliation-runtime.js";
import { NodeWorkspaceSnapshotSource } from "../execution/snapshot/node-workspace-snapshot-adapters.js";
import type {
  ExecutionIntent,
  ExecutionPreparerLike,
  PreparedExecution,
} from "../execution/execution-types.js";
import { createCommandActionIdentity } from "../permissions/action-digest.js";
import { localFreeOnlyPermissionPolicy } from "../permissions/local-free-policy.js";
import { PermissionEngine } from "../permissions/permission-engine.js";
import { McpClientManager } from "../mcp/mcp-client-manager.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { EvalApprovalPolicy } from "./eval-approval-policy.js";
import {
  EVAL_DOCKER_IMAGE,
  EVAL_DOCKER_WRAPPER_SHA256,
  InProcessEvalDockerRuntime,
} from "./eval-docker-runtime.js";
import { EvalFaultSessionHook } from "./eval-fault-session-hook.js";
import { InProcessEvalMcpLauncher } from "./eval-mcp-runtime.js";
import { createEvalModelBackend } from "./eval-model-backend.js";
import type { EvalTurnGuard, EvalExecutionSource } from "./eval-no-cost-policy.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";

const verifiedCheckpointPrivacy: CheckpointPrivacyVerifier = Object.freeze({
  preflight: async () => ({ status: "verified" as const }),
  verifyFile: async () => ({ status: "verified" as const }),
});

class EvalCommandPreparer implements ExecutionPreparerLike {
  public constructor(private readonly workspace: string) {}

  public async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    if (
      intent.executable !== "node" ||
      intent.args.length !== 1 ||
      intent.args[0] !== "--version" ||
      (intent.cwd !== null && intent.cwd !== ".") ||
      intent.purpose !== "verify"
    ) {
      throw new TypeError("eval command is outside the exact node --version contract");
    }
    const actionIdentity = createCommandActionIdentity({
      actionKind: "command",
      argv: Object.freeze([...intent.args]),
      binary: {
        bytesSha256: "1".repeat(64),
        canonicalIdentity: "phase14-eval-image-node",
        version: "phase14-eval",
      },
      canonicalCwd: ".",
      environmentPolicy: {
        id: "phase14-eval-local-preparation",
        variableNames: [],
        version: "1",
      },
      executionInputs: {
        lockfileSha256: null,
        manifestSha256: null,
        runnerConfigHashes: [],
      },
      lifecycleScripts: null,
      logicalExecutable: "node",
      outputLimitBytes: intent.outputLimitBytes,
      packageManager: null,
      purpose: intent.purpose,
      timeoutMs: intent.timeoutMs,
    });
    return Object.freeze({
      actionIdentity,
      actionSha256: actionIdentity.actionSha256,
      executionInputsSha256: actionIdentity.executionInputsSha256,
      request: Object.freeze({
        args: Object.freeze([...intent.args]),
        cwd: this.workspace,
        environment: Object.freeze({}),
        executableFile: "node",
        logicalExecutable: "node",
        outputLimitBytes: intent.outputLimitBytes,
        purpose: intent.purpose,
        timeoutMs: intent.timeoutMs,
      }),
      revalidate: async () => "current" as const,
      review: Object.freeze({
        lifecycleScripts: Object.freeze([]),
        warning: "command runs only in the disposable in-process Docker contract",
      }),
    });
  }
}

class EvalApprovalPrompt implements ApprovalPrompt {
  public constructor(
    private readonly approval: EvalApprovalPolicy,
    private readonly disposableWorkspaceId: string,
    private readonly mcpEnabled: boolean,
  ) {}

  public async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<"approved" | "denied"> {
    if (signal.aborted) return "denied";
    if (preview.actionKind === "apply_patch") {
      return this.approval.decidePatch({
        changedLines: preview.addedLines + preview.removedLines,
        disposableWorkspaceId: this.disposableWorkspaceId,
        paths: preview.paths.map(({ path }) => path),
      }).decision;
    }
    if (preview.actionKind === "run_command") {
      return this.approval.decideCommand({
        command: {
          args: [...preview.args],
          cwd: preview.cwd === "." ? "/workspace" : preview.cwd,
          executable: preview.executable,
        },
        disposableWorkspaceId: this.disposableWorkspaceId,
        executor: preview.executor === "docker" ? "docker_v1" : "local",
        network: preview.executor === "docker" ? "none" : "host",
      }).decision;
    }
    return this.mcpEnabled ? "approved" : "denied";
  }
}

export interface EvalAgentRuntimeOptions {
  readonly approvalPolicy: EvalApprovalPolicy;
  readonly disposableWorkspaceId: string;
  readonly guard: EvalTurnGuard;
  readonly model: string;
  readonly signal: AbortSignal;
  readonly source: EvalExecutionSource;
  readonly task: LoadedEvalTaskAsset;
  readonly workspacePath: string;
}

export class EvalAgentRuntime implements CliRuntime {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath = process.execPath;
  readonly nodeVersion = process.versions.node;
  readonly platform = process.platform;
  readonly version = "0.0.0-phase14-eval";
  readonly docker = new InProcessEvalDockerRuntime();
  readonly fault = new EvalFaultSessionHook();
  readonly #permissionEngine = new PermissionEngine(localFreeOnlyPermissionPolicy);
  readonly #prompt: EvalApprovalPrompt;
  readonly #sessionPaths = new Set<string>();
  #sessionId: string | undefined;

  public constructor(private readonly options: EvalAgentRuntimeOptions) {
    this.cwd = options.workspacePath;
    this.env = Object.freeze({
      BORN_DOCKER_IMAGE_PATH: "/usr/local/bin:/usr/bin:/bin",
      BORN_DOCKER_RUNTIME: "node",
      BORN_DOCKER_RUNTIME_VERSION: "phase14-eval",
      BORN_DOCKER_WRAPPER_SHA256: EVAL_DOCKER_WRAPPER_SHA256,
      BORN_OLLAMA_BASE_URL:
        options.source.kind === "local_ollama"
          ? options.source.endpoint
          : "http://127.0.0.1:11434",
    });
    this.#prompt = new EvalApprovalPrompt(
      options.approvalPolicy,
      options.disposableWorkspaceId,
      options.task.task.scenario.resolvedServices.length > 0,
    );
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public get sessionPaths(): readonly string[] {
    return Object.freeze([...this.#sessionPaths]);
  }

  public async configureScenarioServices(): Promise<void> {
    if (this.options.task.task.scenario.resolvedServices.length === 0) return;
    if (this.options.task.task.scenario.resolvedServices.length !== 1) {
      throw new TypeError("Phase 14 v1 runtime supports one resolved MCP fixture per task");
    }
    const directory = path.join(this.cwd, ".bornagent");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "mcp.json"),
      `${JSON.stringify({
        servers: {
          evalfixture: {
            args: [],
            call_timeout_ms: 5_000,
            cwd: ".",
            env: [],
            executable: "eval-mcp-fixture",
            integrity_files: [],
            startup_timeout_ms: 5_000,
            transport: "stdio",
          },
        },
        version: 1,
      })}\n`,
      "utf8",
    );
  }

  public agentModelEvidence() {
    return this.options.source.kind === "local_ollama"
      ? {
          backend: "ollama" as const,
          endpointScope: "literal_loopback" as const,
          kind: "local_live_verified" as const,
          remoteBillableRequests: 0 as const,
        }
      : {
          backend: "fake" as const,
          endpointScope: "in_process" as const,
          kind: "contract_verified" as const,
          remoteBillableRequests: 0 as const,
        };
  }

  public clearTimer(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  public createApprovalPrompt(): ApprovalPrompt {
    return this.#prompt;
  }

  public createMcpClientManager = ({
    events,
    prompt,
  }: Parameters<NonNullable<CliRuntime["createMcpClientManager"]>>[0]) => {
    const service = this.options.task.task.scenario.resolvedServices[0];
    if (service === undefined) {
      throw new TypeError("eval MCP manager requested without a resolved service");
    }
    const launcher = new InProcessEvalMcpLauncher({
      events,
      mode: service.mode,
      permissionEngine: this.#permissionEngine,
      prompt,
      randomUUID: this.randomUUID,
    });
    return new McpClientManager({
      events,
      launcher: launcher.asProductionPort(),
      permissionEngine: this.#permissionEngine,
      prompt,
      randomUUID: this.randomUUID,
    });
  };

  public async createAgentToolRegistry(
    registryOptions: Parameters<CliRuntime["createAgentToolRegistry"]>[0],
  ) {
    if (registryOptions.taskProfile === "read-only") {
      return createReadonlyToolRegistry(
        registryOptions.workspace,
        registryOptions.secrets ?? [],
        registryOptions.artifactRuntime,
        registryOptions.additionalTools ?? [],
      );
    }
    const source = await NodeWorkspaceSnapshotSource.create(
      registryOptions.workspace,
    );
    const preparer = new DockerExecutionPreparer({
      hostPlatform: this.platform as "linux" | "win32",
      imageInspector: this.docker,
      imagePolicy: {
        image: EVAL_DOCKER_IMAGE,
        imagePath: "/usr/local/bin:/usr/bin:/bin",
        runtime: "node",
        runtimeVersion: "phase14-eval",
        supportsCUtf8: true,
        wrapperSha256: EVAL_DOCKER_WRAPPER_SHA256,
      },
      limits: { cpus: 1, memoryMiB: 256, pids: 32, tmpMiB: 16 },
      // The snapshot adapter resolves Windows 8.3 aliases to the canonical
      // workspace path. Feed that same identity to the Docker mapper so an
      // eval under a short TEMP path cannot look like an out-of-root cwd.
      localPreparer: new EvalCommandPreparer(source.workspaceRealPath),
      runId: registryOptions.runId,
      source,
    });
    if (registryOptions.sandboxEvents === undefined) {
      throw new TypeError("eval Docker registry requires durable sandbox events");
    }
    const executor = new DockerExecutor({
      clock: { now: this.now },
      events: registryOptions.sandboxEvents,
      randomUUID: this.randomUUID,
      redact: (value) => value,
      runtime: this.docker,
    });
    return createProductionAgentToolRegistry({
      ...registryOptions,
      executionPreparer: preparer,
      executor,
      permissionContext: () => ({}),
      permissionEngine: this.#permissionEngine,
      verificationClassifier: async (prepared) =>
        prepared.actionIdentity.logicalExecutable === "node" &&
        prepared.actionIdentity.argv.length === 1 &&
        prepared.actionIdentity.argv[0] === "--version" &&
        prepared.actionIdentity.purpose === "verify"
          ? { inputPaths: Object.freeze(["answer.txt"]), kind: "test" as const }
          : null,
    });
  }

  public createModelBackend = () =>
    createEvalModelBackend({
      contextWindowTokens:
        this.options.task.task.scenario.scenario.config.context_window_tokens,
      guard: this.options.guard,
      hasMcpService:
        this.options.task.task.scenario.resolvedServices.length > 0,
      model: this.options.model,
      source: this.options.source,
      taskId: this.options.task.task.manifest.id,
      taskVersion: this.options.task.task.manifest.task_version,
    });

  public async createSessionWriter(
    workspace: string,
    sessionId: string,
  ): Promise<V2SessionWriter> {
    this.#sessionId = sessionId;
    const writer = await V2SessionWriter.createNew(workspace, sessionId, {
      afterDurableEvent: (event) => this.fault.afterDurableEvent(event),
    });
    this.#sessionPaths.add(writer.path);
    return writer;
  }

  public createCheckpointStore = (workspace: string) =>
    CheckpointStore.create(workspace, {
      privacyVerifier: verifiedCheckpointPrivacy,
      randomId: this.randomUUID,
    });

  public createToolRegistry = createReadonlyToolRegistry;

  public async isReadableDirectory(candidate: string): Promise<boolean> {
    return (await stat(candidate).catch(() => null))?.isDirectory() === true;
  }

  public now = (): number => performance.now();

  public onCancel = (listener: () => void): (() => void) => {
    if (this.options.signal.aborted) listener();
    else this.options.signal.addEventListener("abort", listener, { once: true });
    return () => this.options.signal.removeEventListener("abort", listener);
  };

  public randomUUID = (): string => randomUUID();

  public reconcileDockerContainers: NonNullable<
    CliRuntime["reconcileDockerContainers"]
  > = ({ appender, events }) =>
    reconcilePersistedContainers(events, this.docker, appender);

  public refreshLocalModelCatalog = async () => [];

  public runExecutable = async () => ({
    exitCode: 0,
    kind: "completed" as const,
    stderr: "",
    stdout: "",
  });

  public setTimer(listener: () => void, delayMs: number): unknown {
    return setTimeout(listener, delayMs);
  }

  public timestamp = (): string => new Date().toISOString();

  public observeSessionWriter = (writer: { readonly path: string }): void => {
    this.#sessionPaths.add(writer.path);
  };
}

export function evalAgentCommandOptions(input: {
  readonly model: string;
  readonly prompt: string;
  readonly source: EvalExecutionSource;
  readonly task: LoadedEvalTaskAsset;
}): AgentCommandOptions {
  const hasMcp = input.task.task.scenario.resolvedServices.length > 0;
  return Object.freeze({
    commandApproval: "ask",
    commandTimeoutMs: "30000",
    completionPolicy: "verified",
    contextCompactionThreshold: "0.8",
    contextReserveOutputTokens: "512",
    contextWindowTokens: String(
      input.task.task.scenario.scenario.config.context_window_tokens,
    ),
    dockerImage: EVAL_DOCKER_IMAGE,
    editApproval: "ask",
    executor: "docker",
    maxCommandOutputBytes: "65536",
    maxDurationMs: String(input.task.task.manifest.limits.agent_duration_ms),
    maxSteps: "8",
    maxTokens: "100000",
    maxToolOutputBytes: "262144",
    ...(hasMcp ? { mcpServerIds: Object.freeze(["evalfixture"]) } : {}),
    model: input.model,
    provider: "ollama",
    reportFormat: "json",
    requestTimeoutMs: "30000",
    requireVerification: "auto",
    sandboxCpus: "1",
    sandboxMemoryMiB: "256",
    sandboxPids: "32",
    sandboxTmpMiB: "16",
    task: input.prompt,
    taskProfile: "coding",
    verbose: false,
  });
}
