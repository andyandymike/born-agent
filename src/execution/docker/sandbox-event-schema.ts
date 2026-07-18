import { z } from "zod";

import { persistedDockerExecutionImageIdentitySchema } from "./acquisition/docker-image-identity.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const bounded = (bytes: number) =>
  z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= bytes,
    `must not exceed ${bytes} UTF-8 bytes`,
  );
const relativePath = bounded(4_096).refine(
  (value) =>
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "must be a normalized relative path",
);
const common = {
  action_sha256: sha256,
  execution_id: uuid,
};
const container = {
  ...common,
  container_identity_sha256: sha256,
};

export const phase13SandboxRunEventDataSchemas = {
  "sandbox.container.cleaned": z
    .object({
      ...container,
      absent_by_id: z.literal(true),
      absent_by_name: z.literal(true),
      recovered: z.boolean(),
      resolution: z.enum([
        "effect_unknown_absent",
        "never_created",
        "never_started",
        "terminal_inspected",
      ]),
    })
    .strict(),
  "sandbox.container.create.requested": z
    .object({
      ...container,
      container_name: z.string().regex(/^bornagent-[a-f0-9]{24}$/u),
      hostname: z.string().regex(/^born-[a-f0-9]{12}$/u),
      image_digest: imageDigest,
      image_identity: persistedDockerExecutionImageIdentitySchema.optional(),
      nonce: uuid,
      snapshot_sha256: sha256,
    })
    .strict(),
  "sandbox.container.created": z
    .object({
      ...container,
      container_id: z.string().regex(/^[a-f0-9]{64}$/u),
      container_id_sha256: sha256,
    })
    .strict(),
  "sandbox.container.exited": z
    .object({
      ...container,
      exit_code: z.number().int().min(0).max(255),
      recovered: z.boolean(),
    })
    .strict(),
  "sandbox.container.inspected": z
    .object({
      ...container,
      exit_code: z.number().int().min(0).max(255),
      finished_at: z.string().datetime({ offset: true }),
      oom_killed: z.boolean(),
      started_at: z.string().datetime({ offset: true }),
      state_error: bounded(500).nullable(),
    })
    .strict(),
  "sandbox.container.start.requested": z.object(container).strict(),
  "sandbox.container.started": z.object(container).strict(),
  "sandbox.container.stopping": z
    .object({
      ...container,
      reason: z.enum([
        "abort",
        "output_limit",
        "storage_failure",
        "timeout",
        "wait_error",
      ]),
    })
    .strict(),
  "sandbox.snapshot.changed": z
    .object({
      ...common,
      after_sha256: sha256,
      before_sha256: sha256,
      created: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
      modified: z.number().int().nonnegative(),
      paths: z.array(relativePath).max(256),
      special_entries: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  "sandbox.snapshot.cleaned": z
    .object({
      ...common,
      cleanup_verified: z.literal(true),
      snapshot_sha256: sha256,
    })
    .strict(),
  "sandbox.snapshot.created": z
    .object({
      ...common,
      file_count: z.number().int().nonnegative(),
      image_digest: imageDigest,
      image_identity: persistedDockerExecutionImageIdentitySchema.optional(),
      limits: z
        .object({
          cpus: z.number().min(0.25).max(8),
          memory_mib: z.number().int().min(256).max(8_192),
          pids: z.number().int().min(32).max(1_024),
          tmp_mib: z.number().int().min(16).max(1_024),
        })
        .strict(),
      network: z.literal("none"),
      omitted: z
        .array(
          z
            .object({
              category: z.enum([
                "host_cache",
                "ignored",
                "internal_state",
                "sensitive_path",
              ]),
              count: z.number().int().positive(),
            })
            .strict(),
        )
        .max(4),
      policy_version: bounded(128).min(1),
      snapshot_sha256: sha256,
      source_state_sha256: sha256,
      total_bytes: z.number().int().nonnegative(),
    })
    .strict(),
} as const;

export type Phase13SandboxRunEventType =
  keyof typeof phase13SandboxRunEventDataSchemas;
export type Phase13SandboxRunEventData<
  TType extends Phase13SandboxRunEventType,
> = z.infer<(typeof phase13SandboxRunEventDataSchemas)[TType]>;

export interface SandboxEventAppender {
  append<TType extends Phase13SandboxRunEventType>(
    type: TType,
    data: Phase13SandboxRunEventData<TType>,
  ): Promise<void>;
}
