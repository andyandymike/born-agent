import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { sha256Schema } from "../../plans/plan-schema.js";
import { preparedChildEnvelopeSchema } from "../context/child-envelope-schema.js";

const uuid = z.string().uuid();

export const executableChildEnvelopeContentSchema = z.object({
  schemaVersion: z.literal(1),
  prepared: preparedChildEnvelopeSchema,
  execution: z.object({
    executable: z.literal(true),
    operationId: uuid,
    sessionId: uuid,
    reservationId: uuid,
    sessionLockNonceSha256: sha256Schema,
    schedulerLeaseNonceSha256: sha256Schema,
    executableDescriptorSha256: sha256Schema,
    startBarrierNonceSha256: sha256Schema,
  }).strict(),
}).strict();

export const executableChildEnvelopeSchema = executableChildEnvelopeContentSchema.extend({
  envelopeSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { envelopeSha256, ...content } = value;
  if (sha256Canonical(content) !== envelopeSha256) {
    context.addIssue({ code: "custom", message: "executable child envelope hash mismatch" });
  }
});

export type ExecutableChildEnvelopeV1 = Readonly<z.infer<typeof executableChildEnvelopeSchema>>;

export function createExecutableChildEnvelope(content: unknown): ExecutableChildEnvelopeV1 {
  const parsed = executableChildEnvelopeContentSchema.parse(content);
  return Object.freeze(executableChildEnvelopeSchema.parse({
    ...parsed,
    envelopeSha256: sha256Canonical(parsed),
  }));
}
