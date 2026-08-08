import { z } from "zod";

import type { DecodedRunEvent } from "../events/event-decoder-registry.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const uuid = z.string().uuid();

const skillIdentitySchema = z
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

export const skillRunSummarySchema = z
  .object({
    activations: z
      .array(
        z
          .object({
            activationId: uuid,
            contentArtifactId: artifactId.nullable(),
            contentSha256: sha256.nullable(),
            failureCode: z.string().min(1).max(128).nullable(),
            identity: skillIdentitySchema,
            resources: z
              .array(
                z
                  .object({
                    artifactId,
                    byteLength: z.number().int().nonnegative(),
                    contentSha256: sha256,
                    endOffset: z.number().int().nonnegative(),
                    fullContentSha256: sha256,
                    offset: z.number().int().nonnegative(),
                    resourceId: z.string().min(1).max(80),
                    totalBytes: z.number().int().nonnegative(),
                    truncated: z.boolean(),
                  })
                  .strict(),
              )
              .max(1024),
            selectedBy: z.enum(["model", "user"]),
            status: z.enum(["requested", "activated", "failed"]),
            userArgumentsArtifactId: artifactId.nullable(),
          })
          .strict(),
      )
      .max(128),
    resourceReadCount: z.number().int().nonnegative().max(1024),
  })
  .strict();

export type SkillRunSummary = Readonly<z.infer<typeof skillRunSummarySchema>>;

type Requested = Extract<DecodedRunEvent, { type: "skill.activation.requested" }>;
type MutableActivation = {
  readonly requested: Requested;
  activated?: Extract<DecodedRunEvent, { type: "skill.activated" }>;
  failed?: Extract<DecodedRunEvent, { type: "skill.activation.failed" }>;
  readonly resources: Extract<DecodedRunEvent, { type: "skill.resource.read" }>[];
};

export function projectSkillRunSummary(
  events: readonly DecodedRunEvent[],
): SkillRunSummary {
  const activations = new Map<string, MutableActivation>();
  for (const event of events) {
    if (event.type === "skill.activation.requested") {
      if (activations.has(event.data.activation_id)) {
        throw new Error("duplicate Skill activation request");
      }
      activations.set(event.data.activation_id, { requested: event, resources: [] });
      continue;
    }
    if (
      event.type !== "skill.activated" &&
      event.type !== "skill.activation.failed" &&
      event.type !== "skill.resource.read"
    ) {
      continue;
    }
    const activation = activations.get(event.data.activation_id);
    if (activation === undefined) {
      throw new Error("Skill event has no preceding activation request");
    }
    if (event.type === "skill.activated") {
      if (activation.activated !== undefined || activation.failed !== undefined) {
        throw new Error("Skill activation has more than one terminal result");
      }
      activation.activated = event;
    } else if (event.type === "skill.activation.failed") {
      if (
        activation.activated !== undefined ||
        activation.failed !== undefined ||
        activation.resources.length > 0
      ) {
        throw new Error("Skill activation failure contradicts existing content facts");
      }
      activation.failed = event;
    } else {
      if (activation.activated === undefined || activation.failed !== undefined) {
        throw new Error("Skill resource read requires a completed activation");
      }
      if (activation.resources.some((candidate) => candidate.data.read_id === event.data.read_id)) {
        throw new Error("duplicate Skill resource read identity");
      }
      activation.resources.push(event);
    }
  }

  return skillRunSummarySchema.parse({
    activations: [...activations.values()].map((activation) => ({
      activationId: activation.requested.data.activation_id,
      contentArtifactId: activation.activated?.data.content_artifact_id ?? null,
      contentSha256: activation.activated?.data.content_sha256 ?? null,
      failureCode: activation.failed?.data.code ?? null,
      identity: activation.requested.data.skill_identity,
      resources: activation.resources.map((event) => ({
        artifactId: event.data.content_artifact_id,
        byteLength: event.data.byte_length,
        contentSha256: event.data.content_sha256,
        endOffset: event.data.end_offset,
        fullContentSha256: event.data.full_content_sha256,
        offset: event.data.offset,
        resourceId: event.data.resource_id,
        totalBytes: event.data.total_bytes,
        truncated: event.data.truncated,
      })),
      selectedBy: activation.requested.data.selected_by,
      status: activation.activated !== undefined
        ? "activated"
        : activation.failed !== undefined
          ? "failed"
          : "requested",
      userArgumentsArtifactId:
        activation.requested.data.user_arguments_artifact_id ?? null,
    })),
    resourceReadCount: [...activations.values()].reduce(
      (total, activation) => total + activation.resources.length,
      0,
    ),
  });
}
