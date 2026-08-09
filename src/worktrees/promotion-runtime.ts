import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { AtomicPatchApplier } from "../changes/patch-applier.js";
import { TaskOrchestrationCompletionComposer } from "../coordination/task-orchestration-completion.js";
import { PatchPlanner } from "../changes/patch-planner.js";
import { PatchOperationError } from "../changes/patch-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { ManagedWorktreeManager } from "./managed-worktree-manager.js";
import { WorktreeError } from "./worktree-errors.js";
import { captureWorkspaceSnapshot, type CapturedWorkspaceFileV1 } from "./workspace-baseline.js";
import { promotionBundleSchema, type PromotionBundleV1, type WorkspaceBaselineManifestV1 } from "./worktree-schema.js";

const PROMOTION_PATCH_MAX_FILES = 8;
const PROMOTION_TARGET_MAX_BYTES = 1024 * 1024;

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactGraph(graph: TaskGraphRevisionProjectionV1) {
  return { graph_id: graph.graphId, graph_revision: graph.revision, graph_sha256: graph.graphSha256 } as const;
}

function decodePromotionText(file: CapturedWorkspaceFileV1): string {
  if (file.bytes.byteLength > PROMOTION_TARGET_MAX_BYTES || file.bytes.includes(0)) {
    throw new WorktreeError("worktree_promotion_unsupported", `promotion target is not bounded text: ${file.path}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (error) {
    throw new WorktreeError("worktree_promotion_unsupported", `promotion target is not UTF-8: ${file.path}`, { cause: error });
  }
  if (text.includes("\r")) {
    throw new WorktreeError("worktree_promotion_unsupported", `promotion target uses a newline form the current patch codec cannot prove exact: ${file.path}`);
  }
  return text;
}

interface DiffLine { readonly hasNewline: boolean; readonly text: string }

function splitLines(text: string): readonly DiffLine[] {
  if (text.length === 0) return [];
  const values = text.split("\n");
  const trailing = values.at(-1) === "";
  if (trailing) values.pop();
  return values.map((value, index) => Object.freeze({ hasNewline: trailing || index < values.length - 1, text: value }));
}

function renderSide(prefix: "-" | "+", lines: readonly DiffLine[]): readonly string[] {
  const output: string[] = [];
  for (const line of lines) {
    output.push(`${prefix}${line.text}`);
    if (!line.hasNewline) output.push("\\ No newline at end of file");
  }
  return output;
}

function fullFileDiff(path: string, before: string | null, after: string): string {
  const oldLines = splitLines(before ?? "");
  const newLines = splitLines(after);
  if (oldLines.length + newLines.length > 2_000) {
    throw new WorktreeError("worktree_promotion_unsupported", `promotion diff exceeds the existing atomic patch line bound: ${path}`);
  }
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `diff --git a/${path} b/${path}`,
    before === null ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${String(oldStart)},${String(oldLines.length)} +${String(newStart)},${String(newLines.length)} @@`,
    ...renderSide("-", oldLines),
    ...renderSide("+", newLines),
  ].join("\n");
}

function inDeclaredScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`));
}

export interface PromotionResultV1 {
  readonly bundle: PromotionBundleV1;
  readonly changedPaths: readonly string[];
  readonly operationId: string;
  readonly resultSnapshotSha256: string;
}

export class WorktreePromotionRuntime {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly manager: ManagedWorktreeManager;
    readonly prompt: ApprovalPrompt;
    readonly repositoryRulesSha256: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async promote(input: {
    readonly attemptId: string;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly nodeId: string;
    readonly signal: AbortSignal;
  }): Promise<PromotionResultV1> {
    let writer = await this.writerFactory(this.options.context);
    let graph: TaskGraphRevisionProjectionV1;
    let baseline: WorkspaceBaselineManifestV1;
    let acceptedSnapshotSha256: string;
    try {
      const session = reconstructMultiRunSession(writer.events);
      const found = session.taskGraph.revisions.find((candidate) => candidate.revision === input.graphRevision && candidate.graphSha256 === input.graphSha256);
      if (found === undefined || !["running", "waiting_for_user", "awaiting_integration"].includes(found.status)) {
        throw new WorktreeError("worktree_promotion_stale", "promotion Graph is not awaiting an exact integration");
      }
      graph = found;
      const node = graph.content.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      if (node === undefined || node.workspace.mode === "origin_read_only") {
        throw new WorktreeError("worktree_promotion_stale", "promotion node has no managed workspace lineage");
      }
      const accepted = [...writer.events].reverse().find((event) => event.scope === "session" && event.type === "task_worktree.snapshot.accepted" &&
        event.data.graph_id === graph.graphId && event.data.graph_revision === graph.revision && event.data.attempt_id === input.attemptId && event.data.node_id === input.nodeId);
      if (accepted === undefined || accepted.scope !== "session" || accepted.type !== "task_worktree.snapshot.accepted") {
        throw new WorktreeError("worktree_promotion_stale", "attempt has no accepted managed-workspace snapshot");
      }
      acceptedSnapshotSha256 = accepted.data.snapshot_sha256;
      const seeded = [...writer.events].reverse().find((event) => event.scope === "session" && event.type === "task_worktree.baseline.seeded" && event.data.workspace_id === accepted.data.workspace_id);
      if (seeded === undefined || seeded.scope !== "session" || seeded.type !== "task_worktree.baseline.seeded") {
        throw new WorktreeError("worktree_operation_incomplete", "promotion workspace baseline is missing");
      }
      baseline = seeded.data.baseline;
    } finally {
      await writer.close();
    }
    const node = graph.content.nodes.find((candidate) => candidate.nodeId === input.nodeId)!;
    const workspace = await this.options.manager.locate({ graphId: graph.graphId, graphRevision: graph.revision, graphSha256: graph.graphSha256, nodeId: input.nodeId });
    const snapshot = await captureWorkspaceSnapshot({ baselineManifestSha256: baseline.manifestSha256, workspaceId: workspace.identity.workspaceId, workspaceRoot: workspace.workspacePath });
    if (snapshot.manifest.snapshotSha256 !== acceptedSnapshotSha256) {
      throw new WorktreeError("worktree_promotion_stale", "workspace changed after its attempt snapshot was accepted");
    }
    const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const after = new Map(snapshot.files.map((file) => [file.path, file]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
    const changed = paths.filter((path) => before.get(path)?.sha256 !== after.get(path)?.sha256);
    if (changed.length === 0) throw new WorktreeError("worktree_promotion_unsupported", "workspace has no promotable changes");
    if (changed.length > PROMOTION_PATCH_MAX_FILES) {
      throw new WorktreeError("worktree_promotion_unsupported", "promotion exceeds the existing atomic patch transaction file bound");
    }
    const patchParts: string[] = [];
    for (const path of changed) {
      if (!inDeclaredScope(path, node.workspace.declaredPathPrefixes)) {
        throw new WorktreeError("worktree_promotion_unsupported", `changed path is outside the Graph node scope: ${path}`);
      }
      const oldEntry = before.get(path);
      const newFile = after.get(path);
      if (newFile === undefined) {
        throw new WorktreeError("worktree_promotion_unsupported", `file deletion is not supported by the current atomic patch engine: ${path}`);
      }
      if (oldEntry !== undefined && oldEntry.mode !== newFile.mode) {
        throw new WorktreeError("worktree_promotion_unsupported", `file mode changes are not promotable: ${path}`);
      }
      const newText = decodePromotionText(newFile);
      let oldText: string | null = null;
      if (oldEntry !== undefined) {
        const baselineFile = await readFile(resolve(this.options.context.workspace, ...path.split("/")));
        if (hash(baselineFile) !== oldEntry.sha256) {
          throw new WorktreeError("worktree_promotion_stale", `origin preimage changed after workspace allocation: ${path}`);
        }
        oldText = decodePromotionText({ bytes: baselineFile, mode: oldEntry.mode, path, sha256: oldEntry.sha256 });
      }
      patchParts.push(fullFileDiff(path, oldText, newText));
    }
    let planner: PatchPlanner;
    let patchPlan;
    try {
      planner = await PatchPlanner.create(this.options.context.workspace);
      patchPlan = await planner.plan(`${patchParts.join("\n")}\n`);
    } catch (error) {
      if (error instanceof PatchOperationError) {
        throw new WorktreeError("worktree_promotion_unsupported", `promotion cannot be represented by the atomic patch engine: ${error.code}`, { cause: error });
      }
      throw error;
    }
    const entries = patchPlan.files.map((file) => {
      const workspaceFile = after.get(file.relativePath)!;
      const kind = before.has(file.relativePath) ? "modify" as const : "add" as const;
      return Object.freeze({
        bytes: workspaceFile.bytes.byteLength,
        kind,
        mode: workspaceFile.mode,
        path: file.relativePath,
        postSha256: file.postimageSha256,
        preSha256: kind === "add" ? null : file.preimageSha256,
      });
    });
    const targetSnapshotSha256 = sha256Canonical(entries.map((entry) => ({ path: entry.path, pre_sha256: entry.preSha256 })));
    const bundleContent = {
      attemptId: input.attemptId,
      baselineManifestSha256: baseline.manifestSha256,
      entries,
      graphId: graph.graphId,
      graphRevision: graph.revision,
      graphSha256: graph.graphSha256,
      nodeId: input.nodeId,
      schemaVersion: 1 as const,
      targetSnapshotSha256,
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      workspaceId: workspace.identity.workspaceId,
      workspaceSnapshotSha256: snapshot.manifest.snapshotSha256,
    };
    const bundle = promotionBundleSchema.parse({ ...bundleContent, bundleSha256: sha256Canonical(bundleContent) });
    const proposalId = this.options.context.randomUuid();
    writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_worktree.promotion.proposed", {
        ...exactGraph(graph), bundle, bundle_sha256: bundle.bundleSha256, proposal_id: proposalId,
      });
    } finally {
      await writer.close();
    }
    const approvalRequestId = this.options.context.randomUuid();
    const approvalIdentitySha256 = sha256Canonical({
      approval_request_id: approvalRequestId,
      bundle_sha256: bundle.bundleSha256,
      goal: graph.binding,
      ordered_preimages: entries.map((entry) => [entry.path, entry.preSha256]),
      repository_rules_sha256: this.options.repositoryRulesSha256,
      session_id: this.options.context.sessionId,
      target_snapshot_sha256: targetSnapshotSha256,
    });
    const decision = await this.options.prompt.request({
      actionKind: "task_worktree.promote",
      actionSha256: approvalIdentitySha256,
      bundleSha256: bundle.bundleSha256,
      changedBytes: bundle.totalBytes,
      graphId: graph.graphId,
      nodeId: input.nodeId,
      paths: entries.map((entry) => `${entry.kind} ${entry.path}`),
      targetSnapshotSha256,
      workspaceId: workspace.identity.workspaceId,
    }, input.signal);
    if (decision !== "approved") {
      throw new WorktreeError("worktree_approval_denied", decision === "cancelled" ? "promotion was cancelled" : "promotion was denied");
    }
    await planner.revalidate(patchPlan, input.signal);
    const freshWorkspace = await captureWorkspaceSnapshot({ baselineManifestSha256: baseline.manifestSha256, workspaceId: workspace.identity.workspaceId, workspaceRoot: workspace.workspacePath });
    if (freshWorkspace.manifest.snapshotSha256 !== bundle.workspaceSnapshotSha256) {
      throw new WorktreeError("worktree_promotion_stale", "workspace changed after promotion approval");
    }
    const operationId = this.options.context.randomUuid();
    writer = await this.writerFactory(this.options.context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      const current = session.taskGraph.revisions.find((candidate) => candidate.graphId === graph.graphId && candidate.revision === graph.revision && candidate.graphSha256 === graph.graphSha256);
      if (current === undefined || !["running", "waiting_for_user", "awaiting_integration"].includes(current.status)) {
        throw new WorktreeError("worktree_promotion_stale", "Graph authority changed after promotion approval");
      }
      await writer.appendTaskGraphEvent("task_worktree.promotion.approved", {
        ...exactGraph(graph), approval_identity_sha256: approvalIdentitySha256, approval_request_id: approvalRequestId,
        bundle_sha256: bundle.bundleSha256, target_snapshot_sha256: targetSnapshotSha256,
      });
      await writer.appendTaskGraphEvent("task_worktree.promotion.requested", {
        ...exactGraph(graph), approval_request_id: approvalRequestId, bundle_sha256: bundle.bundleSha256,
        operation_id: operationId, target_snapshot_sha256: targetSnapshotSha256,
      });
    } finally {
      await writer.close();
    }
    try {
      await new AtomicPatchApplier({ planner }).apply(patchPlan, input.signal);
    } catch (error) {
      if (error instanceof PatchOperationError) {
        throw new WorktreeError(error.state === "unknown" ? "worktree_operation_incomplete" : "worktree_promotion_stale", `promotion transaction failed: ${error.code}`, { cause: error });
      }
      throw error;
    }
    const resultSnapshotSha256 = sha256Canonical(entries.map((entry) => ({ path: entry.path, post_sha256: entry.postSha256 })));
    writer = await this.writerFactory(this.options.context);
    try {
      await writer.appendTaskGraphEvent("task_worktree.promotion.applied", {
        ...exactGraph(graph), bundle_sha256: bundle.bundleSha256, changed_paths: entries.map((entry) => entry.path),
        operation_id: operationId, result_snapshot_sha256: resultSnapshotSha256,
      });
      await new TaskOrchestrationCompletionComposer({ context: this.options.context, writer }).compose();
    } finally {
      await writer.close();
    }
    return Object.freeze({ bundle, changedPaths: Object.freeze(entries.map((entry) => entry.path)), operationId, resultSnapshotSha256 });
  }
}
