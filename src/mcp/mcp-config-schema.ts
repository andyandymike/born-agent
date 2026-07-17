import { posix as pathPosix } from "node:path";

import { z } from "zod";

import { McpCoreError } from "./mcp-errors.js";

export const MAX_MCP_SERVERS = 8;
export const MAX_MCP_ENABLED_SERVERS = 4;
export const MAX_MCP_CONFIG_BYTES = 256 * 1024;
export const MAX_MCP_ARGS = 64;
export const MAX_MCP_ARG_BYTES = 16 * 1024;
export const MAX_MCP_INTEGRITY_FILES = 32;

const serverIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const portableEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const nulFreeString = (maximumBytes: number) =>
  z
    .string()
    .refine((value) => !value.includes("\0"), "must not contain NUL")
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      `must not exceed ${maximumBytes} UTF-8 bytes`,
    );
const workspaceRelativePathSchema = nulFreeString(4096).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    normalized.split("/").every((segment) => segment !== ".." && segment !== "")
  );
}, "must be a normalized workspace-relative path");

const environmentMappingSchema = z
  .object({
    source: portableEnvironmentNameSchema.refine(
      (value) => value.startsWith("BORN_MCP_"),
      "source must start with BORN_MCP_",
    ),
    target: portableEnvironmentNameSchema,
  })
  .strict();

export const mcpServerConfigSchema = z
  .object({
    args: z.array(nulFreeString(4096)).max(MAX_MCP_ARGS),
    call_timeout_ms: z.number().int().min(100).max(600_000),
    cwd: workspaceRelativePathSchema,
    env: z.array(environmentMappingSchema).max(32),
    executable: nulFreeString(1024).min(1),
    integrity_files: z
      .array(workspaceRelativePathSchema)
      .max(MAX_MCP_INTEGRITY_FILES)
      .optional(),
    startup_timeout_ms: z.number().int().min(100).max(120_000),
    transport: z.literal("stdio"),
  })
  .strict()
  .superRefine((server, context) => {
    const argumentBytes = server.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    );
    if (argumentBytes > MAX_MCP_ARG_BYTES) {
      context.addIssue({
        code: "custom",
        message: `argument bytes must not exceed ${MAX_MCP_ARG_BYTES}`,
        path: ["args"],
      });
    }
    for (const argument of server.args) {
      const normalized = argument.replaceAll("\\", "/");
      const normalizedPath = normalized.startsWith("-")
        ? normalized
        : pathPosix.normalize(normalized);
      if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        (!normalized.startsWith("-") &&
          (normalizedPath === ".." || normalizedPath.startsWith("../")))
      ) {
        context.addIssue({
          code: "custom",
          message: "relative argument path must not escape cwd",
          path: ["args"],
        });
      }
    }
    const sources = server.env.map(({ source }) => source);
    const targets = server.env.map(({ target }) => target.toUpperCase());
    if (new Set(sources).size !== sources.length) {
      context.addIssue({ code: "custom", message: "env sources must be unique", path: ["env"] });
    }
    if (new Set(targets).size !== targets.length) {
      context.addIssue({ code: "custom", message: "env targets must be unique", path: ["env"] });
    }
    const integrityFiles = server.integrity_files ?? [];
    if (new Set(integrityFiles).size !== integrityFiles.length) {
      context.addIssue({
        code: "custom",
        message: "integrity_files must be unique",
        path: ["integrity_files"],
      });
    }
  });

export const mcpConfigSchema = z
  .object({
    servers: z.record(z.string(), mcpServerConfigSchema),
    version: z.literal(1),
  })
  .strict()
  .superRefine((config, context) => {
    const serverIds = Object.keys(config.servers);
    if (serverIds.length > MAX_MCP_SERVERS) {
      context.addIssue({
        code: "custom",
        message: `at most ${MAX_MCP_SERVERS} MCP servers may be configured`,
        path: ["servers"],
      });
    }
    for (const serverId of serverIds) {
      if (!serverIdSchema.safeParse(serverId).success) {
        context.addIssue({
          code: "custom",
          message: "invalid MCP server id",
          path: ["servers", serverId],
        });
      }
    }
  });

export type ParsedMcpConfig = z.infer<typeof mcpConfigSchema>;
export type ParsedMcpServerConfig = z.infer<typeof mcpServerConfigSchema>;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeConfigValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): void {
  if (depth > 16) {
    throw new McpCoreError("mcp_config_invalid", "MCP config nesting is too deep");
  }
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    throw new McpCoreError("mcp_config_invalid", "MCP config must not be cyclic");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new McpCoreError("mcp_config_invalid", "MCP config must contain plain JSON objects");
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw new McpCoreError("mcp_config_invalid", "MCP config contains an unsafe object key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new McpCoreError("mcp_config_invalid", "MCP config must not contain accessors");
    }
    assertSafeConfigValue(descriptor?.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

export function parseMcpConfig(value: unknown): ParsedMcpConfig {
  assertSafeConfigValue(value, new Set(), 0);
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "config";
    throw new McpCoreError(
      "mcp_config_invalid",
      `${path}: ${issue?.message ?? "invalid MCP config"}`,
    );
  }
  return parsed.data;
}
