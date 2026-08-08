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
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const mcpActionKind = z.enum([
  "mcp.server.start",
  "mcp.tool.call",
  "mcp.resource.read",
  "mcp.prompt.get",
]);

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
      action_kind: mcpActionKind,
      action_sha256: sha256,
      approval_request_id: uuid,
      decision: z.enum(["approved", "cancelled", "denied"]),
      server_id: serverId,
    })
    .strict(),
  "mcp.approval.requested": z
    .object({
      action_kind: mcpActionKind,
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
      action_kind: mcpActionKind,
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
  "mcp.server.negotiated": z
    .object({
      instructions_artifact_id: artifactId.optional(),
      instructions_sha256: sha256.optional(),
      negotiation_sha256: sha256,
      process_identity_sha256: sha256,
      prompts_list_changed: z.boolean(),
      prompts_supported: z.boolean(),
      protocol_version: bounded(128).min(1),
      resources_list_changed: z.boolean(),
      resources_subscribe: z.boolean(),
      resources_supported: z.boolean(),
      server_identity_sha256: sha256,
      server_id: serverId,
      server_name: bounded(256).min(1),
      server_version: bounded(256).optional(),
      tools_list_changed: z.boolean(),
      tools_supported: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.instructions_artifact_id !== undefined &&
          (value.instructions_sha256 === undefined ||
            value.instructions_artifact_id !== `sha256:${value.instructions_sha256}`))
      ) {
        context.addIssue({ code: "custom", message: "MCP instructions artifact identity is inconsistent" });
      }
    }),
  "mcp.resource.cataloged": z
    .object({
      catalog_artifact_id: artifactId.optional(),
      catalog_generation_sha256: sha256,
      catalog_sha256: sha256,
      count: nonnegative.max(256),
      negotiation_sha256: sha256,
      process_identity_sha256: sha256,
      server_id: serverId,
    })
    .strict(),
  "mcp.resource.catalog.stale": z
    .object({
      catalog_generation_sha256: sha256,
      process_identity_sha256: sha256,
      reason: z.enum(["list_changed", "process_changed", "explicit_refresh"]),
      server_id: serverId,
    })
    .strict(),
  "mcp.resource.read.requested": z
    .object({
      action_sha256: sha256,
      approval_request_id: uuid,
      call_id: bounded(200).min(1),
      catalog_generation_sha256: sha256,
      config_sha256: sha256,
      max_bytes: positive.max(256 * 1024),
      negotiation_sha256: sha256,
      process_identity_sha256: sha256,
      resource_id: bounded(128).regex(/^mcp-resource:[a-f0-9]{64}$/u),
      resource_item_sha256: sha256,
      server_id: serverId,
      step: positive,
      timeout_ms: positive,
      uri_sha256: sha256,
    })
    .strict(),
  "mcp.resource.read.completed": z
    .object({
      action_sha256: sha256,
      byte_length: nonnegative.max(1024 * 1024),
      content_part_count: nonnegative.max(16),
      projection_artifact_id: artifactId.optional(),
      projection_sha256: sha256.optional(),
      raw_artifact_id: artifactId,
      raw_sha256: sha256,
      resource_id: bounded(128).regex(/^mcp-resource:[a-f0-9]{64}$/u),
      server_id: serverId,
      truncated: z.boolean(),
      unsupported_content_count: nonnegative.max(16),
    })
    .strict()
    .refine(
      (value) =>
        (value.projection_artifact_id === undefined) ===
        (value.projection_sha256 === undefined),
      "MCP resource projection artifact identity is incomplete",
    ),
  "mcp.resource.read.failed": z
    .object({
      action_sha256: sha256,
      code: bounded(128).min(1),
      effect: z.enum(["no_effect", "effect_unknown", "stale"]),
      resource_id: bounded(128).regex(/^mcp-resource:[a-f0-9]{64}$/u),
      server_id: serverId,
    })
    .strict(),
  "mcp.prompt.cataloged": z
    .object({
      catalog_artifact_id: artifactId.optional(),
      catalog_generation_sha256: sha256,
      catalog_sha256: sha256,
      count: nonnegative.max(128),
      negotiation_sha256: sha256,
      process_identity_sha256: sha256,
      server_id: serverId,
    })
    .strict(),
  "mcp.prompt.catalog.stale": z
    .object({
      catalog_generation_sha256: sha256,
      process_identity_sha256: sha256,
      reason: z.enum(["list_changed", "process_changed", "explicit_refresh"]),
      server_id: serverId,
    })
    .strict(),
  "mcp.prompt.get.requested": z
    .object({
      action_sha256: sha256,
      approval_request_id: uuid,
      arguments_sha256: sha256,
      catalog_generation_sha256: sha256,
      config_sha256: sha256,
      invocation_event_id: uuid,
      negotiation_sha256: sha256,
      process_identity_sha256: sha256,
      prompt_id: bounded(128).regex(/^mcp-prompt:[a-f0-9]{64}$/u),
      prompt_item_sha256: sha256,
      prompt_name: bounded(512).min(1),
      server_id: serverId,
      timeout_ms: positive,
    })
    .strict(),
  "mcp.prompt.user.invoked": z
    .object({
      arguments_sha256: sha256,
      invocation_id: uuid,
      selector: bounded(640).min(1),
      source: z.enum(["cli", "tui"]),
    })
    .strict(),
  "mcp.prompt.get.completed": z
    .object({
      action_sha256: sha256,
      byte_length: nonnegative.max(256 * 1024),
      message_count: nonnegative.max(32),
      projection_artifact_id: artifactId.optional(),
      projection_sha256: sha256.optional(),
      prompt_id: bounded(128).regex(/^mcp-prompt:[a-f0-9]{64}$/u),
      raw_artifact_id: artifactId,
      raw_sha256: sha256,
      server_id: serverId,
      truncated: z.boolean(),
      unsupported_content_count: nonnegative.max(32),
    })
    .strict()
    .refine(
      (value) =>
        (value.projection_artifact_id === undefined) ===
        (value.projection_sha256 === undefined),
      "MCP prompt projection artifact identity is incomplete",
    ),
  "mcp.prompt.get.failed": z
    .object({
      action_sha256: sha256,
      code: bounded(128).min(1),
      effect: z.enum(["no_effect", "effect_unknown", "stale"]),
      prompt_id: bounded(128).regex(/^mcp-prompt:[a-f0-9]{64}$/u),
      server_id: serverId,
    })
    .strict(),
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
