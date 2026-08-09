import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import type { ExecutionPreparerLike, ExecutionResult, Executor } from "../execution/execution-types.js";
import type { CommandActionIdentity, PermissionContext, PermissionEngineLike } from "../permissions/permission-types.js";
import { RepositorySourceSnapshotter } from "../repository-intelligence/source-snapshotter.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { parseStrictJson } from "../system/strict-json.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import { taskNodeReceiptSchema } from "../task-graph/task-node-receipt.js";
import {
  persistOriginVerificationReceipt,
  type OriginVerificationReceiptV1,
} from "./origin-verification-receipt.js";
import { WorktreeError } from "./worktree-errors.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function staleResult(): ExecutionResult {
  return Object.freeze({
    cleanupVerified: true,
    durationMs: 0,
    exitCode: null,
    ok: false,
    signal: null,
    stderr: "",
    stderrBytes: 0,
    stdout: "",
    stdoutBytes: 0,
    termination: "stale" as const,
    truncated: false,
  });
}

export interface OriginVerificationResultV1 {
  readonly actionSha256: string;
  readonly commandSha256: string;
  readonly completedEventId: string;
  readonly receiptArtifactId: string;
  readonly receiptSha256: string;
  readonly status: OriginVerificationReceiptV1["status"];
  readonly verificationId: string;
  readonly verificationNodeId: string;
}

/**
 * Replays one Graph verification action against the exact post-promotion
 * origin source snapshot. A managed-worktree success is only an eligibility
 * proof; this runtime crosses a fresh policy and approval boundary.
 */
