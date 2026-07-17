import { createHash } from "node:crypto";

import { canonicalJson } from "../completion/canonical-json.js";
import type { McpIntegrityManifest } from "./mcp-integrity-manifest.js";
import { McpCoreError } from "./mcp-errors.js";

const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new McpCoreError("mcp_action_invalid", `${label} must be a lowercase SHA-256 digest`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpCoreError("mcp_action_invalid", `${label} must be a positive integer`);
  }
}

export interface McpExecutableIdentity {
  readonly bytesSha256: string;
  readonly canonicalIdentitySha256: string;
  readonly logicalName: string;
  readonly versionIdentity: string;
}

export interface McpServerStartActionInput {
  readonly args: readonly string[];
  readonly canonicalCwd: string;
  readonly configSha256: string;
  readonly env: readonly Readonly<{ source: string; target: string }>[];
  readonly environmentPolicyVersion: string;
  readonly executable: McpExecutableIdentity;
  readonly integrityManifest: McpIntegrityManifest;
  readonly serverId: string;
  readonly startupTimeoutMs: number;
}

export interface McpServerStartActionIdentity {
  readonly actionKind: "mcp.server.start";
  readonly actionSha256: string;
  readonly argv: readonly string[];
  readonly canonicalCwd: string;
  readonly configSha256: string;
  readonly envMappingSha256: string;
  readonly environmentPolicyVersion: string;
  readonly executableIdentitySha256: string;
  readonly integrityBinding: "explicit" | "not_bound";
  readonly integrityManifestSha256: string;
  readonly serverId: string;
  readonly startupTimeoutMs: number;
}

export function createMcpServerStartActionIdentity(
  input: McpServerStartActionInput,
): McpServerStartActionIdentity {
  // PHASE12: an exact approval digest and shell-free argv prevent substitution;
  // they do not sandbox the host process that will receive the user's authority.
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(input.serverId)) {
    throw new McpCoreError("mcp_action_invalid", "invalid MCP server id");
  }
  for (const [label, value] of [
    ["canonicalCwd", input.canonicalCwd],
    ["environmentPolicyVersion", input.environmentPolicyVersion],
    ["executable.logicalName", input.executable.logicalName],
    ["executable.versionIdentity", input.executable.versionIdentity],
  ] as const) {
    if (value.length === 0 || value.includes("\0")) {
      throw new McpCoreError("mcp_action_invalid", `${label} must be nonempty and NUL-free`);
    }
  }
  requireSha256(input.configSha256, "configSha256");
  requireSha256(input.executable.bytesSha256, "executable.bytesSha256");
  requireSha256(
    input.executable.canonicalIdentitySha256,
    "executable.canonicalIdentitySha256",
  );
  requireSha256(input.integrityManifest.manifestSha256, "integrityManifestSha256");
  requirePositiveInteger(input.startupTimeoutMs, "startupTimeoutMs");
  const argv = [input.executable.logicalName, ...input.args];
  if (
    argv.length > 65 ||
    argv.some((argument) => argument.includes("\0")) ||
    input.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    ) >
      16 * 1024
  ) {
    throw new McpCoreError("mcp_action_invalid", "MCP argv is invalid");
  }
  const env = input.env
    .map(({ source, target }) => ({ source, target }))
    .sort((left, right) => `${left.target}\0${left.source}`.localeCompare(`${right.target}\0${right.source}`));
  const envMappingSha256 = sha256(canonicalJson(env));
  const executableIdentitySha256 = sha256(
    canonicalJson({
      bytes_sha256: input.executable.bytesSha256,
      canonical_identity_sha256: input.executable.canonicalIdentitySha256,
      logical_name: input.executable.logicalName,
      version_identity: input.executable.versionIdentity,
    }),
  );
  const normalized = {
    action_kind: "mcp.server.start",
    argv,
    canonical_cwd: input.canonicalCwd,
    config_sha256: input.configSha256,
    env_mapping_sha256: envMappingSha256,
    environment_policy_version: input.environmentPolicyVersion,
    executable_identity_sha256: executableIdentitySha256,
    integrity_binding: input.integrityManifest.binding,
    integrity_manifest_sha256: input.integrityManifest.manifestSha256,
    server_id: input.serverId,
    startup_timeout_ms: input.startupTimeoutMs,
  } as const;
  return Object.freeze({
    actionKind: "mcp.server.start",
    actionSha256: sha256(canonicalJson(normalized)),
    argv: Object.freeze(argv),
    canonicalCwd: input.canonicalCwd,
    configSha256: input.configSha256,
    envMappingSha256,
    environmentPolicyVersion: input.environmentPolicyVersion,
    executableIdentitySha256,
    integrityBinding: input.integrityManifest.binding,
    integrityManifestSha256: input.integrityManifest.manifestSha256,
    serverId: input.serverId,
    startupTimeoutMs: input.startupTimeoutMs,
  });
}

export interface McpToolCallActionInput {
  readonly argumentsValue: unknown;
  readonly callTimeoutMs: number;
  readonly catalogSha256: string;
  readonly configSha256: string;
  readonly modelToolName: string;
  readonly processIdentitySha256: string;
  readonly rawToolName: string;
  readonly schemaSha256: string;
  readonly serverId: string;
}

