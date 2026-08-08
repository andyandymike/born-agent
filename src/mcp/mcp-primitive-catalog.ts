import { Buffer } from "node:buffer";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { McpCoreError } from "./mcp-errors.js";
import type {
  StdioMcpPromptDescription,
  StdioMcpResourceDescription,
} from "./stdio-mcp-client.js";

export interface FrozenMcpResource {
  readonly catalogGenerationSha256: string;
  readonly description?: string;
  readonly itemSha256: string;
  readonly mimeType?: string;
  readonly name: string;
  readonly processIdentitySha256: string;
  readonly resourceId: string;
  readonly serverId: string;
  readonly size?: number;
  readonly title?: string;
  readonly uri: string;
}

export interface FrozenMcpResourceCatalog {
  readonly catalogGenerationSha256: string;
  readonly catalogSha256: string;
  readonly processIdentitySha256: string;
  readonly resources: readonly FrozenMcpResource[];
  readonly serverId: string;
}

export interface FrozenMcpPromptArgument {
  readonly description?: string;
  readonly name: string;
  readonly required: boolean;
}

export interface FrozenMcpPrompt {
  readonly arguments: readonly FrozenMcpPromptArgument[];
  readonly catalogGenerationSha256: string;
  readonly description?: string;
  readonly itemSha256: string;
  readonly name: string;
  readonly processIdentitySha256: string;
  readonly promptId: string;
  readonly serverId: string;
  readonly title?: string;
}

export interface FrozenMcpPromptCatalog {
  readonly catalogGenerationSha256: string;
  readonly catalogSha256: string;
  readonly processIdentitySha256: string;
  readonly prompts: readonly FrozenMcpPrompt[];
  readonly serverId: string;
}

function bounded(value: string | undefined, maximum: number, label: string): void {
  if (
    value !== undefined &&
    (value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum)
  ) {
    throw new McpCoreError("mcp_catalog_invalid", `${label} is invalid`);
  }
}

function validateUri(value: string): void {
  bounded(value, 2048, "MCP resource URI");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new McpCoreError("mcp_catalog_invalid", "MCP resource URI must be absolute", { cause: error });
  }
  if (parsed.protocol.length < 2) {
    throw new McpCoreError("mcp_catalog_invalid", "MCP resource URI has no scheme");
  }
}

export function freezeMcpResourceCatalog(input: {
  readonly negotiationSha256: string;
  readonly processIdentitySha256: string;
  readonly resources: readonly StdioMcpResourceDescription[];
  readonly serverId: string;
}): FrozenMcpResourceCatalog {
  if (input.resources.length > 256) {
    throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource catalog exceeds 256 items");
  }
  const normalized = input.resources.map((resource) => {
    validateUri(resource.uri);
    bounded(resource.name, 512, "MCP resource name");
    bounded(resource.description, 4096, "MCP resource description");
    bounded(resource.mimeType, 256, "MCP resource MIME type");
    bounded(resource.title, 512, "MCP resource title");
    if (resource.name.length === 0 || (resource.size !== undefined && (!Number.isSafeInteger(resource.size) || resource.size < 0))) {
      throw new McpCoreError("mcp_catalog_invalid", "MCP resource metadata is invalid");
    }
    return Object.freeze({
      ...(resource.description === undefined ? {} : { description: resource.description }),
      ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
      name: resource.name,
      ...(resource.size === undefined ? {} : { size: resource.size }),
      ...(resource.title === undefined ? {} : { title: resource.title }),
      uri: resource.uri,
    });
  });
  if (new Set(normalized.map((resource) => resource.uri)).size !== normalized.length) {
    throw new McpCoreError("mcp_catalog_invalid", "MCP resource catalog contains duplicate URIs");
  }
  const catalogSha256 = sha256Canonical({ resources: normalized, schema_version: 1 });
  const catalogGenerationSha256 = sha256Canonical({
    catalog_sha256: catalogSha256,
    negotiation_sha256: input.negotiationSha256,
    process_identity_sha256: input.processIdentitySha256,
    server_id: input.serverId,
  });
  const resources = normalized.map((resource): FrozenMcpResource => {
    const itemSha256 = sha256Canonical(resource);
    return Object.freeze({
      ...resource,
      catalogGenerationSha256,
      itemSha256,
      processIdentitySha256: input.processIdentitySha256,
      resourceId: `mcp-resource:${sha256Canonical({
        catalog_generation_sha256: catalogGenerationSha256,
        item_sha256: itemSha256,
        process_identity_sha256: input.processIdentitySha256,
      })}`,
      serverId: input.serverId,
    });
  });
  return Object.freeze({
    catalogGenerationSha256,
    catalogSha256,
    processIdentitySha256: input.processIdentitySha256,
    resources: Object.freeze(resources),
    serverId: input.serverId,
  });
}

