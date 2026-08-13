import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { taskUserOrigin, type TaskMutationContext, type TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskNodeSpecV1 } from "../task-graph/task-graph-schema.js";
import type { GitWorktreePort } from "./git-worktree-port.js";
import { ManagedWorktreePolicy } from "./managed-worktree-policy.js";
import { WorktreeError } from "./worktree-errors.js";
import { captureOriginBaseline, captureWorkspaceSnapshot, type WorkspaceSnapshotCaptureV1 } from "./workspace-baseline.js";
import { materializeWorkspaceBaseline } from "./workspace-materializer.js";
import { WorktreeOperationJournal, type WorktreeOperationRecordV1 } from "./worktree-operation-journal.js";
import { workspaceAllocationPlanSchema, type ManagedWorktreeIdentityV1, type WorkspaceAllocationPlanV1 } from "./worktree-schema.js";
import { createWorktreeArchive } from "./worktree-archive.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function exactGraph(graph: TaskGraphRevisionProjectionV1) {
  return { graph_id: graph.graphId, graph_revision: graph.revision, graph_sha256: graph.graphSha256 } as const;
}

function exactGraphRevision(session: ReturnType<typeof reconstructMultiRunSession>, input: {
  readonly revision: number;
  readonly sha256: string;
}): TaskGraphRevisionProjectionV1 {
  const graph = session.taskGraph.revisions.find((candidate) => candidate.revision === input.revision && candidate.graphSha256 === input.sha256);
  if (graph === undefined || !["approved", "queued", "running", "waiting_for_user", "awaiting_integration"].includes(graph.status)) {
    throw new WorktreeError("worktree_allocation_stale", "allocation Graph revision is not the current approved execution authority");
  }
  return graph;
}

function lineageRoot(graph: TaskGraphRevisionProjectionV1, node: TaskNodeSpecV1): string | null {
  if (node.workspace.mode === "origin_read_only") return null;
  if (node.workspace.mode === "managed_worktree") return node.nodeId;
  const predecessor = graph.content.nodes.find((candidate) => candidate.nodeId === node.dependsOn[0]);
  return predecessor === undefined ? null : lineageRoot(graph, predecessor);
}

function lineageNodeIds(graph: TaskGraphRevisionProjectionV1, sourceNodeId: string): readonly string[] {
  return Object.freeze(graph.content.nodes
    .filter((node) => lineageRoot(graph, node) === sourceNodeId)
    .sort((left, right) => left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId, "en"))
    .map((node) => node.nodeId));
}

function plannedIdentity(plan: WorkspaceAllocationPlanV1): string {
  return sha256Canonical(plan);
}