export interface McpToolCallActionIdentity {
  readonly actionKind: "mcp.tool.call";
  readonly actionSha256: string;
  readonly argumentsJson: string;
  readonly argumentsSha256: string;
  readonly callTimeoutMs: number;
  readonly catalogSha256: string;
  readonly configSha256: string;
  readonly modelToolName: string;
  readonly processIdentitySha256: string;
  readonly rawToolName: string;
  readonly schemaSha256: string;
  readonly serverId: string;
}

export type McpPermissionActionIdentity =
  | McpServerStartActionIdentity
  | McpToolCallActionIdentity;

function computeMcpServerStartActionSha256(
  action: Omit<McpServerStartActionIdentity, "actionSha256">,
): string {
  return sha256(
    canonicalJson({
      action_kind: action.actionKind,
      argv: action.argv,
      canonical_cwd: action.canonicalCwd,
      config_sha256: action.configSha256,
      env_mapping_sha256: action.envMappingSha256,
      environment_policy_version: action.environmentPolicyVersion,
      executable_identity_sha256: action.executableIdentitySha256,
      integrity_binding: action.integrityBinding,
      integrity_manifest_sha256: action.integrityManifestSha256,
      server_id: action.serverId,
      startup_timeout_ms: action.startupTimeoutMs,
    }),
  );
}

function computeMcpToolCallActionSha256(
  action: Omit<McpToolCallActionIdentity, "actionSha256" | "argumentsJson">,
): string {
  return sha256(
    canonicalJson({
      action_kind: action.actionKind,
      arguments_sha256: action.argumentsSha256,
      call_timeout_ms: action.callTimeoutMs,
      catalog_sha256: action.catalogSha256,
      config_sha256: action.configSha256,
      model_tool_name: action.modelToolName,
      process_identity_sha256: action.processIdentitySha256,
      raw_tool_name: action.rawToolName,
      schema_sha256: action.schemaSha256,
      server_id: action.serverId,
    }),
  );
}

export function verifyMcpPermissionActionIdentity(
  action: McpPermissionActionIdentity,
): boolean {
  if (action.actionKind === "mcp.server.start") {
    return (
      SHA256.test(action.actionSha256) &&
      SHA256.test(action.configSha256) &&
      SHA256.test(action.envMappingSha256) &&
      SHA256.test(action.executableIdentitySha256) &&
      SHA256.test(action.integrityManifestSha256) &&
      computeMcpServerStartActionSha256(action) === action.actionSha256
    );
  }
  return (
    SHA256.test(action.actionSha256) &&
    SHA256.test(action.argumentsSha256) &&
    SHA256.test(action.catalogSha256) &&
    SHA256.test(action.configSha256) &&
    SHA256.test(action.processIdentitySha256) &&
    SHA256.test(action.schemaSha256) &&
    sha256(action.argumentsJson) === action.argumentsSha256 &&
    computeMcpToolCallActionSha256(action) === action.actionSha256
  );
}

export function createMcpToolCallActionIdentity(
  input: McpToolCallActionInput,
): McpToolCallActionIdentity {
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(input.serverId) ||
    input.rawToolName.length === 0 ||
    input.modelToolName.length === 0 ||
    input.rawToolName.includes("\0") ||
    input.modelToolName.includes("\0")
  ) {
    throw new McpCoreError("mcp_action_invalid", "invalid MCP call tool identity");
  }
  for (const [label, value] of [
    ["catalogSha256", input.catalogSha256],
    ["configSha256", input.configSha256],
    ["processIdentitySha256", input.processIdentitySha256],
    ["schemaSha256", input.schemaSha256],
  ] as const) {
    requireSha256(value, label);
  }
  requirePositiveInteger(input.callTimeoutMs, "callTimeoutMs");
  let argumentsJson: string;
  try {
    argumentsJson = canonicalJson(input.argumentsValue);
  } catch (error) {
    throw new McpCoreError("mcp_action_invalid", "MCP arguments are not canonical JSON", { cause: error });
  }
  const argumentsSha256 = sha256(argumentsJson);
  const normalized = {
    action_kind: "mcp.tool.call",
    arguments_sha256: argumentsSha256,
    call_timeout_ms: input.callTimeoutMs,
    catalog_sha256: input.catalogSha256,
    config_sha256: input.configSha256,
    model_tool_name: input.modelToolName,
    process_identity_sha256: input.processIdentitySha256,
    raw_tool_name: input.rawToolName,
    schema_sha256: input.schemaSha256,
    server_id: input.serverId,
  } as const;
  return Object.freeze({
    actionKind: "mcp.tool.call",
    actionSha256: sha256(canonicalJson(normalized)),
    argumentsJson,
    argumentsSha256,
    callTimeoutMs: input.callTimeoutMs,
    catalogSha256: input.catalogSha256,
    configSha256: input.configSha256,
    modelToolName: input.modelToolName,
    processIdentitySha256: input.processIdentitySha256,
    rawToolName: input.rawToolName,
    schemaSha256: input.schemaSha256,
    serverId: input.serverId,
  });
}
