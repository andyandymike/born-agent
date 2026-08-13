import { z } from "zod";

import { backgroundExecutableDescriptorSchema } from "./background-schema.js";
import { persistedUserActionOriginV2Schema } from "../control-plane/application-protocol.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const graph = { graph_id: uuid, graph_revision: positive, graph_sha256: sha256 } as const;

function legacyOrAuthenticatedUserEvent<T extends z.ZodRawShape>(fields: T) {
  return z.union([
    z.object(fields).strict(),
    z.object({ ...fields, origin: persistedUserActionOriginV2Schema }).strict(),
  ]);
}

export const phase19BackgroundSessionEventDataSchemas = {
  "task_worker.spawn.requested": legacyOrAuthenticatedUserEvent({
    ...graph,
    descriptor: backgroundExecutableDescriptorSchema,
    descriptor_sha256: sha256,
    operation_id: uuid,
    repository_id: sha256,
    worker_id: uuid,
    worker_nonce_sha256: sha256,
  }),
  "task_worker.started": z.object({
    ...graph,
    descriptor_sha256: sha256,
    handoff_sha256: sha256,
    operation_id: uuid,
    scheduler_lease_sha256: sha256,
    worker_id: uuid,
    worker_nonce_sha256: sha256,
  }).strict(),
  "task_worker.control.accepted": z.object({
    ...graph,
    control_sha256: sha256,
    operation_id: uuid,
    request_id: uuid,
    worker_id: uuid,
  }).strict(),
  "task_worker.terminal": z.object({
    ...graph,
    graph_status: z.enum(["completed", "waiting_for_user", "blocked", "cancelled", "failed", "stale", "awaiting_integration"]),
    operation_id: uuid,
    process_tree_cleanup: z.enum(["complete", "failed"]),
    receipt_ref: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\\")),
    receipt_sha256: sha256,
    worker_id: uuid,
  }).strict(),
  "task_worker.reconciled": z.object({
    ...graph,
    evidence_sha256: sha256,
    observation: z.enum(["not_started", "owner_dead_clean", "terminal_exact", "unknown"]),
    operation_id: uuid,
    worker_id: uuid,
  }).strict(),
} as const;
