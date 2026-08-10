import { z } from "zod";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const delegatedChildRunBindingSchema = z.object({
  actor_id: uuid,
  delegation_id: uuid,
  delegation_revision: z.number().int().positive(),
  delegation_sha256: sha256,
  child_attempt_id: uuid,
  child_attempt_number: z.number().int().min(1).max(2),
  parent_actor_id: uuid,
  parent_run_id: uuid,
  envelope_sha256: sha256,
  operation_nonce_sha256: sha256,
}).strict();

export type DelegatedChildRunBindingV1 = Readonly<z.infer<typeof delegatedChildRunBindingSchema>>;

export const PHASE20_RUN_BINDING_KEY = "delegated_child_binding" as const;

export function stripPhase20RunBinding(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...data };
  delete result.delegated_child_binding;
  return result;
}
