import { z } from "zod";

import { persistedApplicationCommitBindingV1Schema } from "../control-plane/application-protocol.js";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * PHASE21: a cancel request is a durable control fact, not a terminal claim.
 * The exact owner generation prevents a late request from cancelling a
 * replacement owner after a crash or takeover.
 */
export const runCancelRequestedDataV1Schema = z.object({
  application_commit: persistedApplicationCommitBindingV1Schema,
  reason: z.literal("user"),
  target_owner_generation_sha256: sha256Schema,
  target_run_id: uuidSchema,
}).strict();

export const applicationCancelRequestBindingV1Schema = z.object({
  request_event_id: uuidSchema,
  request_event_sha256: sha256Schema,
  target_owner_generation_sha256: sha256Schema,
}).strict();

export type RunCancelRequestedDataV1 = Readonly<
  z.infer<typeof runCancelRequestedDataV1Schema>
>;
export type ApplicationCancelRequestBindingV1 = Readonly<
  z.infer<typeof applicationCancelRequestBindingV1Schema>
>;

export const phase21RunControlEventDataSchemas = {
  "run.cancel.requested": runCancelRequestedDataV1Schema,
} as const;

export type Phase21RunControlEventType =
  keyof typeof phase21RunControlEventDataSchemas;
export type Phase21RunControlEventData<
  TType extends Phase21RunControlEventType,
> = z.infer<(typeof phase21RunControlEventDataSchemas)[TType]>;