export function freezeMcpPromptCatalog(input: {
  readonly negotiationSha256: string;
  readonly processIdentitySha256: string;
  readonly prompts: readonly StdioMcpPromptDescription[];
  readonly serverId: string;
}): FrozenMcpPromptCatalog {
  if (input.prompts.length > 128) {
    throw new McpCoreError("mcp_catalog_invalid", "MCP prompt catalog exceeds 128 items");
  }
  const normalized = input.prompts.map((prompt) => {
    bounded(prompt.name, 512, "MCP prompt name");
    bounded(prompt.description, 4096, "MCP prompt description");
    bounded(prompt.title, 512, "MCP prompt title");
    if (prompt.name.length === 0 || (prompt.arguments?.length ?? 0) > 64) {
      throw new McpCoreError("mcp_catalog_invalid", "MCP prompt metadata is invalid");
    }
    const argumentsValue = (prompt.arguments ?? []).map((argument) => {
      bounded(argument.name, 128, "MCP prompt argument name");
      bounded(argument.description, 1024, "MCP prompt argument description");
      if (argument.name.length === 0) {
        throw new McpCoreError("mcp_catalog_invalid", "MCP prompt argument name is empty");
      }
      return Object.freeze({
        ...(argument.description === undefined ? {} : { description: argument.description }),
        name: argument.name,
        required: argument.required === true,
      });
    });
    if (new Set(argumentsValue.map((argument) => argument.name)).size !== argumentsValue.length) {
      throw new McpCoreError("mcp_catalog_invalid", "MCP prompt arguments are duplicated");
    }
    return Object.freeze({
      arguments: Object.freeze(argumentsValue),
      ...(prompt.description === undefined ? {} : { description: prompt.description }),
      name: prompt.name,
      ...(prompt.title === undefined ? {} : { title: prompt.title }),
    });
  });
  if (new Set(normalized.map((prompt) => prompt.name)).size !== normalized.length) {
    throw new McpCoreError("mcp_catalog_invalid", "MCP prompt names are duplicated");
  }
  const catalogSha256 = sha256Canonical({ prompts: normalized, schema_version: 1 });
  const catalogGenerationSha256 = sha256Canonical({
    catalog_sha256: catalogSha256,
    negotiation_sha256: input.negotiationSha256,
    process_identity_sha256: input.processIdentitySha256,
    server_id: input.serverId,
  });
  const prompts = normalized.map((prompt): FrozenMcpPrompt => {
    const itemSha256 = sha256Canonical(prompt);
    return Object.freeze({
      ...prompt,
      catalogGenerationSha256,
      itemSha256,
      processIdentitySha256: input.processIdentitySha256,
      promptId: `mcp-prompt:${sha256Canonical({
        catalog_generation_sha256: catalogGenerationSha256,
        item_sha256: itemSha256,
        process_identity_sha256: input.processIdentitySha256,
      })}`,
      serverId: input.serverId,
    });
  });
  return Object.freeze({
    catalogGenerationSha256,
    catalogSha256,
    processIdentitySha256: input.processIdentitySha256,
    prompts: Object.freeze(prompts),
    serverId: input.serverId,
  });
}

export function canonicalCatalogArtifact(value: FrozenMcpPromptCatalog | FrozenMcpResourceCatalog): string {
  return `${canonicalJson(value)}\n`;
}
