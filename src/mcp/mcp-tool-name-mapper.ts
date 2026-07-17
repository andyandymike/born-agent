import { createHash } from "node:crypto";

import { McpCoreError } from "./mcp-errors.js";

export const MAX_MODEL_TOOL_NAME_CHARS = 64;

export interface McpToolNameMapping {
  readonly modelName: string;
  readonly rawName: string;
  readonly serverId: string;
}

function shortHash(serverId: string, rawName: string): string {
  return createHash("sha256")
    .update(`${serverId}\0${rawName}`, "utf8")
    .digest("hex")
    .slice(0, 8);
}

function encodeSlug(rawName: string): { readonly changed: boolean; readonly slug: string } {
  const normalized = rawName.normalize("NFKC").toLowerCase();
  let slug = "";
  for (const character of normalized) {
    if (/^[a-z0-9]$/u.test(character)) slug += character;
    else if (character === "_" || character === "-") slug += "_";
    else slug += `_u${character.codePointAt(0)!.toString(16)}_`;
  }
  slug = slug.replaceAll(/_+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  if (slug.length === 0) slug = "tool";
  if (!/^[a-z]/u.test(slug)) slug = `tool_${slug}`;
  return { changed: normalized !== rawName || slug !== rawName, slug };
}

export function mapMcpToolName(serverId: string, rawName: string): McpToolNameMapping {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(serverId)) {
    throw new McpCoreError("mcp_tool_name_invalid", "invalid MCP server id");
  }
  if (
    rawName.length === 0 ||
    Buffer.byteLength(rawName, "utf8") > 512 ||
    rawName.includes("\0") ||
    [...rawName].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new McpCoreError("mcp_tool_name_invalid", "invalid raw MCP tool name");
  }
  const serverSlug = serverId.replaceAll("-", "_");
  const prefix = `mcp__${serverSlug}__`;
  const encoded = encodeSlug(rawName);
  let suffix = encoded.slug;
  let needsHash = encoded.changed || prefix.length + suffix.length > MAX_MODEL_TOOL_NAME_CHARS;
  if (needsHash) {
    const hashSuffix = `_${shortHash(serverId, rawName)}`;
    const available = MAX_MODEL_TOOL_NAME_CHARS - prefix.length - hashSuffix.length;
    if (available < 1) {
      throw new McpCoreError("mcp_tool_name_invalid", "MCP server id leaves no room for a tool slug");
    }
    suffix = `${suffix.slice(0, available).replaceAll(/_+$/gu, "") || "t"}${hashSuffix}`;
  }
  let modelName = `${prefix}${suffix}`;
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(modelName)) {
    needsHash = true;
    const hashSuffix = `_${shortHash(serverId, rawName)}`;
    const available = MAX_MODEL_TOOL_NAME_CHARS - prefix.length - hashSuffix.length;
    modelName = `${prefix}${suffix.slice(0, available)}${hashSuffix}`;
  }
  if (!needsHash && modelName.length > MAX_MODEL_TOOL_NAME_CHARS) {
    throw new McpCoreError("mcp_tool_name_invalid", "mapped MCP tool name is too long");
  }
  // PHASE12: origin and collision mapping is deterministic so a raw server
  // name can never silently replace a built-in or another server's authority.
  return Object.freeze({ modelName, rawName, serverId });
}

export function mapMcpToolNames(
  serverId: string,
  rawNames: readonly string[],
  reservedModelNames: readonly string[] = [],
): readonly McpToolNameMapping[] {
  if (new Set(rawNames).size !== rawNames.length) {
    throw new McpCoreError("mcp_catalog_collision", "duplicate raw MCP tool name");
  }
  const occupied = new Set(reservedModelNames);
  const mappings = rawNames
    .map((rawName) => mapMcpToolName(serverId, rawName))
    .sort((left, right) => left.rawName.localeCompare(right.rawName));
  for (const mapping of mappings) {
    if (occupied.has(mapping.modelName)) {
      throw new McpCoreError("mcp_catalog_collision", `MCP model tool name collision: ${mapping.modelName}`);
    }
    occupied.add(mapping.modelName);
  }
  return Object.freeze(mappings);
}
