import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relativeObjectRefSchema = z
  .string()
  .regex(
    /^artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/objects\/[a-f0-9]{64}$/u,
  );

export const repositoryRulesLoadedDataSchema = z.discriminatedUnion("state", [
  z
    .object({
      artifact_id: artifactIdSchema,
      bytes: z.number().int().nonnegative().max(64 * 1024),
      content_sha256: sha256Schema,
      object_ref: relativeObjectRefSchema,
      relative_path: z.literal("AGENTS.md"),
      state: z.literal("loaded"),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.artifact_id !== `sha256:${value.content_sha256}` ||
        !value.object_ref.endsWith(`/objects/${value.content_sha256}`)
      ) {
        context.addIssue({
          code: "custom",
          message: "repository rules artifact identity does not match content",
        });
      }
    }),
  z
    .object({
      relative_path: z.literal("AGENTS.md"),
      state: z.literal("missing"),
    })
    .strict(),
]);

export const repositoryRulesChangedDataSchema = z
  .object({
    current_content_sha256: sha256Schema.nullable().optional(),
    current_error_code: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .optional(),
    current_state: z.enum(["invalid", "loaded", "missing"]),
    frozen_content_sha256: sha256Schema.nullable(),
    frozen_state: z.enum(["loaded", "missing"]),
    reason: z.enum(["content_changed", "created", "invalid", "removed"]),
    relative_path: z.literal("AGENTS.md"),
  })
  .strict()
  .superRefine((value, context) => {
    const currentHashMatches =
      value.current_state === "loaded"
        ? value.current_content_sha256 !== undefined &&
          value.current_content_sha256 !== null &&
          value.current_error_code === undefined
        : value.current_state === "missing"
          ? value.current_content_sha256 === null &&
            value.current_error_code === undefined
          : value.current_content_sha256 === undefined &&
            value.current_error_code !== undefined;
    const frozenHashMatches =
      value.frozen_state === "loaded"
        ? value.frozen_content_sha256 !== null
        : value.frozen_content_sha256 === null;
    const reasonMatches =
      (value.reason === "invalid" && value.current_state === "invalid") ||
      (value.reason === "created" &&
        value.frozen_state === "missing" &&
        value.current_state === "loaded") ||
      (value.reason === "removed" &&
        value.frozen_state === "loaded" &&
        value.current_state === "missing") ||
      (value.reason === "content_changed" &&
        value.frozen_state === "loaded" &&
        value.current_state === "loaded" &&
        value.current_content_sha256 !== value.frozen_content_sha256);
    if (!currentHashMatches || !frozenHashMatches || !reasonMatches) {
      context.addIssue({
        code: "custom",
        message: "repository rules change fields are inconsistent",
      });
    }
  });

export const phase10RepositoryRulesRunEventDataSchemas = {
  "repository.rules.changed": repositoryRulesChangedDataSchema,
  "repository.rules.loaded": repositoryRulesLoadedDataSchema,
} as const;

export type Phase10RepositoryRulesRunEventType =
  keyof typeof phase10RepositoryRulesRunEventDataSchemas;
