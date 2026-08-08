import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import {
  MAX_MCP_CONFIG_BYTES,
  parseMcpConfig,
} from "./mcp-config-schema.js";
import type { ParsedMcpServerConfig } from "./mcp-config-schema.js";
import { McpCoreError } from "./mcp-errors.js";

export interface McpPathMetadata {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly size: number;
}

export interface McpConfigFileSystem {
  lstat(filePath: string): Promise<McpPathMetadata>;
  readFile(filePath: string): Promise<Uint8Array>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<McpPathMetadata>;
}

const nodeFileSystem: McpConfigFileSystem = { lstat, readFile, realpath, stat };

export interface LoadedMcpServerConfig {
  readonly args: readonly string[];
  readonly callTimeoutMs: number;
  readonly canonicalCwd: string;
  readonly configSha256: string;
  readonly env: readonly Readonly<{ source: string; target: string }>[];
  readonly executable: string;
  readonly executionCwd?: string;
  readonly integrityRoot?: string;
  readonly integrityFiles: readonly string[];
  readonly origin?: "capability_snapshot" | "workspace_config";
  readonly spawnArgs?: readonly string[];
  readonly revalidate?: () => Promise<void>;
  readonly serverId: string;
  readonly startupTimeoutMs: number;
  readonly transport: "stdio";
}

export type McpConfigLoadResult =
  | {
      readonly configFileSha256: string;
      readonly servers: Readonly<Record<string, LoadedMcpServerConfig>>;
      readonly status: "loaded";
      readonly workspaceRealPath: string;
    }
  | { readonly status: "missing" };

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new McpCoreError("mcp_config_path_unsafe", "MCP path escapes the workspace");
  }
  return normalized === "" ? "." : normalized;
}

async function assertNoSymlinkComponents(
  fileSystem: McpConfigFileSystem,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new McpCoreError("mcp_config_path_unsafe", "MCP path escapes the workspace");
  }
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const metadata = await fileSystem.lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new McpCoreError("mcp_config_path_unsafe", "MCP path must not contain a symlink or junction");
    }
  }
}

function freezeServer(
  serverId: string,
  server: ParsedMcpServerConfig,
  canonicalCwd: string,
): LoadedMcpServerConfig {
  const normalized = {
    args: [...server.args],
    call_timeout_ms: server.call_timeout_ms,
    cwd: canonicalCwd,
    env: server.env
      .map(({ source, target }) => ({ source, target }))
      .sort((left, right) =>
        `${left.target}\0${left.source}`.localeCompare(`${right.target}\0${right.source}`),
      ),
    executable: server.executable,
    integrity_files: [...(server.integrity_files ?? [])].sort(),
    server_id: serverId,
    startup_timeout_ms: server.startup_timeout_ms,
    transport: server.transport,
  } as const;
  return Object.freeze({
    args: Object.freeze(normalized.args),
    callTimeoutMs: normalized.call_timeout_ms,
    canonicalCwd,
    configSha256: sha256Canonical(normalized),
    env: Object.freeze(normalized.env.map((mapping) => Object.freeze(mapping))),
    executable: normalized.executable,
    integrityFiles: Object.freeze(normalized.integrity_files),
    serverId,
    startupTimeoutMs: normalized.startup_timeout_ms,
    transport: "stdio",
    origin: "workspace_config",
  });
}

export class McpConfigLoader {
  public constructor(
    private readonly options: {
      readonly fileSystem?: McpConfigFileSystem;
      readonly workspace: string;
    },
  ) {}

  public async load(): Promise<McpConfigLoadResult> {
    const fileSystem = this.options.fileSystem ?? nodeFileSystem;
    const workspaceRealPath = await fileSystem.realpath(this.options.workspace);
    const configPath = path.join(workspaceRealPath, ".bornagent", "mcp.json");
    let configMetadata: McpPathMetadata;
    try {
      configMetadata = await fileSystem.lstat(configPath);
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      throw error;
    }
    await assertNoSymlinkComponents(fileSystem, workspaceRealPath, configPath);
    if (!configMetadata.isFile()) {
      throw new McpCoreError("mcp_config_path_unsafe", "MCP config must be a regular file");
    }
    if (configMetadata.size > MAX_MCP_CONFIG_BYTES) {
      throw new McpCoreError("mcp_config_too_large", "MCP config exceeds its byte limit");
    }
    const configRealPath = await fileSystem.realpath(configPath);
    if (!isInside(workspaceRealPath, configRealPath)) {
      throw new McpCoreError("mcp_config_path_unsafe", "MCP config resolves outside the workspace");
    }
    const bytes = await fileSystem.readFile(configRealPath);
    if (bytes.byteLength > MAX_MCP_CONFIG_BYTES) {
      throw new McpCoreError("mcp_config_too_large", "MCP config exceeds its byte limit");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (error) {
      throw new McpCoreError("mcp_config_invalid", "MCP config is not valid JSON", { cause: error });
    }
    const parsed = parseMcpConfig(decoded);
    const servers: Record<string, LoadedMcpServerConfig> = Object.create(null) as Record<string, LoadedMcpServerConfig>;
    for (const serverId of Object.keys(parsed.servers).sort()) {
      const server = parsed.servers[serverId]!;
      const canonicalCwd = normalizedRelativePath(server.cwd);
      const cwdCandidate = path.resolve(workspaceRealPath, canonicalCwd);
      await assertNoSymlinkComponents(fileSystem, workspaceRealPath, cwdCandidate);
      const cwdRealPath = await fileSystem.realpath(cwdCandidate);
      if (!isInside(workspaceRealPath, cwdRealPath)) {
        throw new McpCoreError("mcp_config_path_unsafe", "MCP cwd resolves outside the workspace");
      }
      const cwdMetadata = await fileSystem.stat(cwdRealPath);
      if (!cwdMetadata.isDirectory()) {
        throw new McpCoreError("mcp_config_path_unsafe", "MCP cwd must be an existing directory");
      }
      servers[serverId] = freezeServer(serverId, server, canonicalCwd);
    }

    return Object.freeze({
      configFileSha256: createHash("sha256").update(bytes).digest("hex"),
      servers: Object.freeze(servers),
      status: "loaded",
      workspaceRealPath,
    });
  }
}

export function canonicalMcpServerConfigJson(server: LoadedMcpServerConfig): string {
  return canonicalJson({
    args: server.args,
    call_timeout_ms: server.callTimeoutMs,
    cwd: server.canonicalCwd,
    env: server.env,
    executable: server.executable,
    integrity_files: server.integrityFiles,
    server_id: server.serverId,
    startup_timeout_ms: server.startupTimeoutMs,
    transport: server.transport,
  });
}
