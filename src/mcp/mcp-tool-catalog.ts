import { createHash } from "node:crypto";

import { canonicalJson } from "../completion/canonical-json.js";
import { sanitizeTerminalText } from "../tui/terminal-sanitizer.js";
import type { GuardedMcpSchema } from "./mcp-schema-guard.js";
import { MAX_MCP_DESCRIPTION_BYTES } from "./mcp-schema-guard.js";
import { McpCoreError } from "./mcp-errors.js";
import { mapMcpToolNames } from "./mcp-tool-name-mapper.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface DiscoveredMcpTool {
  readonly description?: string;
  readonly rawName: string;
  readonly schema: GuardedMcpSchema;
}

export interface FrozenMcpTool {
  readonly description: string;
  readonly descriptionSha256: string;
  readonly modelName: string;
  readonly rawName: string;
  readonly schema: GuardedMcpSchema;
}

export interface FrozenMcpCatalog {
  readonly catalogSha256: string;
  readonly serverId: string;
  readonly serverIdentitySha256: string;
  readonly tools: readonly FrozenMcpTool[];
}

export interface McpCatalogState {
  readonly callsBlocked: boolean;
  readonly catalog: FrozenMcpCatalog;
  readonly changedCatalogSha256: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function externalDescription(serverId: string, description: string | undefined): string {
  const raw = description ?? "";
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_DESCRIPTION_BYTES) {
    throw new McpCoreError("mcp_schema_limit", "MCP tool description exceeds 4 KiB");
  }
  const sanitized = sanitizeTerminalText(raw);
  return `[External MCP server ${serverId}; untrusted description]${sanitized.length > 0 ? ` ${sanitized}` : ""}`;
}

export function freezeMcpCatalog(input: {
  readonly reservedModelNames?: readonly string[];
  readonly serverId: string;
  readonly serverIdentitySha256: string;
  readonly tools: readonly DiscoveredMcpTool[];
}): FrozenMcpCatalog {
  if (!SHA256.test(input.serverIdentitySha256)) {
    throw new McpCoreError("mcp_action_invalid", "invalid MCP server identity hash");
  }
  const mappings = mapMcpToolNames(
    input.serverId,
    input.tools.map(({ rawName }) => rawName),
    input.reservedModelNames,
  );
  const byRaw = new Map(input.tools.map((tool) => [tool.rawName, tool]));
  const tools = mappings.map((mapping): FrozenMcpTool => {
    const discovered = byRaw.get(mapping.rawName)!;
    const description = externalDescription(input.serverId, discovered.description);
    return Object.freeze({
      description,
      descriptionSha256: sha256(description),
      modelName: mapping.modelName,
      rawName: mapping.rawName,
      schema: discovered.schema,
    });
  });
  const catalogSha256 = sha256(
    canonicalJson({
      server_identity_sha256: input.serverIdentitySha256,
      server_id: input.serverId,
      tools: tools.map((tool) => ({
        description_sha256: tool.descriptionSha256,
        model_name: tool.modelName,
        raw_name: tool.rawName,
        schema_sha256: tool.schema.schemaSha256,
        strict_for_model: tool.schema.strictForModel,
      })),
    }),
  );
  // PHASE12: discovery only freezes model-visible definitions. It never grants
  // start or per-call authority, regardless of server-supplied annotations.
  return Object.freeze({
    catalogSha256,
    serverId: input.serverId,
    serverIdentitySha256: input.serverIdentitySha256,
    tools: Object.freeze(tools),
  });
}

export function createMcpCatalogState(catalog: FrozenMcpCatalog): McpCatalogState {
  return Object.freeze({ callsBlocked: false, catalog, changedCatalogSha256: null });
}

export function observeMcpCatalog(
  state: McpCatalogState,
  current: FrozenMcpCatalog,
): McpCatalogState {
  if (state.catalog.catalogSha256 === current.catalogSha256) return state;
  return Object.freeze({
    callsBlocked: true,
    catalog: state.catalog,
    changedCatalogSha256: current.catalogSha256,
  });
}

export function requireFrozenMcpTool(
  state: McpCatalogState,
  modelName: string,
): FrozenMcpTool {
  if (state.callsBlocked) {
    throw new McpCoreError("mcp_catalog_changed", "MCP catalog changed; a new run is required");
  }
  const tool = state.catalog.tools.find((candidate) => candidate.modelName === modelName);
  if (tool === undefined) {
    throw new McpCoreError("mcp_tool_name_invalid", "unknown frozen MCP tool name");
  }
  return tool;
}
