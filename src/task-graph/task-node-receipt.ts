import { z } from "zod";

import { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext } from "../coordination/task-control-plane.js";
import type { TaskAttemptExecutionResultV1 } from "../scheduling/deterministic-task-scheduler.js";
import type { TaskGraphRevisionProjectionV1 } from "./task-graph-projector.js";
import type { TaskNodeSpecV1 } from "./task-graph-schema.js";
import { TaskGraphError } from "./task-graph-errors.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const taskNodeReceiptWithoutHashSchema = z.object({
  attemptId: z.string().uuid(),
  graphId: z.string().uuid(),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  schemaVersion: z.literal(1),
  status: z.enum(["blocked", "cancelled", "failed", "succeeded"]),
  structuredEvidence: z.array(z.object({
    artifactRef: z.string().min(1).max(1024),
    kind: z.string().min(1).max(128),
    sha256,
  }).strict()).max(32),
  summary: z.string().min(1).max(4096),
  verificationGenerationId: z.string().uuid().nullable(),
  workspaceSnapshotSha256: sha256.nullable(),
}).strict();

export const taskNodeReceiptSchema = taskNodeReceiptWithoutHashSchema.extend({ receiptSha256: sha256 }).strict()
  .superRefine((value, context) => {
    const { receiptSha256: _receiptSha256, ...withoutHash } = value;
    void _receiptSha256;
    if (sha256Canonical(withoutHash) !== value.receiptSha256) context.addIssue({ code: "custom", message: "node receipt hash is inconsistent" });
  });

export type TaskNodeReceiptV1 = Readonly<z.infer<typeof taskNodeReceiptSchema>>;

function receiptStatus(terminal: TaskAttemptExecutionResultV1["terminal"]): TaskNodeReceiptV1["status"] {
  if (terminal === "succeeded") return "succeeded";
  if (terminal === "cancelled_clean") return "cancelled";
  if (terminal === "known_failed" || terminal === "pre_effect_infrastructure_failure") return "failed";
  return "blocked";
}

export async function persistTaskNodeReceipt(input: {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly context: TaskMutationContext;
  readonly graph: TaskGraphRevisionProjectionV1;
  readonly node: TaskNodeSpecV1;
  readonly result: TaskAttemptExecutionResultV1;
  readonly terminalOverride?: TaskAttemptExecutionResultV1["terminal"];
  readonly verificationGenerationId: string | null;
  readonly workspaceSnapshotSha256: string | null;
}): Promise<{ readonly artifactBytes: number; readonly artifactId: string; readonly receipt: TaskNodeReceiptV1 }> {
  const terminal = input.terminalOverride ?? input.result.terminal;
  const withoutHash = taskNodeReceiptWithoutHashSchema.parse({
    attemptId: input.attemptId,
    graphId: input.graph.graphId,
    nodeId: input.node.nodeId,
    schemaVersion: 1,
    status: receiptStatus(terminal),
    structuredEvidence: [],
    summary: `Node ${input.node.nodeId} attempt ${String(input.attemptNumber)} ended ${terminal}; model_steps=${String(input.result.budget.modelSteps)} command_executions=${String(input.result.budget.commandExecutions)} changed_files=${String(input.result.budget.changedFiles)}${input.result.diagnosticCode === undefined ? "" : ` diagnostic=${input.result.diagnosticCode.replace(/[^a-zA-Z0-9_.:-]/gu, "_").slice(0, 128)}`}.`,
    verificationGenerationId: input.verificationGenerationId,
    workspaceSnapshotSha256: input.workspaceSnapshotSha256,
  });
  const receipt = taskNodeReceiptSchema.parse({ ...withoutHash, receiptSha256: sha256Canonical(withoutHash) });
  const bytes = Buffer.from(canonicalJson(receipt), "utf8");
  const captured = await (await ArtifactStore.create({ sessionId: input.context.sessionId, workspace: input.context.workspace })).storeSanitizedText({
    chunks: [bytes],
    maximumBytes: 8 * 1024,
    runId: input.attemptId,
  });
  if (captured.captureStatus !== "complete" || captured.artifact === null || captured.artifact.bytes !== bytes.byteLength) {
    throw new TaskGraphError("task_effect_reconciliation_required", "task node receipt could not be captured exactly");
  }
  return Object.freeze({ artifactBytes: captured.artifact.bytes, artifactId: captured.artifact.artifactId, receipt: Object.freeze(receipt) });
}
