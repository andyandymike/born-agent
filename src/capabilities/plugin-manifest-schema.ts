import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { CapabilityError } from "./capability-errors.js";

export const MAX_CAPABILITY_MANIFEST_BYTES = 256 * 1024;
export const MAX_COMPONENT_METADATA_BYTES = 64 * 1024;
export const MAX_CAPABILITY_COMPONENTS = 128;
export const MAX_CAPABILITY_PATH_BYTES = 512;
export const MAX_CAPABILITY_PATH_DEPTH = 16;

export const capabilityIdentifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){0,79}$/u)
  .refine((value) => value === value.normalize("NFC"), "identifier must be NFC");
export const capabilityVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9])){0,63}$/u);
const displayName = z.string().min(1).max(120).refine(noControlCharacters);
const description = z.string().min(1).max(512).refine(noControlCharacters);
const requestedEffect = z.enum([
  "workspace_read",
  "workspace_write",
  "process_spawn",
  "network",
]);
const requestedEffects = z
  .array(requestedEffect)
  .max(8)
  .refine((values) => new Set(values).size === values.length, "requested effects must be unique")
  .optional();

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function noControlCharacters(value: string): boolean {
  return value === value.normalize("NFC") && !hasControlCharacters(value);
}

function pathIsCanonical(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_CAPABILITY_PATH_BYTES
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.length > MAX_CAPABILITY_PATH_DEPTH ||
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      hasControlCharacters(segment) ||
      /[<>:"|?*]/u.test(segment) ||
      /[. ]$/u.test(segment)
    )
  ) {
    return false;
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  return segments.every((segment) => !reserved.test(segment));
}

export const capabilityRelativePathSchema = z
  .string()
  .refine(pathIsCanonical, "path must be canonical, portable, and package-relative");

const componentList = z
  .array(capabilityRelativePathSchema)
  .max(MAX_CAPABILITY_COMPONENTS)
  .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, "component paths must be unique under Windows path semantics")
  .optional();

export const pluginManifestSchema = z
  .object({
    schema_version: z.literal(1),
    plugin_id: capabilityIdentifierSchema,
    plugin_version: capabilityVersionSchema,
    display_name: displayName,
    description,
    components: z
      .object({
        skills: componentList,
        hooks: componentList,
        mcp_servers: componentList,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const all = [
      ...(value.components.skills ?? []),
      ...(value.components.hooks ?? []),
      ...(value.components.mcp_servers ?? []),
    ];
    if (all.length > MAX_CAPABILITY_COMPONENTS) {
      context.addIssue({ code: "custom", message: "package has too many components", path: ["components"] });
    }
    if (new Set(all.map((path) => path.toLowerCase())).size !== all.length) {
      context.addIssue({ code: "custom", message: "component paths collide", path: ["components"] });
    }
  });

const skillResourceSchema = z
  .object({
    resource_id: capabilityIdentifierSchema,
    path: capabilityRelativePathSchema,
    media_type: z.enum(["text/markdown", "text/plain", "application/json"]),
    description,
  })
  .strict();

export const skillComponentSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("skill"),
    component_id: capabilityIdentifierSchema,
    display_name: displayName,
    description,
    invocation: z.enum(["user_only", "model_allowed"]),
    entry: capabilityRelativePathSchema,
    resources: z
      .array(skillResourceSchema)
      .max(64)
      .refine((values) => new Set(values.map((value) => value.resource_id)).size === values.length, "resource IDs must be unique")
      .optional(),
    context: z
      .object({
        max_entry_bytes: z.number().int().min(1).max(256 * 1024),
        max_resource_bytes: z.number().int().min(1).max(256 * 1024),
        max_total_resource_bytes: z.number().int().min(1).max(2 * 1024 * 1024),
      })
      .strict(),
  })
  .strict();

const hookMatcherSchema = z
  .object({
    tool_names: z.array(z.string().min(1).max(128)).max(32).optional(),
    action_kinds: z.array(z.string().min(1).max(128)).max(32).optional(),
    path_prefixes: z.array(capabilityRelativePathSchema).max(32).optional(),
    capability_ids: z.array(z.string().min(1).max(512)).max(32).optional(),
    terminal_states: z.array(z.enum(["completed", "failed", "cancelled", "blocked"])).max(4).optional(),
  })
  .strict();

const declarativePredicateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("require_plan_approval") }).strict(),
  z.object({ type: z.literal("deny_path_prefixes"), prefixes: z.array(capabilityRelativePathSchema).min(1).max(32) }).strict(),
  z.object({ type: z.literal("require_latest_verification"), commands: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict(),
  z.object({ type: z.literal("deny_action_kinds"), action_kinds: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict(),
  z.object({ type: z.literal("require_clean_effect_reconciliation") }).strict(),
]);

const declarativeHookHandlerSchema = z
  .object({
    type: z.literal("declarative_gate"),
    predicate: declarativePredicateSchema,
    message: z.string().min(1).max(512).refine(noControlCharacters),
  })
  .strict();

const commandHookHandlerSchema = z
  .object({
    type: z.literal("command"),
    executable: capabilityRelativePathSchema,
    argv: z.array(z.string().max(8 * 1024).refine((value) => !value.includes("\0"))).max(64),
    cwd: z.enum(["workspace_root", "plugin_root"]),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u), z.string().max(8 * 1024).refine((value) => !value.includes("\0"))).optional(),
    sandbox: z.enum(["required", "policy_selected"]),
  })
  .strict();

