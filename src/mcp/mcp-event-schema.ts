import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const serverId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const bounded = (bytes: number) =>
  z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= bytes && !value.includes("\0"),
    `must be NUL-free and at most ${bytes} UTF-8 bytes`,
  );
const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();

const processIdentity = {
  host_fingerprint: sha256,
  pid: positive,
  process_identity_sha256: sha256,
  process_start_identity: bounded(256).min(1),
};

const callIdentity = {
  action_sha256: sha256,
  approval_request_id: uuid,
  arguments_sha256: sha256,
  call_id: bounded(200).min(1),
  catalog_sha256: sha256,
  config_sha256: sha256,
  model_tool_name: toolName,
  process_identity_sha256: sha256,
  raw_tool_name: bounded(512).min(1),
  schema_sha256: sha256,
  server_id: serverId,
  step: positive,
  timeout_ms: positive,
};

export const phase12McpRunEventDataSchemas = {
  "mcp.approval.decided": z
    .object({
      action_kind: z.enum(["mcp.server.start", "mcp.tool.call"]),
      action_sha256: sha256,
      approval_request_id: uuid,
      decision: z.enum(["approved", "cancelled", "denied"]),
      server_id: serverId,
    })
    .strict(),
  "mcp.approval.requested": z
    .object({
      action_kind: z.enum(["mcp.server.start", "mcp.tool.call"]),
      action_sha256: sha256,
      approval_request_id: uuid,
      preview: bounded(32 * 1024),
      server_id: serverId,
      truncated: z.boolean(),
    })
    .strict(),
  "mcp.catalog.changed": z
    .object({
      catalog_sha256: sha256,
      changed_catalog_sha256: sha256,
      process_identity_sha256: sha256,
      server_id: serverId,
    })
    .strict()
    .refine(
      (value) => value.catalog_sha256 !== value.changed_catalog_sha256,
      "catalog hash must change",
    ),
  "mcp.catalog.discovered": z
    .object({
      catalog_sha256: sha256,
      process_identity_sha256: sha256,
      server_id: serverId,
      tools: z
        .array(
          z
            .object({
              description_sha256: sha256,
              model_name: toolName,
              raw_name: bounded(512).min(1),
              schema_sha256: sha256,
              strict_for_model: z.boolean(),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
  "mcp.permission.evaluated": z
    .object({
      action_kind: z.enum(["mcp.server.start", "mcp.tool.call"]),
      action_sha256: sha256,
      effect: z.enum(["allow", "ask", "deny"]),
      policy_version: bounded(128).min(1),
      reason_code: bounded(128).optional(),
      rule_id: bounded(128).min(1),
      server_id: serverId,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.effect === "allow" && value.reason_code !== undefined) ||
        (value.effect !== "allow" && value.reason_code === undefined)
      ) {
        context.addIssue({ code: "custom", message: "permission reason does not match effect" });
      }
    }),
  "mcp.server.start.effect_unknown": z
    .object({
      action_sha256: sha256,
      code: bounded(128).min(1),
      server_id: serverId,
    })
    .strict(),
  "mcp.server.start.failed": z
    .object({
      action_sha256: sha256,
      code: bounded(128).min(1),
      effect: z.literal("not_started"),
      server_id: serverId,
      zero_process_proof_sha256: sha256,
    })
    .strict(),
  "mcp.server.start.requested": z
    .object({
      action_sha256: sha256,
      approval_request_id: uuid,
      config_sha256: sha256,
      env_mapping_sha256: sha256,
      executable_identity_sha256: sha256,
      integrity_binding: z.enum(["explicit", "not_bound"]),
      integrity_manifest_sha256: sha256,
      server_id: serverId,
      startup_timeout_ms: positive,
    })
    .strict(),
  "mcp.server.started": z
    .object({
      ...processIdentity,
      action_sha256: sha256,
      config_sha256: sha256,
      sdk_version: z.literal("1.29.0"),
      server_id: serverId,
    })
    .strict(),
  "mcp.server.stderr": z
    .object({
      bytes: positive,
      chunk: bounded(16 * 1024).min(1),
      process_identity_sha256: sha256,
      server_id: serverId,
      truncated: z.boolean(),
    })
    .strict()
    .refine(
      (value) => value.bytes === Buffer.byteLength(value.chunk, "utf8"),
      "stderr bytes must match chunk",
    ),
  "mcp.server.stopped": z
    .object({
      ...processIdentity,
      cleanup_verified: z.literal(true),
      server_id: serverId,
      termination: z.enum(["exit", "graceful", "forced", "spawn_failed"]),
    })
    .strict(),
  "mcp.server.stopping": z
    .object({
      active_call_count: z.literal(0),
      process_identity_sha256: sha256,
      server_id: serverId,
    })
    .strict(),
  "mcp.tool.call.completed": z
    .object({
      ...callIdentity,
      artifact_ref: bounded(4096).optional(),
      artifact_sha256: sha256.optional(),
      bytes: nonnegative,
      duration_ms: nonnegative,
      mapper_version: z.literal("mcp-text-result-v1"),
      observation: bounded(1_114_112),
      observation_sha256: sha256,
      status: z.enum(["error", "success"]),
      truncated: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.bytes !== Buffer.byteLength(value.observation, "utf8") ||
        (value.artifact_ref === undefined) !== (value.artifact_sha256 === undefined)
      ) {
        context.addIssue({ code: "custom", message: "mapped MCP result metadata mismatch" });
      }
    }),
  "mcp.tool.call.effect_unknown": z
    .object({
      ...callIdentity,
      code: bounded(128).min(1),
    })
    .strict(),
  "mcp.tool.call.started": z.object(callIdentity).strict(),
} as const;

export type Phase12McpRunEventType = keyof typeof phase12McpRunEventDataSchemas;
export type Phase12McpRunEventData<TType extends Phase12McpRunEventType> =
  z.infer<(typeof phase12McpRunEventDataSchemas)[TType]>;
