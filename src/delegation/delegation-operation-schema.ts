import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"));

export const delegationChildOperationContentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  operationId: uuid,
  sessionId: uuid,
  delegationId: uuid,
  childActorId: uuid,
  childAttemptId: uuid,
  childRunId: uuid,
  parentRunId: uuid,
  envelopePath: z.string().min(1).max(4096),
  envelopeArtifactSha256: sha256,
  envelopeSha256: sha256,
  capsulePath: z.string().min(1).max(4096),
  capsuleArtifactSha256: sha256,
  capsuleSha256: sha256,
  sessionWorkspacePath: z.string().min(1).max(4096),
  executionWorkspacePath: z.string().min(1).max(4096),
  executableDescriptorSha256: sha256,
  nonceSha256: sha256,
  startBarrierNonceSha256: sha256,
  requestedAt: timestamp,
  updatedAt: timestamp,
  state: z.enum([
    "requested",
    "spawned",
    "handshaken",
    "pre_effect_terminal",
    "running",
    "terminal_observed",
    "reconciled",
    "blocked",
  ]),
  process: z.object({
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).max(512),
  }).strict().nullable(),
  processCleanup: z.object({
    completedAt: timestamp,
    detail: z.enum(["clean", "force_failed", "graceful_failed", "identity_missing"]),
    forced: z.boolean(),
    pid: z.number().int().positive(),
    verified: z.boolean(),
  }).strict().nullable().optional(),
  failure: z.object({
    cancelRequestEventId: uuid.optional(),
    cancelRequestId: uuid.optional(),
    code: z.string().regex(/^[a-z0-9_]{1,128}$/u),
    phase: z.enum(["before_spawn", "before_handshake", "before_start_barrier", "after_start_barrier"]),
  }).strict().superRefine((value, context) => {
    const cancellationIdentity = [value.cancelRequestEventId, value.cancelRequestId];
    if (cancellationIdentity.some((item) => item !== undefined) &&
        !cancellationIdentity.every((item) => item !== undefined)) {
      context.addIssue({ code: "custom", message: "cancellation request identity must be complete" });
    }
    if (value.code === "delegation_cancelled" &&
        !cancellationIdentity.every((item) => item !== undefined)) {
      context.addIssue({ code: "custom", message: "delegation cancellation requires its exact durable request" });
    }
    if (value.code !== "delegation_cancelled" &&
        cancellationIdentity.some((item) => item !== undefined)) {
      context.addIssue({ code: "custom", message: "non-cancellation failure cannot carry cancellation authority" });
    }
  }).nullable().optional(),
  boundedResultRef: z.string().min(1).max(1024).nullable(),
  boundedResultSha256: sha256.nullable(),
}).strict().superRefine((value, context) => {
  const result = [value.boundedResultRef, value.boundedResultSha256];
  if (!(result.every((item) => item === null) || result.every((item) => item !== null))) {
    context.addIssue({ code: "custom", message: "bounded result identity must be complete or null" });
  }
  if (value.state === "requested" && value.process !== null) {
    context.addIssue({ code: "custom", message: "requested operation cannot already own a process" });
  }
  if (value.state === "pre_effect_terminal") {
    if (value.failure === undefined || value.failure === null || value.failure.phase === "after_start_barrier") {
      context.addIssue({ code: "custom", message: "pre-effect terminal requires a bounded pre-barrier failure" });
    }
    if (
      value.process !== null &&
      (value.processCleanup === undefined || value.processCleanup === null ||
        !value.processCleanup.verified || value.processCleanup.pid !== value.process.pid)
    ) {
      context.addIssue({ code: "custom", message: "pre-effect process must have exact verified tree cleanup" });
    }
  }
});

export const delegationChildOperationSchema = delegationChildOperationContentSchema.extend({
  operationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { operationSha256, ...content } = value;
  if (sha256Canonical(content) !== operationSha256) {
    context.addIssue({ code: "custom", message: "operation journal hash mismatch" });
  }
});

export type DelegationChildOperationV1 = Readonly<z.infer<typeof delegationChildOperationSchema>>;

export function createDelegationChildOperation(content: unknown): DelegationChildOperationV1 {
  const parsed = delegationChildOperationContentSchema.parse(content);
  return Object.freeze(delegationChildOperationSchema.parse({
    ...parsed,
    operationSha256: sha256Canonical(parsed),
  }));
}