export const hookComponentSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("hook"),
    component_id: capabilityIdentifierSchema,
    display_name: displayName,
    description,
    event: z.enum([
      "session.started",
      "run.started",
      "tool.before_effect",
      "tool.after_result",
      "completion.before_commit",
      "run.terminal",
      "session.ended",
    ]),
    mode: z.enum(["gate", "observe"]),
    matcher: hookMatcherSchema.optional(),
    handler: z.union([declarativeHookHandlerSchema, commandHookHandlerSchema]),
    timeout_ms: z.number().int().min(100).max(120_000).optional(),
    failure_policy: z.enum(["fail_closed", "record_degraded"]),
    requested_effects: requestedEffects,
  })
  .strict()
  .superRefine((value, context) => {
    const observeOnly = new Set(["session.started", "tool.after_result", "run.terminal", "session.ended"]);
    if (observeOnly.has(value.event) && value.mode !== "observe") {
      context.addIssue({ code: "custom", message: "event supports observe hooks only", path: ["mode"] });
    }
    if (
      (value.mode === "gate" && value.failure_policy !== "fail_closed") ||
      (value.mode === "observe" && value.failure_policy !== "record_degraded")
    ) {
      context.addIssue({ code: "custom", message: "hook failure policy does not match mode", path: ["failure_policy"] });
    }
    if (value.handler.type === "declarative_gate" && (value.mode !== "gate" || (value.requested_effects?.length ?? 0) !== 0)) {
      context.addIssue({ code: "custom", message: "declarative hooks are pure gates", path: ["handler"] });
    }
  });

const environmentMappingSchema = z
  .object({
    source: z.string().regex(/^BORN_MCP_[A-Za-z0-9_]{1,116}$/u),
    target: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
  })
  .strict();

export const mcpServerComponentSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("mcp_server"),
    component_id: capabilityIdentifierSchema,
    display_name: displayName,
    description,
    transport: z.literal("stdio"),
    executable: capabilityRelativePathSchema,
    args: z.array(z.string().max(4096).refine((value) => !value.includes("\0"))).max(64),
    cwd: z.enum(["workspace_root", "plugin_root"]),
    integrity_files: z.array(capabilityRelativePathSchema).max(32),
    env: z.array(environmentMappingSchema).max(32),
    startup_timeout_ms: z.number().int().min(100).max(120_000),
    call_timeout_ms: z.number().int().min(100).max(600_000),
    requested_effects: requestedEffects,
  })
  .strict();

export const componentSchema = z.discriminatedUnion("kind", [
  skillComponentSchema,
  hookComponentSchema,
  mcpServerComponentSchema,
]);

export type ParsedPluginManifest = z.infer<typeof pluginManifestSchema>;
export type ParsedCapabilityComponent = z.infer<typeof componentSchema>;

export const CAPABILITY_PLATFORM_SCHEMA_IDENTITY = Object.freeze({
  componentSchemas: Object.freeze({ hook: 1, mcpServer: 1, skill: 1 }),
  manifestSchema: 1,
  snapshotSchema: 1,
  sourceSchema: 1,
});
export const CAPABILITY_PLATFORM_SCHEMA_SHA256 = sha256Canonical(
  CAPABILITY_PLATFORM_SCHEMA_IDENTITY,
);

function decodeUtf8(bytes: Uint8Array, kind: "component" | "manifest"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CapabilityError(
      kind === "manifest" ? "capability_manifest_invalid" : "capability_component_invalid",
      `capability ${kind} must be valid UTF-8`,
      2,
      { cause: error },
    );
  }
}

export function parsePluginManifestBytes(bytes: Uint8Array): ParsedPluginManifest {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CAPABILITY_MANIFEST_BYTES) {
    throw new CapabilityError(
      "capability_manifest_invalid",
      `capability manifest size must be 1..${String(MAX_CAPABILITY_MANIFEST_BYTES)} bytes`,
    );
  }
  try {
    return pluginManifestSchema.parse(parseStrictJson(decodeUtf8(bytes, "manifest")));
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      "capability_manifest_invalid",
      "capability manifest failed strict schema validation",
      2,
      { cause: error },
    );
  }
}

export function encodePluginManifest(
  value: ParsedPluginManifest,
): Uint8Array {
  try {
    const parsed = pluginManifestSchema.parse(value);
    return Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
  } catch (error) {
    throw new CapabilityError(
      "capability_manifest_invalid",
      "capability manifest failed strict schema validation",
      2,
      { cause: error },
    );
  }
}

export function parseCapabilityComponentBytes(bytes: Uint8Array): ParsedCapabilityComponent {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_COMPONENT_METADATA_BYTES) {
    throw new CapabilityError(
      "capability_component_invalid",
      `component metadata size must be 1..${String(MAX_COMPONENT_METADATA_BYTES)} bytes`,
    );
  }
  try {
    return componentSchema.parse(parseStrictJson(decodeUtf8(bytes, "component")));
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      "capability_component_invalid",
      "capability component failed strict schema validation",
      2,
      { cause: error },
    );
  }
}
