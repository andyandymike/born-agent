import { z } from "zod";

import { sha256Canonical } from "../../../completion/canonical-json.js";

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256Id = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const digestReference = z
  .string()
  .min(73)
  .max(500)
  .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u);

export type DockerExecutionImageIdentity =
  | {
      readonly kind: "registry_digest";
      readonly reference: string;
      readonly configImageId: `sha256:${string}`;
    }
  | {
      readonly kind: "trusted_local_build";
      readonly artifactId: string;
      readonly artifactLockSha256: string;
      readonly dockerfileSha256: string;
      readonly contextManifestSha256: string;
      readonly baseImageDigests: readonly string[];
      readonly configImageId: `sha256:${string}`;
    };

export type TrustedLocalDockerBuildIdentity = Extract<
  DockerExecutionImageIdentity,
  { readonly kind: "trusted_local_build" }
>;

export interface DockerArtifactExecutionConfig {
  readonly artifactId: string;
  readonly expectedLockfileSha256: string;
  readonly imageIdentity: TrustedLocalDockerBuildIdentity;
  readonly imagePath: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly supportsCUtf8: boolean;
  readonly wrapperSha256: string;
}

const rawDockerExecutionImageIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("registry_digest"),
      reference: digestReference,
      configImageId: sha256Id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trusted_local_build"),
      artifactId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      artifactLockSha256: sha256Hex,
      dockerfileSha256: sha256Hex,
      contextManifestSha256: sha256Hex,
      baseImageDigests: z
        .array(digestReference)
        .min(1)
        .max(8)
        .refine(
          (items) => new Set(items).size === items.length,
          "base image digests must be unique",
        ),
      configImageId: sha256Id,
    })
    .strict(),
]);

export const dockerExecutionImageIdentitySchema =
  rawDockerExecutionImageIdentitySchema.transform(
    (value): DockerExecutionImageIdentity =>
      value.kind === "registry_digest"
        ? Object.freeze({
            configImageId: value.configImageId as `sha256:${string}`,
            kind: value.kind,
            reference: value.reference,
          })
        : Object.freeze({
            artifactId: value.artifactId,
            artifactLockSha256: value.artifactLockSha256,
            baseImageDigests: Object.freeze([...value.baseImageDigests]),
            configImageId: value.configImageId as `sha256:${string}`,
            contextManifestSha256: value.contextManifestSha256,
            dockerfileSha256: value.dockerfileSha256,
            kind: value.kind,
          }),
  );

// PHASE15: persisted identity is a tagged union. A registry artifact is bound
// by repository digest plus config ID; a local build has no RepoDigest, so it
// is bound by config ID together with package lock, recipe, context, and bases.
export const persistedDockerExecutionImageIdentitySchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("registry_digest"),
        reference: digestReference,
        config_image_id: sha256Id,
      })
      .strict(),
    z
      .object({
        kind: z.literal("trusted_local_build"),
        artifact_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
        artifact_lock_sha256: sha256Hex,
        dockerfile_sha256: sha256Hex,
        context_manifest_sha256: sha256Hex,
        base_image_digests: z
          .array(digestReference)
          .min(1)
          .max(8)
          .refine(
            (items) => new Set(items).size === items.length,
            "base image digests must be unique",
          ),
        config_image_id: sha256Id,
      })
      .strict(),
  ],
);

export type PersistedDockerExecutionImageIdentity = z.infer<
  typeof persistedDockerExecutionImageIdentitySchema
>;

export function persistDockerExecutionImageIdentity(
  identity: DockerExecutionImageIdentity,
): PersistedDockerExecutionImageIdentity {
  return identity.kind === "registry_digest"
    ? Object.freeze({
        config_image_id: identity.configImageId,
        kind: identity.kind,
        reference: identity.reference,
      })
    : Object.freeze({
        artifact_id: identity.artifactId,
        artifact_lock_sha256: identity.artifactLockSha256,
        base_image_digests: [...identity.baseImageDigests],
        config_image_id: identity.configImageId,
        context_manifest_sha256: identity.contextManifestSha256,
        dockerfile_sha256: identity.dockerfileSha256,
        kind: identity.kind,
      });
}

export function restoreDockerExecutionImageIdentity(
  input: unknown,
): DockerExecutionImageIdentity {
  const value = persistedDockerExecutionImageIdentitySchema.parse(input);
  return value.kind === "registry_digest"
    ? Object.freeze({
        configImageId: value.config_image_id as `sha256:${string}`,
        kind: value.kind,
        reference: value.reference,
      })
    : Object.freeze({
        artifactId: value.artifact_id,
        artifactLockSha256: value.artifact_lock_sha256,
        baseImageDigests: Object.freeze([...value.base_image_digests]),
        configImageId: value.config_image_id as `sha256:${string}`,
        contextManifestSha256: value.context_manifest_sha256,
        dockerfileSha256: value.dockerfile_sha256,
        kind: value.kind,
      });
}

export function dockerExecutionImageIdentitySha256(
  identity: DockerExecutionImageIdentity,
): string {
  return sha256Canonical(persistDockerExecutionImageIdentity(identity));
}

export function executionReference(identity: DockerExecutionImageIdentity): string {
  return identity.kind === "registry_digest"
    ? identity.reference
    : identity.configImageId;
}
