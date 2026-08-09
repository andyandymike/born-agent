import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedPath = z.string().min(1).max(4096).refine((value) => !value.includes("\0"));

export const backgroundExecutableDescriptorSchema = z.object({
  cliEntryPathSha256: sha256,
  cliEntrySha256: sha256,
  nodeExecutablePathSha256: sha256,
  nodeExecutableSha256: sha256,
  nodeVersion: z.string().min(1).max(128),
  packageName: z.literal("bornagent"),
  packageRootInventorySha256: sha256,
  packageVersion: z.string().min(1).max(128),
  schemaVersion: z.literal(1),
  workerProtocolVersion: z.literal(1),
}).strict();

export const graphWorkerBootstrapSchema = z.object({
  executableDescriptorSha256: sha256,
  graphRevision: positive,
  graphSha256: sha256,
  launchDeadline: z.string().datetime({ offset: true }),
  operationId: uuid,
  parentPid: positive,
  parentProcessStartIdentity: z.string().min(1).max(256),
  protocolVersion: z.literal(1),
  rawNonce: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  sessionId: uuid,
  workerId: uuid,
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024, "bootstrap exceeds 16 KiB");

export const graphWorkerReadySchema = z.object({
  operationId: uuid,
  protocolVersion: z.literal(1),
  schedulerLeaseSha256: sha256,
  startedEventId: uuid,
  startedSessionSeq: positive,
  workerId: uuid,
  workerNonceSha256: sha256,
  workerPid: positive,
  workerProcessStartIdentity: z.string().min(1).max(256),
}).strict();

export const graphWorkerParentAckSchema = z.object({
  accepted: z.literal(true),
  operationId: uuid,
  protocolVersion: z.literal(1),
  startedEventId: uuid,
  workerId: uuid,
}).strict();

export const graphWorkerHeartbeatSchema = z.object({
  activeAttemptId: uuid.nullable(),
  graphSha256: sha256,
  lastDurableSessionSeq: positive,
  observedAt: z.string().datetime({ offset: true }),
  operationId: uuid,
  schemaVersion: z.literal(1),
  sequence: positive,
  workerId: uuid,
  workerNonceSha256: sha256,
  workerPid: positive,
  workerProcessStartIdentity: z.string().min(1).max(256),
}).strict();

export const graphWorkerCancelControlSchema = z.object({
  graphId: uuid,
  graphRevision: positive,
  graphSha256: sha256,
  operationId: uuid,
  reason: z.string().min(1).max(2048).refine((value) => !value.includes("\0")),
  requestId: uuid,
  requestedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.literal(1),
  workerId: uuid,
  workerNonceSha256: sha256,
}).strict();

export const backgroundLaunchRecordSchema = z.object({
  cliEntryPath: boundedPath,
  descriptor: backgroundExecutableDescriptorSchema,
  descriptorSha256: sha256,
  graphId: uuid,
  graphRevision: positive,
  graphSha256: sha256,
  launchDeadline: z.string().datetime({ offset: true }),
  nodeExecutablePath: boundedPath,
  operationId: uuid,
  originRoot: boundedPath,
  parentPid: positive,
  parentProcessStartIdentity: z.string().min(1).max(256),
  repositoryId: sha256,
  runtimeProfileId: z.string().min(1).max(128),
  schemaVersion: z.literal(1),
  sessionId: uuid,
  workerId: uuid,
  workerNonceSha256: sha256,
}).strict().superRefine((value, context) => {
  if (sha256Canonical(value.descriptor) !== value.descriptorSha256) context.addIssue({ code: "custom", message: "descriptor hash is inconsistent" });
});

export const backgroundHandoffRecordSchema = z.object({
  graphSha256: sha256,
  operationId: uuid,
  ownerProcessStartIdentity: z.string().min(1).max(256),
  ownerPid: positive,
  owner: z.enum(["parent", "worker"]),
  parentNonceSha256: sha256,
  schemaVersion: z.literal(1),
  state: z.enum(["launching", "worker_owned", "terminal", "reconciliation_required"]),
  updatedAt: z.string().datetime({ offset: true }),
  workerId: uuid,
  workerNonceSha256: sha256,
}).strict();

export const backgroundTerminalReceiptSchema = z.object({
  activeAttemptId: z.null(),
  graphStatus: z.enum(["completed", "waiting_for_user", "blocked", "cancelled", "failed", "stale", "awaiting_integration"]),
  lastSessionSeq: positive,
  operationId: uuid,
  processTreeCleanup: z.enum(["complete", "failed"]),
  schemaVersion: z.literal(1),
  workerId: uuid,
}).strict();

export type BackgroundExecutableDescriptorV1 = Readonly<z.infer<typeof backgroundExecutableDescriptorSchema>>;
export type GraphWorkerBootstrapV1 = Readonly<z.infer<typeof graphWorkerBootstrapSchema>>;
export type GraphWorkerReadyV1 = Readonly<z.infer<typeof graphWorkerReadySchema>>;
export type GraphWorkerParentAckV1 = Readonly<z.infer<typeof graphWorkerParentAckSchema>>;
export type GraphWorkerHeartbeatV1 = Readonly<z.infer<typeof graphWorkerHeartbeatSchema>>;
export type GraphWorkerCancelControlV1 = Readonly<z.infer<typeof graphWorkerCancelControlSchema>>;
export type BackgroundLaunchRecordV1 = Readonly<z.infer<typeof backgroundLaunchRecordSchema>>;
export type BackgroundHandoffRecordV1 = Readonly<z.infer<typeof backgroundHandoffRecordSchema>>;
export type BackgroundTerminalReceiptV1 = Readonly<z.infer<typeof backgroundTerminalReceiptSchema>>;
