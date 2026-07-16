import type {
  CommandApprovalMode,
  EditApprovalMode,
  ReportFormat,
  TaskProfile,
} from "../agent/agent-types.js";
import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { CommandApprovalGate } from "../approvals/command-approval-gate.js";
import { PatchApprovalGate } from "../approvals/patch-approval-gate.js";
import { ChangeJournal } from "../changes/change-journal.js";
import { AtomicPatchApplier } from "../changes/patch-applier.js";
import { PatchPlanner } from "../changes/patch-planner.js";
import type { EventPublisher } from "../events/event-publisher.js";
import type { ExecutionPreparer } from "../execution/execution-preparer.js";
import type { Executor, PreparedExecution } from "../execution/execution-types.js";
import type {
  PermissionContext,
  PermissionEngineLike,
} from "../permissions/permission-types.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import { createReadArtifactTool } from "./read-artifact-tool.js";
import { createFinishTaskTool } from "../completion/finish-task-tool.js";
import { VerifiedCompletionPolicy } from "../completion/completion-policy.js";
import {
  Phase7CompletionRuntime,
  type PreparedVerificationClassifier,
} from "../completion/phase7-completion-runtime.js";
import type { ModelEvidence } from "../completion/completion-types.js";
import { createReadonlyToolDefinitions } from "./create-readonly-tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { createRunCommandTool } from "./run-command-tool.js";
import type { ToolDefinition } from "./tool-types.js";

export interface AgentToolRegistryOptions {
  readonly artifactRuntime?: ArtifactSessionRuntimeLike;
  readonly approvalMode: EditApprovalMode;
  readonly approvalPrompt: ApprovalPrompt;
  readonly caseInsensitivePaths: boolean;
  readonly commandApprovalMode: CommandApprovalMode;
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  readonly modelEvidence: ModelEvidence;
  readonly now: () => number;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
  readonly reportFormat: ReportFormat;
  readonly runId: string;
  readonly secrets?: readonly (string | undefined)[];
  readonly taskProfile: TaskProfile;
  readonly sessionId: string;
  readonly timestamp: () => string;
  readonly workspace: string;
}

export interface AgentToolRegistryDependencies {
  readonly executionPreparer: ExecutionPreparer;
  readonly executor: Executor;
  readonly permissionContext: (prepared: PreparedExecution) => PermissionContext;
  readonly permissionEngine: PermissionEngineLike;
  readonly verificationClassifier?: PreparedVerificationClassifier;
}

export async function createAgentToolRegistry(
  options: AgentToolRegistryOptions & AgentToolRegistryDependencies,
): Promise<ToolRegistry> {
  const planner = await PatchPlanner.create(options.workspace, {
    caseInsensitive: options.caseInsensitivePaths,
  });
  const journal = new ChangeJournal();
  const applier = new AtomicPatchApplier({
    journal,
    now: () => new Date(options.timestamp()),
    planner,
    randomId: options.randomUUID,
  });
  const approvalGate = new PatchApprovalGate({
    mode: options.approvalMode,
    prompt: options.approvalPrompt,
    publisher: options.publisher,
    randomUUID: options.randomUUID,
  });
  const commandApprovalGate = new CommandApprovalGate({
    mode: options.commandApprovalMode,
    prompt: options.approvalPrompt,
    publisher: options.publisher,
    randomUUID: options.randomUUID,
  });
  const completion =
    options.verificationClassifier === undefined
      ? undefined
      : await Phase7CompletionRuntime.create({
          classifier: options.verificationClassifier,
          journal,
          modelEvidence: options.modelEvidence,
          publisher: options.publisher,
          randomUUID: options.randomUUID,
          runId: options.runId,
          sessionId: options.sessionId,
          workspace: options.workspace,
        });
  const definitions: ToolDefinition<unknown>[] = [
    ...(await createReadonlyToolDefinitions(options.workspace)),
    ...(options.artifactRuntime === undefined
      ? []
      : [
          createReadArtifactTool(
            options.artifactRuntime.reader,
          ) as ToolDefinition<unknown>,
        ]),
    createApplyPatchTool({
      approvalGate,
      applier,
      now: options.now,
      ...(completion === undefined
        ? {}
        : {
            onApplied: () => {
              completion.recordPatchApplied();
            },
          }),
      planner,
      publisher: options.publisher,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    }) as ToolDefinition<unknown>,
    createRunCommandTool({
      approvalGate: commandApprovalGate,
      defaultTimeoutMs: options.commandTimeoutMs,
      executor: options.executor,
      maxOutputBytes: options.maxCommandOutputBytes,
      permissionContext: options.permissionContext,
      permissionEngine: options.permissionEngine,
      preparer: options.executionPreparer,
      publisher: options.publisher,
      randomUUID: options.randomUUID,
      ...(completion === undefined ? {} : { verification: completion }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    }) as ToolDefinition<unknown>,
    ...(completion === undefined
      ? []
      : [
          createFinishTaskTool({
            policy: new VerifiedCompletionPolicy(),
            publisher: options.publisher,
            state: () => completion.state(),
          }) as ToolDefinition<unknown>,
        ]),
  ];

  // PHASE5: agent 显式装配唯一 mutation tool；chat 的独立 readonly factory 无法意外继承它。
  // deterministic fake 能证明批准协议和磁盘事实，但不能被重新标记成 live provider 证据。
  const mutations = definitions.filter(
    (definition) => definition.capability === "mutation",
  );
  const expectedMutations =
    completion === undefined
      ? "apply_patch,run_command"
      : "apply_patch,finish_task,run_command";
  if (
    mutations.map((definition) => definition.name).sort().join(",") !==
    expectedMutations
  ) {
    throw new Error(
      `agent registry must contain exactly ${expectedMutations} mutations`,
    );
  }
  return new ToolRegistry(
    definitions,
    options.secrets ?? [],
    completion,
    options.artifactRuntime,
  );
}
