import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const identity = z
  .object({
    componentId: z.string().min(1).max(80),
    componentSha256: sha256,
    kind: z.literal("skill"),
    pluginId: z.string().min(1).max(80),
    pluginSha256: sha256,
    pluginVersion: z.string().min(1).max(64),
    qualifiedId: z.string().min(1).max(512),
    source: z.enum(["builtin", "user_install", "workspace"]),
  })
  .strict();

export const phase18SkillRunEventDataSchemas = {
  "skill.activation.failed": z
    .object({
      activation_id: uuid,
      code: z.string().min(1).max(128),
      detail_sha256: sha256,
    })
    .strict(),
  "skill.activation.requested": z
    .object({
      activation_id: uuid,
      selected_by: z.enum(["model", "user"]),
      skill_identity: identity,
      user_arguments_artifact_id: artifactId.optional(),
      user_arguments_sha256: sha256.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.user_arguments_artifact_id === undefined) !==
        (value.user_arguments_sha256 === undefined) ||
        (value.user_arguments_artifact_id !== undefined &&
          value.user_arguments_artifact_id !== `sha256:${value.user_arguments_sha256}`)
      ) {
        context.addIssue({
          code: "custom",
          message: "Skill user arguments artifact identity is inconsistent",
        });
      }
    }),
  "skill.activated": z
    .object({
      activation_id: uuid,
      byte_length: z.number().int().nonnegative().max(256 * 1024),
      content_artifact_id: artifactId,
      content_sha256: sha256,
      resource_catalog_sha256: sha256,
    })
    .strict()
    .refine(
      (value) => value.content_artifact_id === `sha256:${value.content_sha256}`,
      "Skill content artifact identity is inconsistent",
    ),
  "skill.resource.read": z
    .object({
      activation_id: uuid,
      byte_length: z.number().int().nonnegative().max(256 * 1024),
      content_artifact_id: artifactId,
      content_sha256: sha256,
      end_offset: z.number().int().nonnegative().max(2 * 1024 * 1024),
      full_content_sha256: sha256,
      next_offset: z.number().int().nonnegative().max(2 * 1024 * 1024).nullable(),
      offset: z.number().int().nonnegative().max(2 * 1024 * 1024),
      read_id: uuid,
      resource_id: z.string().min(1).max(80),
      total_bytes: z.number().int().nonnegative().max(2 * 1024 * 1024),
      truncated: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.content_artifact_id !== `sha256:${value.content_sha256}` ||
        value.end_offset !== value.offset + value.byte_length ||
        value.end_offset > value.total_bytes ||
        (value.truncated ? value.next_offset !== value.end_offset : value.next_offset !== null)
      ) {
        context.addIssue({ code: "custom", message: "Skill resource range is inconsistent" });
      }
    }),
} as const;

export type Phase18SkillRunEventType = keyof typeof phase18SkillRunEventDataSchemas;
export type Phase18SkillRunEventData<TType extends Phase18SkillRunEventType> =
  z.infer<(typeof phase18SkillRunEventDataSchemas)[TType]>;
