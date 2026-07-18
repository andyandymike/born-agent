import { z } from "zod";

import { DockerAcquisitionError } from "./docker-acquisition-errors.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const digestReference = z
  .string()
  .min(73)
  .max(500)
  .regex(/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u)
  .refine((value) => !value.includes("latest"), "mutable latest aliases are forbidden");

export const dockerArtifactLockRawSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.literal("bornagent-sandbox-node-v1"),
    platform: z.enum(["linux/amd64", "linux/arm64"]),
    preferred_source: z.enum(["pull", "build"]),
    pull: z
      .object({
        image: digestReference,
        registry: z.literal("docker.io"),
        anonymous: z.literal(true),
        role: z.literal("build_base"),
        expected_compressed_bytes_max: z.number().int().min(1_048_576).max(536_870_912),
      })
      .strict(),
    build: z
      .object({
        dockerfile_relative_path: z.literal("bornagent-sandbox-node-v1/Dockerfile"),
        dockerfile_sha256: sha256,
        context_manifest_relative_path: z.literal("bornagent-sandbox-node-v1/context-manifest.json"),
        context_manifest_sha256: sha256,
        base_images: z.array(digestReference).min(1).max(8).refine(
          (items) => new Set(items).size === items.length,
          "base images must be unique",
        ),
        network: z.literal("none"),
      })
      .strict(),
    runtime_contract: z
      .object({
        image_policy_version: z.literal("phase13-docker-v1"),
        numeric_user: z.string().regex(/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/u),
        required_labels: z.record(
          z.string().min(1).max(200),
          z.string().min(1).max(500),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.build.base_images.includes(value.pull.image)) {
      context.addIssue({
        code: "custom",
        message: "the anonymous pull must be one of the exact locked build bases",
      });
    }
    const requiredLabelNames = [
      "org.bornagent.artifact-id",
      "org.bornagent.exec-wrapper-sha256",
      "org.bornagent.image-policy-version",
      "org.bornagent.runtime",
      "org.bornagent.runtime-version",
    ];
    if (
      Object.keys(value.runtime_contract.required_labels).sort().join("\0") !==
      requiredLabelNames.join("\0")
    ) {
      context.addIssue({
        code: "custom",
        message: "runtime contract labels must exact-match the built-in label set",
      });
    }
    if (
      value.runtime_contract.required_labels["org.bornagent.artifact-id"] !==
        value.id ||
      value.runtime_contract.required_labels[
        "org.bornagent.image-policy-version"
      ] !== value.runtime_contract.image_policy_version
    ) {
      context.addIssue({
        code: "custom",
        message: "runtime contract labels drifted from lock identity",
      });
    }
  });

export const dockerContextManifestRawSchema = z
  .object({
    schema_version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u),
            bytes: z.number().int().min(1).max(1_048_576),
            sha256,
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
  })
  .strict();

export type DockerArtifactLockV1 = Readonly<
  z.infer<typeof dockerArtifactLockRawSchema>
>;
export type DockerContextManifestV1 = Readonly<
  z.infer<typeof dockerContextManifestRawSchema>
>;

export function parseDockerArtifactLock(input: unknown): DockerArtifactLockV1 {
  const parsed = dockerArtifactLockRawSchema.safeParse(input);
  if (!parsed.success) {
    throw new DockerAcquisitionError(
      "docker_artifact_lock_invalid",
      "built-in Docker artifact lock failed strict validation",
      1,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}

export function parseDockerContextManifest(
  input: unknown,
): DockerContextManifestV1 {
  const parsed = dockerContextManifestRawSchema.safeParse(input);
  if (!parsed.success) {
    throw new DockerAcquisitionError(
      "docker_context_manifest_invalid",
      "built-in Docker context manifest failed strict validation",
      1,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}