export class OriginVerificationRuntime {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly createExecutor: () => Executor;
    readonly createPreparer: () => Promise<ExecutionPreparerLike>;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly permissionContext: (action: CommandActionIdentity) => PermissionContext;
    readonly permissionEngine: PermissionEngineLike;
    readonly prompt: ApprovalPrompt;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async verify(input: {
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly promotionOperationId: string;
    readonly signal: AbortSignal;
  }): Promise<OriginVerificationResultV1> {
    let writer = await this.writerFactory(this.options.context);
    let session;
    try {
      session = reconstructMultiRunSession(writer.events);
    } finally {
      await writer.close();
    }
    const promotion = session.worktrees.promotions.find((candidate) =>
      candidate.status === "applied" && candidate.operationId === input.promotionOperationId &&
      candidate.bundle.graphRevision === input.graphRevision && candidate.bundle.graphSha256 === input.graphSha256
    );
    if (promotion === undefined || promotion.originSourceSnapshotSha256 === null) {
      throw new WorktreeError("worktree_promotion_stale", "origin verification has no exact applied promotion target");
    }
    if (session.worktrees.originVerifications.some((candidate) =>
      candidate.promotionOperationId === input.promotionOperationId &&
      (candidate.status === "requested" || candidate.status === "reconciliation_required")
    )) {
      throw new WorktreeError("worktree_operation_incomplete", "an earlier origin verification effect requires reconciliation");
    }
    const execution = session.taskExecution;
    if (execution === null || execution.status !== "awaiting_integration" ||
        execution.graph.graphId !== promotion.bundle.graphId || execution.graph.revision !== promotion.bundle.graphRevision ||
        execution.graph.graphSha256 !== promotion.bundle.graphSha256) {
      throw new WorktreeError("worktree_promotion_stale", "origin verification Graph is no longer awaiting exact integration");
    }
    const verification = [...execution.nodes]
      .filter((candidate) => candidate.node.kind === "verification" && candidate.status === "succeeded" &&
        candidate.attempts.some((attempt) => attempt.terminal === "succeeded" &&
          attempt.workspaceBinding?.workspace_id === promotion.bundle.workspaceId))
      .sort((left, right) => right.node.sequence - left.node.sequence)[0];
    if (verification === undefined || verification.node.kind !== "verification") {
      throw new WorktreeError("worktree_origin_verification_unavailable", "promotion has no successful managed-worktree verification node");
    }
    const attempt = [...verification.attempts].reverse().find((candidate) =>
      candidate.terminal === "succeeded" && candidate.workspaceBinding?.workspace_id === promotion.bundle.workspaceId
    );
    const terminal = attempt?.terminalEventId == null
      ? undefined
      : session.events.find((candidate) => candidate.eventId === attempt.terminalEventId);
    if (attempt === undefined || terminal?.scope !== "session" || terminal.type !== "task_node.attempt.terminal" ||
        terminal.data.receipt_artifact_id === null || terminal.data.receipt_sha256 === null) {
      throw new TaskGraphError("task_graph_artifact_invalid", "managed verification has no exact receipt");
    }
    const artifact = await (await ArtifactStore.create({
      sessionId: session.sessionId,
      workspace: this.options.context.workspace,
    })).readVerified(terminal.data.receipt_artifact_id);
    const managedReceipt = taskNodeReceiptSchema.parse(parseStrictJson(artifact.bytes.toString("utf8")));
    if (managedReceipt.receiptSha256 !== terminal.data.receipt_sha256 || managedReceipt.status !== "succeeded" ||
        managedReceipt.nodeId !== verification.node.nodeId ||
        managedReceipt.workspaceSnapshotSha256 !== promotion.bundle.workspaceSnapshotSha256) {
      throw new TaskGraphError("task_graph_artifact_invalid", "managed verification receipt does not bind the promoted snapshot");
    }
    const actionEvidence = managedReceipt.structuredEvidence.find((evidence) => evidence.kind === "verification_action");
    const commandEvidence = managedReceipt.structuredEvidence.find((evidence) => evidence.kind === "verification_command");
    if (actionEvidence === undefined || commandEvidence === undefined) {
      throw new TaskGraphError("task_graph_artifact_invalid", "managed verification receipt lacks exact action evidence");
    }

    const commandSha256 = sha256Canonical({
      argv: verification.node.verification.argv,
      cwd: verification.node.verification.cwd,
      purpose: verification.node.verification.purpose,
    });
    if (commandEvidence.sha256 !== commandSha256) {
      throw new TaskGraphError("task_graph_artifact_invalid", "managed verification command identity is stale");
    }
    const [logicalExecutable, ...args] = verification.node.verification.argv;
    const prepared = await (await this.options.createPreparer()).prepare({
      args,
      cwd: verification.node.verification.cwd,
      executable: logicalExecutable!,
      outputLimitBytes: verification.node.budget.maxCommandOutputBytes,
      purpose: "verify",
      timeoutMs: verification.node.budget.maxDurationMs,
    });
    if (prepared.actionSha256 !== actionEvidence.sha256) {
      throw new WorktreeError("worktree_origin_verification_unavailable", "origin verification action does not exact-match managed verification evidence");
    }
    const before = await (await RepositorySourceSnapshotter.create(this.options.context.workspace, {
      environment: this.options.environment,
    })).snapshot(input.signal);
    if (before.snapshot.sourceStateSha256 !== promotion.originSourceSnapshotSha256) {
      throw new WorktreeError("worktree_promotion_stale", "origin changed after promotion before verification");
    }
    const permission = this.options.permissionEngine.evaluate(
      prepared.actionIdentity,
      this.options.permissionContext(prepared.actionIdentity),
    );
    if (permission.effect === "deny") {
      throw new WorktreeError("worktree_origin_verification_unavailable", `origin verification policy denied the exact action: ${permission.reasonCode}`);
    }
    const approvalRequestId = this.options.context.randomUuid();
    const verificationId = this.options.context.randomUuid();
    const approvalIdentitySha256 = sha256Canonical({
      action_sha256: prepared.actionSha256,
      approval_request_id: approvalRequestId,
      bundle_sha256: promotion.bundle.bundleSha256,
      command_sha256: commandSha256,
      graph_id: promotion.bundle.graphId,
      graph_revision: promotion.bundle.graphRevision,
      graph_sha256: promotion.bundle.graphSha256,
      origin_source_snapshot_sha256: promotion.originSourceSnapshotSha256,
      promotion_operation_id: input.promotionOperationId,
      session_id: this.options.context.sessionId,
      verification_id: verificationId,
      verification_node_id: verification.node.nodeId,
      workspace_id: promotion.bundle.workspaceId,
    });
    const decision = await this.options.prompt.request({
      actionKind: "run_command",
      actionSha256: prepared.actionSha256,
      args: prepared.request.args,
      cwd: verification.node.verification.cwd,
      executable: prepared.request.logicalExecutable,
      executor: "local",
      purpose: "verify",
      reviewLines: Object.freeze([
        `origin verification for promotion: ${input.promotionOperationId}`,
        `node: ${verification.node.nodeId}`,
        `target source: ${promotion.originSourceSnapshotSha256}`,
        ...prepared.review.lifecycleScripts.map((script) => `${script.name}: ${script.body}`),
      ]),
      riskWarning: prepared.review.warning,
    }, input.signal);
    if (decision !== "approved") {
      throw new WorktreeError("worktree_approval_denied", decision === "cancelled" ? "origin verification was cancelled" : "origin verification was denied");
    }
    if (await prepared.revalidate() !== "current") {
      throw new WorktreeError("worktree_promotion_stale", "origin verification action changed after approval");
    }
    const fresh = await (await RepositorySourceSnapshotter.create(this.options.context.workspace, {
      environment: this.options.environment,
    })).snapshot(input.signal);
    if (fresh.snapshot.sourceStateSha256 !== promotion.originSourceSnapshotSha256) {
      throw new WorktreeError("worktree_promotion_stale", "origin changed after verification approval");
    }

    const graphFields = {
      graph_id: promotion.bundle.graphId,
      graph_revision: promotion.bundle.graphRevision,
      graph_sha256: promotion.bundle.graphSha256,
    } as const;
    const common = {
      ...graphFields,
      action_sha256: prepared.actionSha256,
      approval_request_id: approvalRequestId,
      bundle_sha256: promotion.bundle.bundleSha256,
      command_sha256: commandSha256,
      origin_source_snapshot_sha256: promotion.originSourceSnapshotSha256,
      promotion_operation_id: input.promotionOperationId,
      verification_id: verificationId,
      verification_node_id: verification.node.nodeId,
      workspace_id: promotion.bundle.workspaceId,
    } as const;
    writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_origin_verification.approved", {
        ...common,
        approval_identity_sha256: approvalIdentitySha256,
      });
      await writer.appendTaskGraphEvent("task_origin_verification.requested", common);
    } finally {
      await writer.close();
    }

    let result = staleResult();
    if (await prepared.revalidate() === "current") {
      for await (const signal of this.options.createExecutor().execute(prepared, input.signal)) {
        if (signal.type === "completed") result = signal.result;
      }
    }
    const after = await (await RepositorySourceSnapshotter.create(this.options.context.workspace, {
      environment: this.options.environment,
    })).snapshot(new AbortController().signal);
    const sourceExact = before.snapshot.sourceStateSha256 === promotion.originSourceSnapshotSha256 &&
      after.snapshot.sourceStateSha256 === promotion.originSourceSnapshotSha256;
    const status: OriginVerificationReceiptV1["status"] = !result.cleanupVerified || !sourceExact
      ? "reconciliation_required"
      : result.termination === "cancelled"
        ? "cancelled"
        : result.termination === "exit" && result.exitCode === 0
          ? "passed"
          : "failed";
    const persisted = await persistOriginVerificationReceipt({
      actionSha256: prepared.actionSha256,
      afterSourceStateSha256: after.snapshot.sourceStateSha256,
      beforeSourceStateSha256: before.snapshot.sourceStateSha256,
      bundleSha256: promotion.bundle.bundleSha256,
      commandSha256,
      context: this.options.context,
      graph: {
        graphId: promotion.bundle.graphId,
        graphRevision: promotion.bundle.graphRevision,
        graphSha256: promotion.bundle.graphSha256,
      },
      originSourceSnapshotSha256: promotion.originSourceSnapshotSha256,
      promotionOperationId: input.promotionOperationId,
      result,
      status,
      verificationId,
      verificationNodeId: verification.node.nodeId,
      workspaceId: promotion.bundle.workspaceId,
    });
    writer = await this.writerFactory(this.options.context);
    let completedEventId: string;
    try {
      const completed = await writer.appendTaskGraphEvent("task_origin_verification.completed", {
        ...graphFields,
        action_sha256: prepared.actionSha256,
        after_source_state_sha256: after.snapshot.sourceStateSha256,
        before_source_state_sha256: before.snapshot.sourceStateSha256,
        bundle_sha256: promotion.bundle.bundleSha256,
        cleanup_verified: result.cleanupVerified,
        command_sha256: commandSha256,
        exit_code: result.exitCode,
        origin_source_snapshot_sha256: promotion.originSourceSnapshotSha256,
        promotion_operation_id: input.promotionOperationId,
        receipt_artifact_id: persisted.artifactId,
        receipt_sha256: persisted.receipt.receiptSha256,
        status,
        termination: result.termination,
        verification_id: verificationId,
        verification_node_id: verification.node.nodeId,
        workspace_id: promotion.bundle.workspaceId,
      });
      completedEventId = completed.eventId;
    } finally {
      await writer.close();
    }
    return Object.freeze({
      actionSha256: prepared.actionSha256,
      commandSha256,
      completedEventId,
      receiptArtifactId: persisted.artifactId,
      receiptSha256: persisted.receipt.receiptSha256,
      status,
      verificationId,
      verificationNodeId: verification.node.nodeId,
    });
  }
}
