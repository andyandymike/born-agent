import { z } from "zod";

import { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext } from "../coordination/task-control-plane.js";
import type { ExecutionResult } from "../execution/execution-types.js";
import type { Phase19TaskGraphSessionEventData } from "../task-graph/task-graph-event-schema.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const originVerificationReceiptWithoutHashSchema = z.object({
  actionSha256: sha256,
  afterSourceStateSha256: sha256,
  beforeSourceStateSha256: sha256,
  bundleSha256: sha256,
  cleanupVerified: z.boolean(),
  commandSha256: sha256,
  durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exitCode: z.number().int().nullable(),
  graphId: z.string().uuid(),
  graphRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  graphSha256: sha256,
  originSourceSnapshotSha256: sha256,
  promotionOperationId: z.string().uuid(),
  schemaVersion: z.literal(1),
  status: z.enum(["cancelled", "failed", "passed", "reconciliation_required"]),
  stderrBytes: bytes,
  stdoutBytes: bytes,
  termination: z.enum([
    "cancelled",
    "cleanup_failed",
    "exit",
    "output_limit_exceeded",
    "signal",
    "spawn_error",
    "stale",
    "timeout",
  ]),
  verificationId: z.string().uuid(),
  verificationNodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  workspaceId: z.string().uuid(),
}).strict();

export const originVerificationReceiptSchema = originVerificationReceiptWithoutHashSchema
  .extend({ receiptSha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256: _receiptSha256, ...withoutHash } = value;
    void _receiptSha256;
    if (sha256Canonical(withoutHash) !== value.receiptSha256) {
      context.addIssue({ code: "custom", message: "origin verification receipt hash is inconsistent" });
    }
  });

export type OriginVerificationReceiptV1 = Readonly<z.infer<typeof originVerificationReceiptSchema>>;

export function originVerificationReceiptMatchesCompletedEvent(
  receipt: OriginVerificationReceiptV1,
  event: Phase19TaskGraphSessionEventData<"task_origin_verification.completed">,
): boolean {
  return receipt.actionSha256 === event.action_sha256 &&
    receipt.afterSourceStateSha256 === event.after_source_state_sha256 &&
    receipt.beforeSourceStateSha256 === event.before_source_state_sha256 &&
    receipt.bundleSha256 === event.bundle_sha256 &&
    receipt.cleanupVerified === event.cleanup_verified &&
    receipt.commandSha256 === event.command_sha256 &&
    receipt.exitCode === event.exit_code &&
    receipt.graphId === event.graph_id &&
    receipt.graphRevision === event.graph_revision &&
    receipt.graphSha256 === event.graph_sha256 &&
    receipt.originSourceSnapshotSha256 === event.origin_source_snapshot_sha256 &&
    receipt.promotionOperationId === event.promotion_operation_id &&
    receipt.receiptSha256 === event.receipt_sha256 &&
    receipt.status === event.status &&
    receipt.termination === event.termination &&
    receipt.verificationId === event.verification_id &&
    receipt.verificationNodeId === event.verification_node_id &&
    receipt.workspaceId === event.workspace_id;
}

export async function persistOriginVerificationReceipt(input: {
  readonly actionSha256: string;
  readonly afterSourceStateSha256: string;
  readonly beforeSourceStateSha256: string;
  readonly bundleSha256: string;
  readonly commandSha256: string;
  readonly context: TaskMutationContext;
  readonly graph: { readonly graphId: string; readonly graphRevision: number; readonly graphSha256: string };
  readonly originSourceSnapshotSha256: string;
  readonly promotionOperationId: string;
  readonly result: ExecutionResult;
  readonly status: OriginVerificationReceiptV1["status"];
  readonly verificationId: string;
  readonly verificationNodeId: string;
  readonly workspaceId: string;
}): Promise<{ readonly artifactBytes: number; readonly artifactId: string; readonly receipt: OriginVerificationReceiptV1 }> {
  const withoutHash = originVerificationReceiptWithoutHashSchema.parse({
    actionSha256: input.actionSha256,
    afterSourceStateSha256: input.afterSourceStateSha256,
    beforeSourceStateSha256: input.beforeSourceStateSha256,
    bundleSha256: input.bundleSha256,
    cleanupVerified: input.result.cleanupVerified,
    commandSha256: input.commandSha256,
    durationMs: input.result.durationMs,
    exitCode: input.result.exitCode,
    graphId: input.graph.graphId,
    graphRevision: input.graph.graphRevision,
    graphSha256: input.graph.graphSha256,
    originSourceSnapshotSha256: input.originSourceSnapshotSha256,
    promotionOperationId: input.promotionOperationId,
    schemaVersion: 1,
    status: input.status,
    stderrBytes: input.result.stderrBytes,
    stdoutBytes: input.result.stdoutBytes,
    termination: input.result.termination,
    verificationId: input.verificationId,
    verificationNodeId: input.verificationNodeId,
    workspaceId: input.workspaceId,
  });
  const receipt = originVerificationReceiptSchema.parse({
    ...withoutHash,
    receiptSha256: sha256Canonical(withoutHash),
  });
  const encoded = Buffer.from(canonicalJson(receipt), "utf8");
  const captured = await (await ArtifactStore.create({
    sessionId: input.context.sessionId,
    workspace: input.context.workspace,
  })).storeSanitizedText({
    chunks: [encoded],
    maximumBytes: 8 * 1024,
    runId: input.verificationId,
  });
  if (captured.captureStatus !== "complete" || captured.artifact === null || captured.artifact.bytes !== encoded.byteLength) {
    throw new TaskGraphError("task_effect_reconciliation_required", "origin verification receipt could not be captured exactly");
  }
  return Object.freeze({
    artifactBytes: captured.artifact.bytes,
    artifactId: captured.artifact.artifactId,
    receipt: Object.freeze(receipt),
  });
}
