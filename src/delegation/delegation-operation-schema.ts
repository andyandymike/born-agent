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
    "running",
    "terminal_observed",
    "reconciled",
    "blocked",
  ]),
  process: z.object({
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).max(512),
  }).strict().nullable(),
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
