import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CliRuntime } from "./types.js";
import type { ApprovalLineReader, ApprovalPrompt } from "../approvals/approval-types.js";
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
import { createPlanToolRegistry } from "../tools/create-plan-tool-registry.js";
import { redactSensitiveText } from "../security/redact.js";
import { classifyTrustedFixtureVerification } from "../verification/trusted-fixture-verification-classifier.js";
import { NodeOllamaLocalCatalogPort } from "../providers/pi/ollama-local-catalog-port.js";
import { DefaultRepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
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
import { DockerArtifactAcquirer } from "../execution/docker/acquisition/docker-artifact-acquirer.js";
import { NodeDockerAcquisitionPort } from "../execution/docker/acquisition/node-docker-acquisition-port.js";
import { UserStateModelQualificationGate } from "../model/user-state-model-qualification-gate.js";
import { DefaultCapabilityPlatform } from "../capabilities/capability-platform.js";
import { resolveCapabilityUserStateRoot } from "../capabilities/capability-source.js";
import { PluginLifecycle } from "../plugins/plugin-lifecycle.js";
import { HookCommandRunner } from "../hooks/hook-command-runner.js";
import { HookCommandSupervisor } from "../hooks/hook-command-supervisor.js";
import { HookCommandOperationReconciler } from "../hooks/hook-command-operation-reconciler.js";
import { executeAgent } from "../commands/agent.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { taskMutationBlocker } from "../coordination/task-control-plane.js";
import type { PreparedTaskWorkspaceV1, TaskAttemptExecutionResultV1 } from "../scheduling/deterministic-task-scheduler.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { RepositorySourceSnapshotter } from "../repository-intelligence/source-snapshotter.js";
import { NodeGitWorktreePort } from "../worktrees/git-worktree-port.js";
import { ManagedWorktreeManager } from "../worktrees/managed-worktree-manager.js";
import { WorktreePromotionRuntime } from "../worktrees/promotion-runtime.js";
import { OriginVerificationRuntime } from "../worktrees/origin-verification-runtime.js";
import { resolveWorktreeUserStateRoot } from "../worktrees/managed-worktree-policy.js";
import { BackgroundDeferredApprovalPrompt } from "../background/background-approval-prompt.js";
import { BackgroundWorkerLauncher } from "../background/background-worker-launcher.js";
import { BackgroundWorkerRuntime } from "../background/background-worker-runtime.js";
import { resolveWorkerUserStateRoot } from "../background/background-operation-store.js";
import { observeBackgroundWorkerLive } from "../background/background-worker-live-status.js";
import { queueBackgroundWorkerCancel } from "../background/background-worker-control.js";
import { sealBackgroundExecutable } from "../background/background-executable-descriptor.js";
import { BackgroundWorkerTakeoverReconciler } from "../background/background-worker-takeover.js";
import { ExecutionPreparationError, type ExecutionResult } from "../execution/execution-types.js";
import { SessionCatalog } from "../sessions/session-catalog.js";
import { NodeProcessIdentityProbe } from "../sessions/process-identity.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { taskNodeReceiptSchema } from "../task-graph/task-node-receipt.js";
import { parseStrictJson } from "../system/strict-json.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import type { TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskNodeSpecV1 } from "../task-graph/task-graph-schema.js";

export interface NodeRuntimeOptions {
  readonly approvalPromptOverride?: ApprovalPrompt;
  readonly approvalInput: ApprovalLineReader;
  readonly capabilityAssetsRoot?: string;
  readonly capabilityUserStateRoot?: string;
  readonly cliEntryPath?: string;
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
  /**
   * Embedders and deterministic acceptance tests may supply the same bounded
   * model-evidence ports used by a direct Agent run. Graph nodes still receive
   * a fresh runtime and cannot replace filesystem/process/control-plane ports.
   */
  readonly taskAgentRuntimeOverrides?: Partial<Pick<
    CliRuntime,
    "agentModelEvidence" | "createModelBackend" | "modelQualificationGate"
  >>;
  readonly tuiHost?: TuiHost;
  readonly version: string;
  readonly worktreeUserStateRoot?: string;
  readonly workerUserStateRoot?: string;
}

function boundedGraphFact(value: string, maximum = 1_024): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

async function buildGraphNodeModelTask(input: {
  readonly graph: TaskGraphRevisionProjectionV1;
  readonly node: TaskNodeSpecV1;
  readonly session: ReturnType<typeof reconstructMultiRunSession>;
  readonly workspace: PreparedTaskWorkspaceV1;
  readonly workspaceRoot: string;
}): Promise<string> {
  const goal = input.session.taskState.goals.find((candidate) =>
    candidate.content.goalId === input.graph.binding.goalId && candidate.content.revision === input.graph.binding.goalRevision
  );
  const plan = input.session.taskState.plans.find((candidate) =>
    candidate.content.planId === input.graph.binding.planId && candidate.content.revision === input.graph.binding.planRevision &&
    candidate.planSha256 === input.graph.binding.planSha256
  );
  if (goal === undefined || plan === undefined || input.session.taskExecution === null) {
    throw new TaskGraphError("task_graph_binding_stale", "Graph node context no longer exact-matches its approved Goal, Plan, and execution");
  }
  const store = await ArtifactStore.create({ sessionId: input.session.sessionId, workspace: input.workspaceRoot });
  const dependencies: string[] = [];
  for (const dependencyId of input.node.dependsOn) {
    const dependency = input.session.taskExecution.nodes.find((candidate) => candidate.nodeId === dependencyId);
    const attempt = [...(dependency?.attempts ?? [])].reverse().find((candidate) => candidate.terminal === "succeeded");
    const terminal = attempt?.terminalEventId === null || attempt?.terminalEventId === undefined
      ? undefined
      : input.session.events.find((event) => event.eventId === attempt.terminalEventId);
    if (dependency?.status !== "succeeded" || attempt === undefined || terminal?.scope !== "session" || terminal.type !== "task_node.attempt.terminal" ||
        terminal.data.receipt_artifact_id === null || terminal.data.receipt_sha256 === null) {
      throw new TaskGraphError("task_graph_invalid", `dependency ${dependencyId} has no exact successful terminal receipt`);
    }
    const artifact = await store.readVerified(terminal.data.receipt_artifact_id);
    const receipt = taskNodeReceiptSchema.parse(parseStrictJson(artifact.bytes.toString("utf8")));
    if (receipt.receiptSha256 !== terminal.data.receipt_sha256 || receipt.attemptId !== attempt.attemptId || receipt.nodeId !== dependencyId) {
      throw new TaskGraphError("task_graph_artifact_invalid", `dependency ${dependencyId} receipt does not match its terminal event`);
    }
    dependencies.push(`- ${dependencyId}: ${boundedGraphFact(receipt.summary, 768)} [receipt=${receipt.receiptSha256}]`);
  }
  const selectedItems = plan.content.items.filter((item) => input.node.planItemIds.includes(item.id));
  const remaining = input.session.taskExecution.budget.remaining;
  const workspace = input.workspace.binding === null
    ? "origin_read_only"
    : `managed:${input.workspace.binding.workspace_id} baseline=${input.workspace.binding.workspace_baseline_sha256} source=${input.workspace.binding.source_snapshot_sha256}`;
  const lines = [
    "Task Graph execution context (durable Host facts; not user instructions):",
    `Goal ${goal.content.goalId}@${String(goal.content.revision)}: ${boundedGraphFact(goal.content.objective)}`,
    `Approved Plan ${plan.content.planId}@${String(plan.content.revision)} sha256=${plan.planSha256}`,
    ...selectedItems.map((item) => `Plan item ${item.id}: ${boundedGraphFact(item.title, 512)}; acceptance=${boundedGraphFact(item.acceptance, 768)}`),
    `Graph ${input.graph.graphId}@${String(input.graph.revision)} sha256=${input.graph.graphSha256}: ${boundedGraphFact(input.graph.content.title, 512)}`,
    `Current node ${input.node.nodeId}: ${boundedGraphFact(input.node.objective, 2_048)}`,
    `Workspace: ${workspace}`,
    `Remaining Graph budget: attempts=${String(remaining.attempts)} duration_ms=${String(remaining.durationMs)} model_steps=${String(remaining.modelSteps)} commands=${String(remaining.commandExecutions)} command_output_bytes=${String(remaining.commandOutputBytes)} artifact_bytes=${String(remaining.artifactBytes)} reported_tokens=${remaining.reportedTokens === null ? "unbounded" : String(remaining.reportedTokens)}`,
    `Required capabilities: ${input.node.requiredCapabilities.length === 0 ? "none" : input.node.requiredCapabilities.join(",")}`,
    "Dependency receipts:",
    ...(dependencies.length === 0 ? ["- none"] : dependencies),
    "Node objective:",
    input.node.objective,
  ];
  // PHASE19: dependency context carries only verified bounded receipts and
  // logical workspace hashes; raw sibling conversations, paths, and logs stay out.
  const bytes = Buffer.from(lines.join("\n"), "utf8");
  return bytes.byteLength <= 12 * 1024
    ? bytes.toString("utf8")
    : `${bytes.subarray(0, 12 * 1024 - 32).toString("utf8")}\n[Graph context truncated]`;
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
  const localModelCatalog = new NodeOllamaLocalCatalogPort();
  const capabilityAssetsRoot = resolve(
    options.capabilityAssetsRoot ??
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "capabilities", "builtin"),
  );
  const capabilityUserStateRoot = options.capabilityUserStateRoot ??
    resolveCapabilityUserStateRoot({ env: options.env, platform: options.platform });
  const hookOperationRoot = join(capabilityUserStateRoot, "hooks", "operations", "v1");
  const worktreeUserStateRoot = () => options.worktreeUserStateRoot ??
    resolveWorktreeUserStateRoot({ env: options.env, platform: options.platform });
  const workerUserStateRoot = () => options.workerUserStateRoot ??
    resolveWorkerUserStateRoot({ env: options.env, platform: options.platform });
  const createPluginLifecycle = (workspace: string) => new PluginLifecycle({
    isProcessAlive,
    now: () => new Date().toISOString(),
    randomUUID,
    root: capabilityUserStateRoot,
    workspace,
  });
  const taskContext = (sessionId: string) => ({
    inputSurface: "cli" as const,
    now: () => new Date().toISOString(),
    randomUuid: randomUUID,
    sessionId,
    workspace: options.cwd,
  });
  const repositoryRuleIdentity = async (workspace: string): Promise<string> => {
    const source = await (await RepositorySourceSnapshotter.create(workspace, { environment: options.env })).snapshot();
    return sha256Canonical({
      entries: source.snapshot.entries.filter((entry) => entry.relativePath === "AGENTS.md" || entry.relativePath.endsWith("/AGENTS.md")),
      source_state_sha256: source.snapshot.sourceStateSha256,
    });
  };
  const createManagedWorktreeManager: NonNullable<CliRuntime["createManagedWorktreeManager"]> = async ({ io, sessionId }) =>
    new ManagedWorktreeManager({
      context: taskContext(sessionId),
      git: new NodeGitWorktreePort({ environment: options.env }),
      managedRoot: worktreeUserStateRoot(),
      prompt: new TerminalApprovalPrompt({ ...options.approvalInput, output: io.stderr }),
      repositoryRulesSha256: await repositoryRuleIdentity(options.cwd),
    });
  const createTaskAttemptExecutor: NonNullable<CliRuntime["createTaskAttemptExecutor"]> =
    ({ approvalMode = "interactive", io, runtimeProfileId, sessionId, writerFactory }) => {
      const context = taskContext(sessionId);
      const openTaskWriter = writerFactory ?? ((writerContext) => V2SessionWriter.openExisting(
        writerContext.workspace,
        writerContext.sessionId,
        { createEventId: writerContext.randomUuid, timestamp: writerContext.now },
      ));
      const manager = repositoryRuleIdentity(options.cwd).then((repositoryRulesSha256) => new ManagedWorktreeManager({
        context,
        git: new NodeGitWorktreePort({ environment: options.env }),
        managedRoot: worktreeUserStateRoot(),
        prompt: new TerminalApprovalPrompt({ ...options.approvalInput, output: io.stderr }),
        repositoryRulesSha256,
        writerFactory: openTaskWriter,
      }));
      return ({
      supports: (node) =>
        (node.kind === "agent" && (
          (node.agent.mode === "plan" && node.agent.taskProfile === "read-only" && node.workspace.mode === "origin_read_only") ||
          (node.agent.mode === "build" && node.agent.taskProfile === "coding" && node.workspace.mode !== "origin_read_only")
        )) || (node.kind === "verification" && node.workspace.mode !== "origin_read_only" &&
          node.budget.maxCommandExecutions >= 1 && node.budget.maxCommandOutputBytes >= 1),
      prepareWorkspace: async (input) => {
        if (input.node.workspace.mode === "origin_read_only") {
          return Object.freeze({ binding: null, executionRoot: options.cwd });
        }
        const handle = await (await manager).locate({
          graphId: input.graph.graphId,
          graphRevision: input.graph.revision,
          graphSha256: input.graph.graphSha256,
          nodeId: input.node.nodeId,
        });
        const source = await (await RepositorySourceSnapshotter.create(handle.workspacePath, { environment: options.env })).snapshot(input.signal);
        return Object.freeze({
          binding: Object.freeze({
            managed_path_sha256: handle.identity.managedPathSha256,
            repository_id: handle.identity.repositoryId,
            source_snapshot_sha256: source.snapshot.sourceStateSha256,
            workspace_baseline_sha256: handle.baselineManifestSha256,
            workspace_id: handle.identity.workspaceId,
          }),
          executionRoot: handle.workspacePath,
        });
      },
      start: async (input) => {
        const deferredController = new AbortController();
        const deferredApproval = approvalMode === "defer"
          ? new BackgroundDeferredApprovalPrompt(() => deferredController.abort())
          : null;
        if (input.node.kind === "verification") {
          const verificationNode = input.node;
          const startedWriter = await openTaskWriter(context);
          try {
            await startedWriter.appendTaskGraphEvent("task_node.attempt.started", {
              attempt_id: input.attemptId,
              graph_id: input.graph.graphId,
              graph_revision: input.graph.revision,
              graph_sha256: input.graph.graphSha256,
              node_id: input.node.nodeId,
              run_id: input.runId,
              scheduler_lease_nonce_sha256: input.schedulerLeaseNonceSha256,
            });
          } finally {
            await startedWriter.close();
          }
          const result = (async (): Promise<TaskAttemptExecutionResultV1> => {
            const zero = (
              terminal: TaskAttemptExecutionResultV1["terminal"],
              waitingForUser?: NonNullable<TaskAttemptExecutionResultV1["waitingForUser"]>,
              diagnosticCode?: string,
            ): TaskAttemptExecutionResultV1 => Object.freeze({
              budget: Object.freeze({
                artifactBytes: 0,
                attempts: 1,
                changedBytes: 0,
                changedFiles: 0,
                commandExecutions: 0,
                commandOutputBytes: 0,
                durationMs: 0,
                modelSteps: 0,
                reportedTokens: 0,
              }),
              receiptArtifactId: null,
              receiptSha256: null,
              ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
              terminal,
              usageCompleteness: "complete",
              ...(waitingForUser === undefined ? {} : { waitingForUser }),
            });
            try {
              const registry = createDefaultExecutableRegistry({
                execPath: options.execPath,
                hostEnvironment: options.env,
                platform: options.platform,
              });
              const preparer = await ExecutionPreparer.create({
                hostEnvironment: options.env,
                platform: options.platform,
                registry,
                workspace: input.workspace.executionRoot,
              });
              const [logicalExecutable, ...args] = verificationNode.verification.argv;
              const prepared = await preparer.prepare({
                args,
                cwd: verificationNode.verification.cwd,
                executable: logicalExecutable!,
                outputLimitBytes: input.node.budget.maxCommandOutputBytes,
                purpose: "verify",
                timeoutMs: input.node.budget.maxDurationMs,
              });
              const permission = permissionEngine.evaluate(
                prepared.actionIdentity,
                createTrustedLocalFixturePermissionContext(prepared.actionIdentity) ?? {},
              );
              if (permission.effect === "deny") {
                return zero("known_failed", undefined, permission.reasonCode);
              }
              const prompt = deferredApproval ?? new TerminalApprovalPrompt({ ...options.approvalInput, output: io.stderr });
              const decision = await prompt.request({
                actionKind: "run_command",
                actionSha256: prepared.actionSha256,
                args: prepared.request.args,
                cwd: verificationNode.verification.cwd,
                executable: prepared.request.logicalExecutable,
                executor: "local",
                purpose: "verify",
                reviewLines: Object.freeze([
                  `node: ${input.node.nodeId}`,
                  `purpose: ${verificationNode.verification.purpose}`,
                  ...prepared.review.lifecycleScripts.map((script) => `${script.name}: ${script.body}`),
                ]),
                riskWarning: prepared.review.warning,
              }, input.signal);
              if (deferredApproval?.deferred != null) {
                return zero("pre_effect_infrastructure_failure", deferredApproval.deferred);
              }
              if (decision !== "approved") return zero(decision === "cancelled" ? "cancelled_clean" : "known_failed");
              if (await prepared.revalidate() !== "current") return zero("pre_effect_infrastructure_failure");
              const executor = new LocalExecutor({
                clock: { now: () => performance.now() },
                platform: options.platform,
                processTreeCleanup: createCleanup(),
                redact: (value) => redactSensitiveText(value),
                spawn: createNodeSpawnAdapter(spawn),
                timers,
              });
              let completed: ExecutionResult | null = null;
              for await (const signal of executor.execute(prepared, input.signal)) {
                if (signal.type === "completed") completed = signal.result;
              }
              if (completed === null) return zero("blocked_reconciliation");
              const command = completed as ExecutionResult;
              let terminal: TaskAttemptExecutionResultV1["terminal"] =
                !command.cleanupVerified ? "blocked_reconciliation"
                  : command.termination === "cancelled" ? "cancelled_clean"
                    : command.exitCode === 0 && command.termination === "exit" ? "succeeded"
                      : "known_failed";
              if (terminal === "succeeded" && input.workspace.binding !== null) {
                try {
                  const after = await (await RepositorySourceSnapshotter.create(
                    input.workspace.executionRoot,
                    { environment: options.env },
                  )).snapshot(input.signal);
                  if (after.snapshot.sourceStateSha256 !== input.workspace.binding.source_snapshot_sha256) {
                    terminal = "blocked_reconciliation";
                  } else {
                    await (await manager).acceptSnapshot({
                      attemptId: input.attemptId,
                      graph: input.graph,
                      nodeId: input.node.nodeId,
                    });
                  }
                } catch {
                  terminal = "blocked_reconciliation";
                }
              }
              return Object.freeze({
                budget: Object.freeze({
                  artifactBytes: 0,
                  attempts: 1,
                  // A verification attempt proves an inherited snapshot; it
                  // does not consume the predecessor's changed-file budget a
                  // second time. Source mutation is rejected above.
                  changedBytes: 0,
                  changedFiles: 0,
                  commandExecutions: command.termination === "spawn_error" ? 0 : 1,
                  commandOutputBytes: command.stdoutBytes + command.stderrBytes,
                  durationMs: command.durationMs,
                  modelSteps: 0,
                  reportedTokens: 0,
                }),
                receiptArtifactId: null,
                receiptSha256: null,
                structuredEvidence: Object.freeze([
                  Object.freeze({
                    artifactRef: "task-graph/verification-action/v1",
                    kind: "verification_action",
                    sha256: prepared.actionSha256,
                  }),
                  Object.freeze({
                    artifactRef: "task-graph/verification-command/v1",
                    kind: "verification_command",
                    sha256: sha256Canonical({
                      argv: verificationNode.verification.argv,
                      cwd: verificationNode.verification.cwd,
                      purpose: verificationNode.verification.purpose,
                    }),
                  }),
                ]),
                ...(terminal === "succeeded" ? {} : { diagnosticCode: command.errorCode ?? command.termination }),
                terminal,
                usageCompleteness: "complete",
              });
            } catch (error) {
              const diagnosticCode = error instanceof ExecutionPreparationError
                ? error.code
                : error instanceof Error ? error.name : "unknown_verification_preflight";
              return zero("pre_effect_infrastructure_failure", undefined, diagnosticCode);
            }
          })();
          return Object.freeze({ attemptStartedPersisted: true, result });
        }
        if (
          input.node.kind !== "agent" ||
          (input.node.agent.mode === "plan") !== (input.node.workspace.mode === "origin_read_only")
        ) {
          throw new TypeError("production Graph executor received an unsupported node");
        }
        const writer = await openTaskWriter(context);
        const before = reconstructMultiRunSession(writer.events);
        const graphModelTask = await buildGraphNodeModelTask({
          graph: input.graph,
          node: input.node,
          session: before,
          workspace: input.workspace,
          workspaceRoot: options.cwd,
        });
        let started = false;
        let resolveStarted!: () => void;
        const startedSignal = new Promise<void>((resolveStartedSignal) => {
          resolveStarted = resolveStartedSignal;
        });
        const nodeRuntime: CliRuntime = {
          ...createNodeRuntime({
            ...options,
            ...(deferredApproval === null ? {} : { approvalPromptOverride: deferredApproval }),
            cwd: input.workspace.executionRoot,
            onCancel: (listener) => {
              const removeHost = options.onCancel(listener);
              const onAbort = () => listener();
              const onDeferred = () => listener();
              input.signal.addEventListener("abort", onAbort, { once: true });
              deferredController.signal.addEventListener("abort", onDeferred, { once: true });
              return () => {
                input.signal.removeEventListener("abort", onAbort);
                deferredController.signal.removeEventListener("abort", onDeferred);
                removeHost();
              };
            },
          }),
          ...options.taskAgentRuntimeOverrides,
        };
        const execution = executeAgent({
          commandApproval: input.node.agent.mode === "build" ? "ask" : "deny",
          commandTimeoutMs: undefined,
          completionPolicy: "verified",
          editApproval: input.node.agent.mode === "build" ? "ask" : "deny",
          maxDurationMs: String(input.node.budget.maxDurationMs),
          maxCommandOutputBytes: String(input.node.budget.maxCommandOutputBytes),
          maxSteps: String(input.node.budget.maxModelSteps),
          maxTokens: input.node.budget.maxReportedTokens === null
            ? undefined
            : String(input.node.budget.maxReportedTokens),
          maxToolOutputBytes: String(Math.max(1, input.node.budget.maxArtifactBytes)),
          mode: input.node.agent.mode,
          modeSource: "explicit_cli",
          model: undefined,
          policyProfile: runtimeProfileId,
          provider: undefined,
          reportFormat: "text",
          requestTimeoutMs: undefined,
          requireVerification: "auto",
          task: input.node.objective,
          taskProfile: input.node.agent.taskProfile,
          verbose: false,
        }, nodeRuntime, io, undefined, {
          modelTask: graphModelTask,
          onTaskNodeStarted: () => {
            started = true;
            resolveStarted();
          },
          runId: input.runId,
          sessionId,
          ...(before.lastRun === null ? {} : { sourceRunId: before.lastRun.runId }),
          taskNodeBinding: {
            attempt_id: input.attemptId,
            attempt_number: input.attemptNumber,
            graph_id: input.graph.graphId,
            graph_revision: input.graph.revision,
            graph_sha256: input.graph.graphSha256,
            node_id: input.node.nodeId,
            scheduler_lease_nonce_sha256: input.schedulerLeaseNonceSha256,
          },
          writer,
        });
        await Promise.race([
          startedSignal,
          execution.then(() => {
            if (!started) throw new Error("Graph node run failed before durable start");
          }),
        ]);
        const result = execution.then(async (exitCode): Promise<TaskAttemptExecutionResultV1> => {
          const session = reconstructMultiRunSession(writer.events);
          const run = session.runs.find((candidate) => candidate.runId === input.runId);
          if (run === undefined || run.terminal === undefined) {
            throw new Error("Graph node executor produced no terminal run projection");
          }
          const usage = [...run.events].reverse().find((event) => event.type === "usage");
          const commands = run.events.filter((event) => event.type === "command.completed");
          const artifacts = run.events.filter((event) => event.type === "artifact.stored");
          const terminalDuration = "duration_ms" in run.terminal.data ? run.terminal.data.duration_ms : 0;
          const effectBlocker = taskMutationBlocker(session);
          const terminal: TaskAttemptExecutionResultV1["terminal"] = deferredApproval?.deferred != null
            ? "pre_effect_infrastructure_failure"
            : effectBlocker !== null
            ? "blocked_reconciliation"
            : exitCode === 0 && run.status === "completed"
              ? "succeeded"
              : exitCode === 130 && run.status === "cancelled"
                ? "cancelled_clean"
                : "known_failed";
          let accepted: Awaited<ReturnType<ManagedWorktreeManager["acceptSnapshot"]>> | null = null;
          if (terminal === "succeeded" && input.workspace.binding !== null) {
            try {
              accepted = await (await manager).acceptSnapshot({ attemptId: input.attemptId, graph: input.graph, nodeId: input.node.nodeId });
            } catch {
              return Object.freeze({
                budget: Object.freeze({
                  artifactBytes: artifacts.reduce((sum, event) => sum + event.data.bytes, 0), attempts: 1,
                  changedBytes: 0, changedFiles: 0, commandExecutions: commands.length,
                  commandOutputBytes: commands.reduce((sum, event) => sum + event.data.total_bytes, 0), durationMs: terminalDuration,
                  modelSteps: run.events.filter((event) => event.type === "agent.step.started").length,
                  reportedTokens: usage?.type === "usage" ? usage.data.total_tokens : null,
                }),
                receiptArtifactId: null, receiptSha256: null, terminal: "blocked_reconciliation", usageCompleteness: usage?.type !== "usage" ? "none" : usage.data.usage_incomplete === true ? "partial" : "complete",
              });
            }
          }
          return Object.freeze({
            budget: Object.freeze({
              artifactBytes: artifacts.reduce((sum, event) => sum + event.data.bytes, 0),
              attempts: 1,
              changedBytes: accepted?.changedBytes ?? 0,
              changedFiles: accepted?.changedFiles ?? 0,
              commandExecutions: commands.length,
              commandOutputBytes: commands.reduce((sum, event) => sum + event.data.total_bytes, 0),
              durationMs: terminalDuration,
              modelSteps: run.events.filter((event) => event.type === "agent.step.started").length,
              reportedTokens: usage?.type === "usage" ? usage.data.total_tokens : null,
            }),
            receiptArtifactId: null,
            receiptSha256: null,
            terminal,
            usageCompleteness: usage?.type !== "usage"
              ? "none"
              : usage.data.usage_incomplete === true ? "partial" : "complete",
            ...(deferredApproval?.deferred === null || deferredApproval?.deferred === undefined
              ? {}
              : { waitingForUser: deferredApproval.deferred }),
          });
        });
        return Object.freeze({ attemptStartedPersisted: true, result });
      },
    });
    };
  return {
    // PHASE8: loopback selection alone is not live verification. Coding
    // completion remains closed until a separate immutable Ollama evidence run
    // exists; read-only runs do not need to claim that stronger status.
    agentModelEvidence: () => null,
    hooksSuppressed: options.env.BORN_HOOK_SUPPRESSED === "1",
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: (io) => options.approvalPromptOverride ??
      new TerminalApprovalPrompt({
        ...options.approvalInput,
        output: io.stderr,
      }),
    createCapabilityPlatform: (workspace) =>
      new DefaultCapabilityPlatform({
        builtinRoot: capabilityAssetsRoot,
        env: options.env,
        platform: options.platform,
        pluginLifecycle: createPluginLifecycle(workspace),
        userStateRoot: capabilityUserStateRoot,
        workspace,
      }),
    createHookCommandRunner: ({ content, prompt, secrets, workspace }) =>
      new HookCommandRunner({
        cleanup: createCleanup(),
        content,
        environment: options.env,
        executable: options.execPath,
        operationRoot: hookOperationRoot,
        prompt,
        randomUUID,
        secrets,
        ...(options.cliEntryPath === undefined
          ? {}
          : { supervisorCliEntryPath: options.cliEntryPath }),
        timestamp: () => new Date().toISOString(),
        workspace,
      }),
    reconcileHookCommandOperations: ({ sessionId, writer }) =>
      new HookCommandOperationReconciler({
        operationRoot: hookOperationRoot,
        randomUUID,
        sessionId,
        timestamp: () => new Date().toISOString(),
        workspace: options.cwd,
        writer,
      }).reconcile(),
    reconcilePluginLeases: ({ sessionId, writer }) =>
      createPluginLifecycle(options.cwd).reconcileLeases(sessionId, writer.events),
    createTaskAttemptExecutor,
    ...(options.cliEntryPath === undefined ? {} : {
      runInternalHookCommandSupervisor: async (input: {
        readonly invocationId: string;
        readonly runId: string;
        readonly sessionId: string;
      }): Promise<void> => new HookCommandSupervisor({
        cleanup: createCleanup(),
        operationRoot: hookOperationRoot,
      }).run(input),
      doctorBackgroundWorker: async () => (await sealBackgroundExecutable({
        cliEntryPath: options.cliEntryPath!,
        nodeExecutablePath: options.execPath,
        nodeVersion: options.nodeVersion,
      })).descriptor,
      createBackgroundWorkerLauncher: ({ sessionId }: { readonly sessionId: string }) => new BackgroundWorkerLauncher({
        cliEntryPath: options.cliEntryPath!,
        context: taskContext(sessionId),
        environment: options.env,
        nodeExecutablePath: options.execPath,
        nodeVersion: options.nodeVersion,
        userStateRoot: workerUserStateRoot(),
        worktreeUserStateRoot: worktreeUserStateRoot(),
      }),
      observeBackgroundWorkerLive: async ({ sessionId }: { readonly sessionId: string }) => {
        const session = await new SessionCatalog(options.cwd).read(sessionId);
        return observeBackgroundWorkerLive({
          current: session.background.current,
          ownerProbe: new NodeProcessIdentityProbe(),
          userStateRoot: workerUserStateRoot(),
        });
      },
      reconcileBackgroundWorkerTakeover: ({ graphRevision, graphSha256, sessionId }: {
        readonly graphRevision: number;
        readonly graphSha256: string;
        readonly sessionId: string;
      }) => new BackgroundWorkerTakeoverReconciler({
        context: taskContext(sessionId),
        ownerProbe: new NodeProcessIdentityProbe(),
        userStateRoot: workerUserStateRoot(),
      }).reconcile({ graphRevision, graphSha256 }),
      queueBackgroundWorkerCancel: async (input: {
        readonly graphRevision: number;
        readonly graphSha256: string;
        readonly reason: string;
        readonly sessionId: string;
      }) => {
        const session = await new SessionCatalog(options.cwd).read(input.sessionId);
        const queued = await queueBackgroundWorkerCancel({
          current: session.background.current,
          graphRevision: input.graphRevision,
          graphSha256: input.graphSha256,
          now: () => new Date().toISOString(),
          randomUuid: randomUUID,
          reason: input.reason,
          userStateRoot: workerUserStateRoot(),
        });
        return Object.freeze({
          controlSha256: queued.controlSha256,
          operationId: queued.control.operationId,
          requestId: queued.control.requestId,
          workerId: queued.control.workerId,
        });
      },
      runInternalGraphWorker: async (input: {
        readonly io: Parameters<NonNullable<CliRuntime["runInternalGraphWorker"]>>[0]["io"];
        readonly operationId: string;
        readonly repositoryId: string;
      }) => new BackgroundWorkerRuntime({
        createExecutor: (executorInput) => createTaskAttemptExecutor(executorInput),
        currentCliEntryPath: options.cliEntryPath!,
        environment: options.env,
        io: input.io,
        nodeVersion: options.nodeVersion,
        operationId: input.operationId,
        repositoryId: input.repositoryId,
        userStateRoot: workerUserStateRoot(),
      }).run(),
    }),
    createManagedWorktreeManager,
    createWorktreePromotionRuntime: async ({ io, sessionId }) => {
      const manager = await createManagedWorktreeManager({ io, sessionId });
      const prompt = new TerminalApprovalPrompt({ ...options.approvalInput, output: io.stderr });
      const originVerification = new OriginVerificationRuntime({
        context: taskContext(sessionId),
        createExecutor: () => new LocalExecutor({
          clock: { now: () => performance.now() },
          platform: options.platform,
          processTreeCleanup: createCleanup(),
          redact: (value) => redactSensitiveText(value),
          spawn: createNodeSpawnAdapter(spawn),
          timers,
        }),
        createPreparer: async () => ExecutionPreparer.create({
          hostEnvironment: options.env,
          platform: options.platform,
          registry: createDefaultExecutableRegistry({
            execPath: options.execPath,
            hostEnvironment: options.env,
            platform: options.platform,
          }),
          workspace: options.cwd,
        }),
        environment: options.env,
        permissionContext: (action) => createTrustedLocalFixturePermissionContext(action) ?? {},
        permissionEngine,
        prompt,
      });
      return new WorktreePromotionRuntime({
        context: taskContext(sessionId),
        manager,
        originVerification,
        prompt,
        repositoryRulesSha256: await repositoryRuleIdentity(options.cwd),
      });
    },
    createPluginLifecycle,
    createMcpClientManager: ({ artifacts, events, hooks, prompt, recency, secrets = [] }) => {
      const launcher = new McpServerLauncher({
        cleanup: createCleanup(),
        environment: options.env,
        events,
        ...(hooks === undefined ? {} : { hooks }),
        now: () => performance.now(),
        permissionEngine,
        platform: options.platform,
        prompt,
        randomUUID,
        workspace: options.cwd,
      });
      return new McpClientManager({
        ...(artifacts === undefined ? {} : { artifacts }),
        events,
        ...(hooks === undefined ? {} : { hooks }),
        launcher,
        permissionEngine,
        prompt,
        randomUUID,
        ...(recency === undefined ? {} : { recency }),
        secrets,
      });
    },
    createAgentToolRegistry: async (registryOptions) => {
      if (registryOptions.taskProfile === "read-only") {
        if (registryOptions.updatePlanTool !== undefined) {
          return createPlanToolRegistry(
            registryOptions.workspace,
            registryOptions.updatePlanTool,
            registryOptions.secrets ?? [],
            registryOptions.artifactRuntime,
            registryOptions.repositoryRules === undefined
              ? undefined
              : {
                  assertFresh: registryOptions.repositoryRules.assertFresh,
                  tracker: registryOptions.repositoryRules.tracker,
                },
            registryOptions.repositoryNavigation,
            registryOptions.additionalTools ?? [],
          );
        }
        return createReadonlyToolRegistry(
          registryOptions.workspace,
          registryOptions.secrets ?? [],
          registryOptions.artifactRuntime,
          registryOptions.additionalTools ?? [],
          registryOptions.repositoryRules === undefined
            ? undefined
            : {
                assertFresh: registryOptions.repositoryRules.assertFresh,
                tracker: registryOptions.repositoryRules.tracker,
              },
          registryOptions.repositoryNavigation,
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
                    ...(sandbox.imageIdentity?.kind === "trusted_local_build"
                      ? { localBuildIdentity: sandbox.imageIdentity }
                      : {}),
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
    supportsPhase16TaskState: true,
    createRepositoryNavigationService: (workspace, secrets, events) =>
      DefaultRepositoryNavigationService.create(workspace, {
        ...(events === undefined ? {} : { events }),
        secrets,
      }),
    // PHASE14: construct credential-aware provider machinery only for ordinary model commands; `born eval` owns a separate no-credential runtime.
    createModelBackend: (request) => createProductionBackendFactory(options.env).create(request),
    cwd: options.cwd,
    // PHASE3: production runtime 在这里装配固定只读 Registry；测试可替换为 FakeToolRegistry。
    createToolRegistry: createReadonlyToolRegistry,
    env: options.env,
    dockerArtifactAcquirer: new DockerArtifactAcquirer(
      new NodeDockerAcquisitionPort(options.env),
      options.env,
      options.platform,
    ),
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
      environment: options.env,
      ...(options.env.BORN_DOCKER_IMAGE === undefined
        ? {}
        : { graderImage: options.env.BORN_DOCKER_IMAGE }),
    }),
    isReadableDirectory,
    nodeVersion: options.nodeVersion,
    modelQualificationGate: new UserStateModelQualificationGate({
      env: options.env,
      platform: options.platform,
      refreshLocalModelCatalog: (request) => localModelCatalog.refresh(request),
    }),
    // PHASE4: duration budgets use a monotonic clock so wall-clock adjustments cannot
    // accidentally extend or prematurely exhaust a run; timestamps remain UTC wall time.
    now: () => performance.now(),
    onCancel: options.onCancel,
    platform: options.platform,
    randomUUID,
    refreshLocalModelCatalog: (request) => localModelCatalog.refresh(request),
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