function operationRecord(input: {
  readonly context: TaskMutationContext;
  readonly nonce: string;
  readonly phase: WorktreeOperationRecordV1["phase"];
  readonly plan: WorkspaceAllocationPlanV1;
}): WorktreeOperationRecordV1 {
  return Object.freeze({
    allocationPlanSha256: plannedIdentity(input.plan),
    graphId: input.plan.graph.graphId,
    nonce: input.nonce,
    operationId: input.plan.operationId,
    phase: input.phase,
    repositoryId: input.plan.repository.repositoryId,
    schemaVersion: 1,
    updatedAt: input.context.now(),
    workspaceId: input.plan.workspaceId,
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface ManagedWorkspaceHandleV1 {
  readonly baselineManifestSha256: string;
  readonly identity: ManagedWorktreeIdentityV1;
  readonly nodeIds: readonly string[];
  readonly workspacePath: string;
}

export interface AcceptedWorkspaceSnapshotV1 {
  readonly changedBytes: number;
  readonly changedFiles: number;
  readonly snapshot: WorkspaceSnapshotCaptureV1;
}

export class ManagedWorktreeManager {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly git: GitWorktreePort;
    readonly managedRoot: string;
    readonly prompt: ApprovalPrompt;
    readonly repositoryRulesSha256: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async allocate(input: {
    readonly allowDirty: boolean;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly signal: AbortSignal;
    readonly sourceNodeId: string;
  }): Promise<ManagedWorkspaceHandleV1> {
    const policy = await ManagedWorktreePolicy.create(this.options.managedRoot);
    let writer = await this.writerFactory(this.options.context);
    let graph: TaskGraphRevisionProjectionV1;
    try {
      const session = reconstructMultiRunSession(writer.events);
      graph = exactGraphRevision(session, { revision: input.graphRevision, sha256: input.graphSha256 });
      const source = graph.content.nodes.find((node) => node.nodeId === input.sourceNodeId);
      if (source === undefined || source.workspace.mode !== "managed_worktree") {
        throw new WorktreeError("worktree_allocation_stale", "source node must create a managed worktree lineage");
      }
    } finally {
      await writer.close();
    }
    const baseline = await captureOriginBaseline({ allowDirty: input.allowDirty, git: this.options.git, originRoot: this.options.context.workspace });
    const workspaceId = this.options.context.randomUuid();
    const operationId = this.options.context.randomUuid();
    const nodeIds = lineageNodeIds(graph, input.sourceNodeId);
    const paths = await policy.paths({ graphId: graph.graphId, repositoryId: baseline.observation.identity.repositoryId, workspaceId });
    const plan = workspaceAllocationPlanSchema.parse({
      baseCommit: baseline.observation.identity.baseCommit,
      baselineManifestSha256: baseline.manifest.manifestSha256,
      dirtyOverlaySha256: baseline.overlay?.overlaySha256 ?? null,
      graph: { graphId: graph.graphId, graphRevision: graph.revision, graphSha256: graph.graphSha256 },
      managedRelativeRef: paths.managedRelativeRef,
      nodeIds,
      operationId,
      originStatusSha256: baseline.manifest.originStatusSha256,
      repository: baseline.observation.identity,
      repositoryRulesSha256: this.options.repositoryRulesSha256,
      requestedBytes: baseline.manifest.totalBytes,
      requestedFiles: baseline.manifest.entries.length,
      schemaVersion: 1,
      workspaceId,
    });
    const planSha256 = plannedIdentity(plan);
    writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_worktree.allocation.prepared", {
        ...exactGraph(graph), allocation_plan: plan, allocation_plan_sha256: planSha256,
        ...(this.options.context.authenticatedApplication === undefined
          ? {}
          : { origin: taskUserOrigin(this.options.context) }),
      });
    } finally {
      await writer.close();
    }
    const approvalRequestId = this.options.context.randomUuid();
    const approvalIdentitySha256 = sha256Canonical({
      allocation_plan_sha256: planSha256,
      approval_request_id: approvalRequestId,
      session_id: this.options.context.sessionId,
    });
    const decision = await this.options.prompt.request({
      actionKind: "task_worktree.allocate",
      actionSha256: approvalIdentitySha256,
      baseCommit: plan.baseCommit,
      dirtyEntries: baseline.overlay?.entries.map((entry) => `${entry.status} ${entry.path}`) ?? [],
      fileCount: plan.requestedFiles,
      graphId: graph.graphId,
      nodeIds,
      requestedBytes: plan.requestedBytes,
      workspaceId,
    }, input.signal);
    if (decision !== "approved") {
      throw new WorktreeError("worktree_approval_denied", decision === "cancelled" ? "worktree allocation was cancelled" : "worktree allocation was denied");
    }
    const fresh = await captureOriginBaseline({ allowDirty: input.allowDirty, git: this.options.git, originRoot: this.options.context.workspace });
    if (
      sha256Canonical(fresh.observation.identity) !== sha256Canonical(baseline.observation.identity) ||
      fresh.manifest.manifestSha256 !== baseline.manifest.manifestSha256 ||
      (fresh.overlay?.overlaySha256 ?? null) !== (baseline.overlay?.overlaySha256 ?? null)
    ) {
      throw new WorktreeError("worktree_allocation_stale", "origin baseline changed after allocation approval");
    }
    writer = await this.writerFactory(this.options.context);
    try {
      const current = exactGraphRevision(reconstructMultiRunSession(writer.events), { revision: graph.revision, sha256: graph.graphSha256 });
      if (current.graphId !== graph.graphId) throw new WorktreeError("worktree_allocation_stale", "Graph identity changed after approval");
      // Approval and baseline revalidation are observation-only until this
      // point. Once allocation.approved/create.requested is appended, callers
      // must reconcile the effect instead of treating cancellation as clean.
      if (input.signal.aborted) {
        throw new WorktreeError("worktree_approval_denied", "worktree allocation was cancelled before effect admission");
      }
      await writer.appendTaskGraphEvent("task_worktree.allocation.approved", {
        ...exactGraph(graph), allocation_plan_sha256: planSha256, approval_identity_sha256: approvalIdentitySha256,
        approval_request_id: approvalRequestId, workspace_id: workspaceId,
      });
      await writer.appendTaskGraphEvent("task_worktree.create.requested", {
        ...exactGraph(graph), allocation_plan_sha256: planSha256, operation_id: operationId, workspace_id: workspaceId,
      });
    } finally {
      await writer.close();
    }
    const nonce = this.options.context.randomUuid();
    const journal = new WorktreeOperationJournal(paths.operationDirectory);
    await journal.write(operationRecord({ context: this.options.context, nonce, phase: "requested", plan }));
    let gitAdded = false;
    try {
      try {
        await lstat(paths.worktreePath);
        throw new WorktreeError("worktree_path_unsafe", "managed worktree target already exists");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await this.options.git.addNoCheckout({ baseCommit: plan.baseCommit, originRoot: baseline.observation.originRoot, worktreePath: paths.worktreePath });
      gitAdded = true;
      await journal.write(operationRecord({ context: this.options.context, nonce, phase: "git_added", plan }));
      const listed = await this.options.git.list(baseline.observation.originRoot);
      const entry = listed.find((candidate) => resolve(candidate.path) === resolve(paths.worktreePath));
      if (entry === undefined || entry.bare || !entry.detached || entry.head !== plan.baseCommit) {
        throw new WorktreeError("worktree_operation_incomplete", "Git worktree postcondition does not match the approved allocation");
      }
      const dotGit = await lstat(resolve(paths.worktreePath, ".git"));
      if (!dotGit.isFile() || dotGit.isSymbolicLink() || dotGit.nlink !== 1) {
        throw new WorktreeError("worktree_operation_incomplete", "managed worktree Git indirection is unsafe");
      }
      const pointer = await readFile(resolve(paths.worktreePath, ".git"), "utf8");
      if (!/^gitdir: .+\r?\n?$/u.test(pointer) || pointer.includes("\0")) {
        throw new WorktreeError("worktree_operation_incomplete", "managed worktree Git indirection is malformed");
      }
      await this.options.git.lock(baseline.observation.originRoot, paths.worktreePath);
      await journal.write(operationRecord({ context: this.options.context, nonce, phase: "locked", plan }));
      await materializeWorkspaceBaseline({ baseline, workspaceId, workspaceRoot: paths.worktreePath });
      const identity: ManagedWorktreeIdentityV1 = Object.freeze({
        allocationPlanSha256: planSha256,
        baseCommit: plan.baseCommit,
        graphId: graph.graphId,
        managedPathSha256: policy.managedPathSha256(paths.worktreePath),
        managedRelativeRef: paths.managedRelativeRef,
        repositoryId: plan.repository.repositoryId,
        sourceNodeId: input.sourceNodeId,
        workspaceId,
      });
      writer = await this.writerFactory(this.options.context);
      try {
        await writer.appendTaskGraphEvent("task_worktree.created", { ...exactGraph(graph), identity, operation_id: operationId });
        await writer.appendTaskGraphEvent("task_worktree.baseline.seeded", { ...exactGraph(graph), baseline: baseline.manifest, workspace_id: workspaceId });
      } finally {
        await writer.close();
      }
      await journal.write(operationRecord({ context: this.options.context, nonce, phase: "seeded", plan }));
      return Object.freeze({ baselineManifestSha256: baseline.manifest.manifestSha256, identity, nodeIds, workspacePath: paths.worktreePath });
    } catch (error) {
      await journal.write(operationRecord({ context: this.options.context, nonce, phase: "failed", plan })).catch(() => undefined);
      const recoveryWriter = await this.writerFactory(this.options.context).catch(() => null);
      if (recoveryWriter !== null) {
        try {
          await recoveryWriter.appendTaskGraphEvent("task_worktree.reconciled", {
            ...exactGraph(graph), evidence_sha256: sha256Canonical({ git_added: gitAdded, operation_id: operationId, workspace_id: workspaceId }),
            observed: gitAdded ? "unknown" : "not_applied", operation_id: operationId, workspace_id: workspaceId,
          });
        } catch {
          // The durable request plus operation journal remain the recovery authority.
        } finally {
          await recoveryWriter.close();
        }
      }
      throw error;
    }
  }

  async locate(input: {
    readonly graphId: string;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly nodeId: string;
  }): Promise<ManagedWorkspaceHandleV1> {
    const writer = await this.writerFactory(this.options.context);
    try {
      const events = writer.events.filter((event) => event.scope === "session");
      const created = [...events].reverse().find((event) => event.type === "task_worktree.created" &&
        event.data.graph_id === input.graphId && event.data.graph_revision === input.graphRevision && event.data.graph_sha256 === input.graphSha256 &&
        event.data.identity.sourceNodeId === lineageRoot(exactGraphRevision(reconstructMultiRunSession(writer.events), { revision: input.graphRevision, sha256: input.graphSha256 }),
          exactGraphRevision(reconstructMultiRunSession(writer.events), { revision: input.graphRevision, sha256: input.graphSha256 }).content.nodes.find((node) => node.nodeId === input.nodeId)!));
      if (created === undefined || created.type !== "task_worktree.created") {
        throw new WorktreeError("worktree_allocation_stale", `node ${input.nodeId} has no approved managed workspace`);
      }
      const identity = created.data.identity;
      const prepared = [...events].reverse().find((event) => event.type === "task_worktree.allocation.prepared" &&
        event.data.allocation_plan_sha256 === identity.allocationPlanSha256);
      const seeded = [...events].reverse().find((event) => event.type === "task_worktree.baseline.seeded" && event.data.workspace_id === identity.workspaceId);
      if (prepared === undefined || prepared.type !== "task_worktree.allocation.prepared" || seeded === undefined || seeded.type !== "task_worktree.baseline.seeded") {
        throw new WorktreeError("worktree_operation_incomplete", "managed workspace has no complete baseline authority");
      }
      if (!prepared.data.allocation_plan.nodeIds.includes(input.nodeId)) {
        throw new WorktreeError("worktree_allocation_stale", "node is outside the allocated workspace lineage");
      }
      const policy = await ManagedWorktreePolicy.create(this.options.managedRoot);
      const paths = await policy.paths({ graphId: identity.graphId, repositoryId: identity.repositoryId, workspaceId: identity.workspaceId });
      if (policy.managedPathSha256(paths.worktreePath) !== identity.managedPathSha256) {
        throw new WorktreeError("worktree_identity_stale", "managed path identity no longer matches its event");
      }
      const listed = await this.options.git.list(this.options.context.workspace);
      const entry = listed.find((candidate) => resolve(candidate.path) === resolve(paths.worktreePath));
      // Git 2.30 accepts `worktree lock` but does not expose the lock marker in
      // `worktree list --porcelain`. The durable create operation/journal proves
      // the successful lock call; newer Git may additionally report `locked`.
      if (entry === undefined || !entry.detached || entry.head !== identity.baseCommit) {
        throw new WorktreeError("worktree_identity_stale", "managed Git worktree identity is stale");
      }
      return Object.freeze({ baselineManifestSha256: seeded.data.baseline.manifestSha256, identity, nodeIds: prepared.data.allocation_plan.nodeIds, workspacePath: paths.worktreePath });
    } finally {
      await writer.close();
    }
  }

  async acceptSnapshot(input: {
    readonly attemptId: string;
    readonly expectedSnapshotSha256?: string;
    readonly graph: TaskGraphRevisionProjectionV1;
    readonly nodeId: string;
  }): Promise<AcceptedWorkspaceSnapshotV1> {
    const workspace = await this.locate({ graphId: input.graph.graphId, graphRevision: input.graph.revision, graphSha256: input.graph.graphSha256, nodeId: input.nodeId });
    const snapshot = await captureWorkspaceSnapshot({ baselineManifestSha256: workspace.baselineManifestSha256, workspaceId: workspace.identity.workspaceId, workspaceRoot: workspace.workspacePath });
    if (
      input.expectedSnapshotSha256 !== undefined &&
      snapshot.manifest.snapshotSha256 !== input.expectedSnapshotSha256
    ) {
      throw new WorktreeError(
        "worktree_promotion_stale",
        "managed workspace no longer matches the accepted delegated child receipt",
      );
    }
    const baseline = await this.#baselineEntries(workspace.identity.workspaceId);
    const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const after = new Map(snapshot.manifest.entries.map((entry) => [entry.path, entry]));
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changed = [...paths].filter((path) => before.get(path)?.sha256 !== after.get(path)?.sha256);
    const changedBytes = changed.reduce((sum, path) => sum + (after.get(path)?.bytes ?? 0), 0);
    const writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_worktree.snapshot.accepted", {
        ...exactGraph(input.graph), attempt_id: input.attemptId, changed_bytes: changedBytes, changed_files: changed.length,
        node_id: input.nodeId, snapshot_sha256: snapshot.manifest.snapshotSha256, workspace_id: workspace.identity.workspaceId,
      });
    } finally {
      await writer.close();
    }
    return Object.freeze({ changedBytes, changedFiles: changed.length, snapshot });
  }

  async #baselineEntries(workspaceId: string) {
    const writer = await this.writerFactory(this.options.context);
    try {
      const event = [...writer.events].reverse().find((candidate) => candidate.scope === "session" && candidate.type === "task_worktree.baseline.seeded" && candidate.data.workspace_id === workspaceId);
      if (event === undefined || event.scope !== "session" || event.type !== "task_worktree.baseline.seeded") {
        throw new WorktreeError("worktree_operation_incomplete", "workspace baseline event is missing");
      }
      return event.data.baseline;
    } finally {
      await writer.close();
    }
  }

  async cleanup(input: {
    readonly archiveAndRemove: boolean;
    readonly graphId: string;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly nodeId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly archiveSha256: string | null; readonly status: "archived" | "removed"; readonly workspaceId: string }> {
    if (input.signal.aborted) throw new WorktreeError("worktree_approval_denied", "worktree cleanup was cancelled");
    const workspace = await this.locate(input);
    const baseline = await this.#baselineEntries(workspace.identity.workspaceId);
    let snapshot = await captureWorkspaceSnapshot({
      baselineManifestSha256: baseline.manifestSha256,
      workspaceId: workspace.identity.workspaceId,
      workspaceRoot: workspace.workspacePath,
    });
    const clean = sha256Canonical(snapshot.manifest.entries) === sha256Canonical(baseline.entries);
    if (!clean && !input.archiveAndRemove) {
      throw new WorktreeError("worktree_promotion_unsupported", "dirty managed worktree is retained; use explicit archive-and-remove");
    }
    const policy = await ManagedWorktreePolicy.create(this.options.managedRoot);
    const paths = await policy.paths({ graphId: workspace.identity.graphId, repositoryId: workspace.identity.repositoryId, workspaceId: workspace.identity.workspaceId });
    let archiveSha256: string | null = null;
    if (input.archiveAndRemove) {
      const archive = await createWorktreeArchive({
        archiveId: this.options.context.randomUuid(),
        archiveRoot: paths.archiveDirectory,
        baselinePaths: baseline.entries.map((entry) => entry.path),
        graphId: input.graphId,
        snapshot,
        workspaceId: workspace.identity.workspaceId,
      });
      archiveSha256 = archive.archiveSha256;
      const approvalIdentitySha256 = sha256Canonical({
        archive_sha256: archive.archiveSha256,
        graph_id: input.graphId,
        session_id: this.options.context.sessionId,
        snapshot_sha256: snapshot.manifest.snapshotSha256,
        workspace_id: workspace.identity.workspaceId,
      });
      const decision = await this.options.prompt.request({
        actionKind: "task_worktree.cleanup",
        actionSha256: approvalIdentitySha256,
        archiveSha256: archive.archiveSha256,
        bytes: archive.totalBytes,
        files: snapshot.files.length,
        graphId: input.graphId,
        workspaceId: workspace.identity.workspaceId,
      }, input.signal);
      if (decision !== "approved") {
        throw new WorktreeError("worktree_approval_denied", decision === "cancelled" ? "worktree cleanup was cancelled" : "worktree cleanup was denied");
      }
      const current = await captureWorkspaceSnapshot({
        baselineManifestSha256: baseline.manifestSha256,
        workspaceId: workspace.identity.workspaceId,
        workspaceRoot: workspace.workspacePath,
      });
      if (current.manifest.snapshotSha256 !== snapshot.manifest.snapshotSha256) {
        throw new WorktreeError("worktree_identity_stale", "managed worktree changed after archive approval");
      }
      snapshot = current;
    }
    const graph = (() => {
      const writerPromise = this.writerFactory(this.options.context);
      return writerPromise.then(async (writer) => {
        try {
          return exactGraphRevision(reconstructMultiRunSession(writer.events), { revision: input.graphRevision, sha256: input.graphSha256 });
        } finally {
          await writer.close();
        }
      });
    })();
    const exact = await graph;
    if (exact.graphId !== input.graphId) throw new WorktreeError("worktree_identity_stale", "cleanup Graph identity is stale");
    const operationId = this.options.context.randomUuid();
    let writer = await this.writerFactory(this.options.context);
    try {
      const currentGraph = exactGraphRevision(reconstructMultiRunSession(writer.events), {
        revision: exact.revision,
        sha256: exact.graphSha256,
      });
      if (currentGraph.graphId !== exact.graphId) {
        throw new WorktreeError("worktree_identity_stale", "cleanup Graph identity changed before effect admission");
      }
      if (input.signal.aborted) {
        throw new WorktreeError("worktree_approval_denied", "worktree cleanup was cancelled before effect admission");
      }
      await writer.appendTaskGraphEvent("task_worktree.cleanup.requested", {
        ...exactGraph(exact),
        archive_sha256: archiveSha256,
        force: input.archiveAndRemove,
        operation_id: operationId,
        ...(this.options.context.authenticatedApplication === undefined
          ? {}
          : { origin: taskUserOrigin(this.options.context) }),
        workspace_id: workspace.identity.workspaceId,
        workspace_snapshot_sha256: snapshot.manifest.snapshotSha256,
      });
    } finally {
      await writer.close();
    }
    await this.options.git.unlock(this.options.context.workspace, workspace.workspacePath);
    await this.options.git.remove(this.options.context.workspace, workspace.workspacePath, input.archiveAndRemove);
    const remains = (await this.options.git.list(this.options.context.workspace)).some((entry) => resolve(entry.path) === resolve(workspace.workspacePath));
    if (remains) throw new WorktreeError("worktree_operation_incomplete", "Git still reports the removed managed worktree");
    writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_worktree.cleanup.completed", {
        ...exactGraph(exact), operation_id: operationId,
        status: input.archiveAndRemove ? "archived" : "removed",
        workspace_id: workspace.identity.workspaceId,
      });
    } finally {
      await writer.close();
    }
    return Object.freeze({ archiveSha256, status: input.archiveAndRemove ? "archived" : "removed", workspaceId: workspace.identity.workspaceId });
  }
}
