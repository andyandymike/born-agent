import { z } from "zod";

import { MAX_ARTIFACT_CAPTURE_BYTES } from "./artifact-types.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const uuidSchema = z.string().uuid();
const captureStatusSchema = z.enum([
  "complete",
  "truncated_artifact_limit",
  "truncated_run_budget",
  "truncated_session_budget",
]);

export const artifactStoredEventDataSchema = z
  .object({
    artifact_id: artifactIdSchema,
    bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_CAPTURE_BYTES),
    capture_status: captureStatusSchema,
    capture_truncated: z.boolean(),
    media_type: z.enum([
      "text/markdown; charset=utf-8",
      "text/plain; charset=utf-8",
    ]),
    object_ref: z
      .string()
      .regex(
        /^artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/objects\/[a-f0-9]{64}$/u,
      ),
    origin_event_id: uuidSchema,
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const artifactSha256 = value.artifact_id.slice("sha256:".length);
    if (
      artifactSha256 !== value.sha256 ||
      !value.object_ref.endsWith(`/objects/${value.sha256}`)
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact event identity fields do not match",
      });
    }
    if (
      (value.capture_status === "complete") === value.capture_truncated
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact capture status does not match truncation flag",
      });
    }
  });

export const artifactCaptureTruncatedEventDataSchema = z
  .object({
    artifact_id: artifactIdSchema.optional(),
    captured_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ARTIFACT_CAPTURE_BYTES),
    limit_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ARTIFACT_CAPTURE_BYTES),
    reason: z.enum(["artifact_limit", "run_budget", "session_budget"]),
  })
  .strict()
  .refine((value) => value.captured_bytes <= value.limit_bytes, {
    message: "captured artifact bytes exceed the reported limit",
  });

export const phase10ArtifactRunEventDataSchemas = {
  "artifact.capture.truncated": artifactCaptureTruncatedEventDataSchema,
  "artifact.stored": artifactStoredEventDataSchema,
} as const;

export type Phase10ArtifactRunEventType =
  keyof typeof phase10ArtifactRunEventDataSchemas;
export type Phase10ArtifactRunEventData<
  TType extends Phase10ArtifactRunEventType,
> = z.infer<(typeof phase10ArtifactRunEventDataSchemas)[TType]>;

// PHASE10: This deliberately remains an independent fragment until the v2
// event decoder registry owns its integration; it still gives producers and
// replay tests one strict runtime schema instead of TypeScript-only evidence.
export const phase10ArtifactEventSchema = z.union([
  z
    .object({
      data: artifactStoredEventDataSchema,
      type: z.literal("artifact.stored"),
    })
    .strict(),
  z
    .object({
      data: artifactCaptureTruncatedEventDataSchema,
      type: z.literal("artifact.capture.truncated"),
    })
    .strict(),
]);

export type ParsedPhase10ArtifactEvent = z.infer<
  typeof phase10ArtifactEventSchema
>;
