import { z } from "zod";

/**
 * Process-local delivery of an already durable delegation.cancel fact.
 * This is not cancellation authority: only the active owner adapter can build
 * it after verifying the exact raw session event through its owned writer.
 */
export const durableDelegationCancelSignalV1Schema = z.object({
  cancelRequestId: z.string().uuid(),
  delegationId: z.string().uuid(),
  delegationRevision: z.number().int().positive(),
  delegationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.literal("durable_delegation_cancel"),
  parentActorId: z.string().uuid(),
  parentRunId: z.string().uuid(),
  reason: z.string().min(1),
  requestEventId: z.string().uuid(),
  requestOperationId: z.string().uuid(),
  schemaVersion: z.literal(1),
}).strict();

export type DurableDelegationCancelSignalV1 = z.infer<typeof durableDelegationCancelSignalV1Schema>;
