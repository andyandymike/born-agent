import { createHash } from "node:crypto";

import { sha256Canonical } from "../completion/canonical-json.js";
import { McpCoreError } from "./mcp-errors.js";
import type { StdioMcpNegotiation } from "./stdio-mcp-client.js";

export interface FrozenMcpServerNegotiation {
  readonly instructionsSha256?: string;
  readonly negotiationSha256: string;
  readonly processIdentitySha256: string;
  readonly prompts: { readonly listChanged: boolean; readonly supported: boolean };
  readonly protocolVersion: string;
  readonly resources: {
    readonly listChanged: boolean;
    readonly subscribe: boolean;
    readonly supported: boolean;
  };
  readonly serverIdentitySha256: string;
  readonly serverName: string;
  readonly serverVersion?: string;
  readonly tools: { readonly listChanged: boolean; readonly supported: boolean };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function flags(value: unknown): { readonly listChanged: boolean; readonly supported: boolean } {
  const candidate = record(value);
  return Object.freeze({
    listChanged: candidate?.listChanged === true,
    supported: candidate !== null,
  });
}

export function freezeMcpServerNegotiation(input: {
  readonly configSha256: string;
  readonly processIdentitySha256: string;
  readonly raw: StdioMcpNegotiation;
  readonly serverId: string;
}): FrozenMcpServerNegotiation {
  if (
    Buffer.byteLength(input.raw.protocolVersion, "utf8") > 128 ||
    Buffer.byteLength(input.raw.serverName, "utf8") > 256 ||
    Buffer.byteLength(input.raw.serverVersion ?? "", "utf8") > 256 ||
    Buffer.byteLength(input.raw.instructions ?? "", "utf8") > 64 * 1024 ||
    [input.raw.protocolVersion, input.raw.serverName, input.raw.serverVersion ?? ""]
      .some((value) => value.length === 0 || value.includes("\0"))
  ) {
    throw new McpCoreError("mcp_protocol_failed", "MCP initialize metadata is invalid");
  }
  const tools = flags(input.raw.capabilities.tools);
  const resourceFlags = flags(input.raw.capabilities.resources);
  const promptFlags = flags(input.raw.capabilities.prompts);
  const normalized = {
    config_sha256: input.configSha256,
    ...(input.raw.instructions === undefined
      ? {}
      : { instructions_sha256: sha256(input.raw.instructions) }),
    process_identity_sha256: input.processIdentitySha256,
    prompts: promptFlags,
    protocol_version: input.raw.protocolVersion,
    resources: {
      ...resourceFlags,
      subscribe: record(input.raw.capabilities.resources)?.subscribe === true,
    },
    server_id: input.serverId,
    server_name: input.raw.serverName,
    ...(input.raw.serverVersion === undefined
      ? {}
      : { server_version: input.raw.serverVersion }),
    tools,
  } as const;
  const serverIdentitySha256 = sha256Canonical({
    config_sha256: input.configSha256,
    process_identity_sha256: input.processIdentitySha256,
    server_id: input.serverId,
    server_name: input.raw.serverName,
    server_version: input.raw.serverVersion ?? null,
  });
  return Object.freeze({
    ...(input.raw.instructions === undefined
      ? {}
      : { instructionsSha256: sha256(input.raw.instructions) }),
    negotiationSha256: sha256Canonical(normalized),
    processIdentitySha256: input.processIdentitySha256,
    prompts: promptFlags,
    protocolVersion: input.raw.protocolVersion,
    resources: normalized.resources,
    serverIdentitySha256,
    serverName: input.raw.serverName,
    ...(input.raw.serverVersion === undefined
      ? {}
      : { serverVersion: input.raw.serverVersion }),
    tools,
  });
}

export function requireMcpPrimitive(
  negotiation: FrozenMcpServerNegotiation,
  primitive: "prompts" | "resources" | "tools",
): void {
  // PHASE18: SDK support is necessary but not sufficient. The server's frozen
  // initialize declaration is the authority for which primitive may be called.
  if (!negotiation[primitive].supported) {
    throw new McpCoreError(
      "mcp_capability_not_negotiated",
      `MCP server did not negotiate ${primitive}`,
    );
  }
}
