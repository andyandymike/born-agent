import type {
  CommandApprovalMode,
  EditApprovalMode,
  ExecutionBackendKind,
  ReportFormat,
  ResolvedDockerSandboxConfig,
  TaskProfile,
} from "../agent/agent-types.js";
import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { CommandApprovalGate } from "../approvals/command-approval-gate.js";
import { PatchApprovalGate } from "../approvals/patch-approval-gate.js";
import { ChangeJournal } from "../changes/change-journal.js";
import { AtomicPatchApplier } from "../changes/patch-applier.js";
import { PatchPlanner } from "../changes/patch-planner.js";
import type { PatchPlan } from "../changes/patch-types.js";
import type { EventPublisher } from "../events/event-publisher.js";
import type {
  ExecutionPreparerLike,
  Executor,
  PreparedExecution,
} from "../execution/execution-types.js";
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
import type {
  CompletionPolicy,
  GoalRevisionAttributionScope,
} from "../completion/completion-types.js";
import type { VerifiedGoalChangeSeed } from "../coordination/goal-change-seed.js";
import { createReadonlyToolDefinitions } from "./create-readonly-tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { createRunCommandTool } from "./run-command-tool.js";
import type { ToolDefinition, ToolRegistration } from "./tool-types.js";
import type { SandboxEventAppender } from "../execution/docker/sandbox-event-schema.js";
import type { UpdatePlanInput } from "../plans/update-plan-input-schema.js";
import type { RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";
import type { RepositoryRuleObservationTracker } from "../repository-rules/repository-rule-observation-binding.js";
import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import type { EffectHookPipeline } from "../hooks/hook-pipeline.js";

export interface AgentToolRegistryOptions {
  readonly additionalTools?: readonly ToolRegistration<unknown>[];
  readonly artifactRuntime?: ArtifactSessionRuntimeLike;
  readonly approvalMode: EditApprovalMode;
  readonly approvalPrompt: ApprovalPrompt;
  readonly caseInsensitivePaths: boolean;
  readonly commandApprovalMode: CommandApprovalMode;
  readonly commandTimeoutMs: number;
  readonly dockerSandbox?: ResolvedDockerSandboxConfig;
  readonly delegationProposalTool?: ToolDefinition<unknown>;
  readonly executorKind?: ExecutionBackendKind;
  readonly maxCommandOutputBytes: number;
  readonly modelEvidence: ModelEvidence;
  readonly goalChange?: {
    readonly attributionScope: () => GoalRevisionAttributionScope;
    readonly beforeCapture: (plan: PatchPlan) => Promise<void> | void;
    readonly completionPolicy: CompletionPolicy;
    readonly goalId: string;
    readonly goalRevision: number;
    readonly seed: VerifiedGoalChangeSeed;
  };
  readonly hooks?: EffectHookPipeline;
  readonly now: () => number;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
  readonly repositoryRules?: {
    readonly assertFresh: () => Promise<void>;
    readonly resolver: RepositoryRuleScopeResolver;
    readonly tracker: RepositoryRuleObservationTracker;
  };
  readonly repositoryNavigation?: RepositoryNavigationService;
  readonly reportFormat: ReportFormat;
  readonly runId: string;
  readonly sandboxEvents?: SandboxEventAppender;
  readonly secrets?: readonly (string | undefined)[];
  readonly taskProfile: TaskProfile;
  /** Graph-node runs may finish their attempt, but never mutate the Goal/Plan control plane. */
  readonly taskNodeExecution?: boolean;
  readonly sessionId: string;
  readonly timestamp: () => string;
  readonly updatePlanTool?: ToolDefinition<UpdatePlanInput>;
  readonly workspace: string;
}

export interface AgentToolRegistryDependencies {
  readonly executionPreparer: ExecutionPreparerLike;
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
  if (options.goalChange !== undefined && options.artifactRuntime === undefined) {
    throw new Error("Goal change capture requires the durable artifact runtime");
  }
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
          ...(options.goalChange === undefined
            ? {}
            : {
                attributionScope: options.goalChange.attributionScope,
                goalChangeSeed: options.goalChange.seed,
              }),
          journal,
          modelEvidence: options.modelEvidence,
          publisher: options.publisher,
          randomUUID: options.randomUUID,
          runId: options.runId,
          sessionId: options.sessionId,
          workspace: options.workspace,
        });
  const definitions: ToolRegistration<unknown>[] = [
    ...(await createReadonlyToolDefinitions(
      options.workspace,
      undefined,
      options.repositoryRules === undefined
        ? undefined
        : {
            assertFresh: options.repositoryRules.assertFresh,
            tracker: options.repositoryRules.tracker,
          },
      options.repositoryNavigation,
    )),
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
      ...(options.goalChange === undefined
        ? {}
        : {
            goalChange: {
              artifactRuntime: options.artifactRuntime!,
              beforeCapture: options.goalChange.beforeCapture,
              goalId: options.goalChange.goalId,
              goalRevision: options.goalChange.goalRevision,
            },
          }),
      ...(completion === undefined
        ? {}
        : {
            onApplied: () => {
              completion.recordPatchApplied();
            },
          }),
      planner,
      publisher: options.publisher,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ...(options.repositoryRules === undefined
        ? {}
        : { repositoryRules: options.repositoryRules }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    }) as ToolDefinition<unknown>,
    createRunCommandTool({
      approvalGate: commandApprovalGate,
      ...(options.repositoryRules === undefined
        ? {}
        : { beforeEffect: options.repositoryRules.assertFresh }),
      defaultTimeoutMs: options.commandTimeoutMs,
      executor: options.executor,
      maxOutputBytes: options.maxCommandOutputBytes,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
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
            ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
             policy:
               options.goalChange?.completionPolicy ??
               new VerifiedCompletionPolicy(),
            publisher: options.publisher,
            state: () => completion.state(),
          }) as ToolDefinition<unknown>,
        ]),
    ...(options.updatePlanTool === undefined
      ? []
      : [options.updatePlanTool as ToolDefinition<unknown>]),
    ...(options.delegationProposalTool === undefined
      ? []
      : [options.delegationProposalTool]),
    ...(options.additionalTools ?? []),
  ];

  // PHASE5: agent 显式装配唯一 mutation tool；chat 的独立 readonly factory 无法意外继承它。
  // deterministic fake 能证明批准协议和磁盘事实，但不能被重新标记成 live provider 证据。
  const mutations = definitions.filter(
    (definition) =>
      definition.capability === "mutation" &&
      !("origin" in definition && definition.origin.kind === "mcp"),
  );
  const expectedMutations =
    completion === undefined
      ? `apply_patch${options.delegationProposalTool === undefined ? "" : ",propose_delegation"},run_command${options.updatePlanTool === undefined ? "" : ",update_plan"}`
      : `apply_patch,finish_task${options.delegationProposalTool === undefined ? "" : ",propose_delegation"},run_command${options.updatePlanTool === undefined ? "" : ",update_plan"}`;
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
