import { z } from "zod";

import type { DecodedRunEvent } from "../events/event-decoder-registry.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const mcpPrimitiveRunSummarySchema = z
  .object({
    promptGets: z.array(z.object({
      actionSha256: sha256,
      byteLength: z.number().int().nonnegative().nullable(),
      failureCode: z.string().min(1).max(128).nullable(),
      projectionArtifactId: artifactId.nullable(),
      promptId: z.string().min(1).max(128),
      rawArtifactId: artifactId.nullable(),
      serverId: z.string().min(1).max(32),
      status: z.enum(["requested", "completed", "failed"]),
      unsupportedContentCount: z.number().int().nonnegative().nullable(),
    }).strict()).max(256),
    resourceReads: z.array(z.object({
      actionSha256: sha256,
      byteLength: z.number().int().nonnegative().nullable(),
      failureCode: z.string().min(1).max(128).nullable(),
      projectionArtifactId: artifactId.nullable(),
      rawArtifactId: artifactId.nullable(),
      resourceId: z.string().min(1).max(128),
      serverId: z.string().min(1).max(32),
      status: z.enum(["requested", "completed", "failed"]),
      truncated: z.boolean().nullable(),
      unsupportedContentCount: z.number().int().nonnegative().nullable(),
    }).strict()).max(1024),
    servers: z.array(z.object({
      negotiationSha256: sha256,
      processIdentitySha256: sha256,
      promptCatalogCount: z.number().int().nonnegative().nullable(),
      promptCatalogStale: z.boolean(),
      protocolVersion: z.string().min(1).max(128),
      resourceCatalogCount: z.number().int().nonnegative().nullable(),
      resourceCatalogStale: z.boolean(),
      serverId: z.string().min(1).max(32),
    }).strict()).max(4),
  })
  .strict();

export type McpPrimitiveRunSummary = Readonly<z.infer<typeof mcpPrimitiveRunSummarySchema>>;

export function projectMcpPrimitiveRunSummary(
  events: readonly DecodedRunEvent[],
): McpPrimitiveRunSummary {
  const invocations = new Map(
    events
      .filter((event): event is Extract<DecodedRunEvent, { type: "mcp.prompt.user.invoked" }> => event.type === "mcp.prompt.user.invoked")
      .map((event) => [event.data.invocation_id, event]),
  );
  const servers = events
    .filter((event): event is Extract<DecodedRunEvent, { type: "mcp.server.negotiated" }> => event.type === "mcp.server.negotiated")
    .map((negotiated) => {
      const resourceCatalog = events.find((event) =>
        event.type === "mcp.resource.cataloged" &&
        event.data.server_id === negotiated.data.server_id &&
        event.data.process_identity_sha256 === negotiated.data.process_identity_sha256
      ) as Extract<DecodedRunEvent, { type: "mcp.resource.cataloged" }> | undefined;
      const promptCatalog = events.find((event) =>
        event.type === "mcp.prompt.cataloged" &&
        event.data.server_id === negotiated.data.server_id &&
        event.data.process_identity_sha256 === negotiated.data.process_identity_sha256
      ) as Extract<DecodedRunEvent, { type: "mcp.prompt.cataloged" }> | undefined;
      if (
        (negotiated.data.resources_supported && resourceCatalog === undefined) ||
        (negotiated.data.prompts_supported && promptCatalog === undefined)
      ) {
        throw new Error("negotiated MCP primitive is missing its frozen catalog");
      }
      return {
        negotiationSha256: negotiated.data.negotiation_sha256,
        processIdentitySha256: negotiated.data.process_identity_sha256,
        promptCatalogCount: promptCatalog?.data.count ?? null,
        promptCatalogStale: promptCatalog !== undefined && events.some((event) =>
          event.type === "mcp.prompt.catalog.stale" &&
          event.data.catalog_generation_sha256 === promptCatalog.data.catalog_generation_sha256
        ),
        protocolVersion: negotiated.data.protocol_version,
        resourceCatalogCount: resourceCatalog?.data.count ?? null,
        resourceCatalogStale: resourceCatalog !== undefined && events.some((event) =>
          event.type === "mcp.resource.catalog.stale" &&
          event.data.catalog_generation_sha256 === resourceCatalog.data.catalog_generation_sha256
        ),
        serverId: negotiated.data.server_id,
      };
    });
  if (new Set(servers.map((server) => `${server.serverId}:${server.processIdentitySha256}`)).size !== servers.length) {
    throw new Error("duplicate MCP negotiation identity");
  }

  const resourceReads = events
    .filter((event): event is Extract<DecodedRunEvent, { type: "mcp.resource.read.requested" }> => event.type === "mcp.resource.read.requested")
    .map((requested) => {
      const terminal = events.filter((event) =>
        (event.type === "mcp.resource.read.completed" || event.type === "mcp.resource.read.failed") &&
        event.data.action_sha256 === requested.data.action_sha256
      );
      if (terminal.length > 1) throw new Error("MCP resource action has multiple terminal events");
      const result = terminal[0];
      return {
        actionSha256: requested.data.action_sha256,
        byteLength: result?.type === "mcp.resource.read.completed" ? result.data.byte_length : null,
        failureCode: result?.type === "mcp.resource.read.failed" ? result.data.code : null,
        projectionArtifactId: result?.type === "mcp.resource.read.completed" ? result.data.projection_artifact_id ?? null : null,
        rawArtifactId: result?.type === "mcp.resource.read.completed" ? result.data.raw_artifact_id : null,
        resourceId: requested.data.resource_id,
        serverId: requested.data.server_id,
        status: result?.type === "mcp.resource.read.completed" ? "completed" as const : result?.type === "mcp.resource.read.failed" ? "failed" as const : "requested" as const,
        truncated: result?.type === "mcp.resource.read.completed" ? result.data.truncated : null,
        unsupportedContentCount: result?.type === "mcp.resource.read.completed" ? result.data.unsupported_content_count : null,
      };
    });

  const promptGets = events
    .filter((event): event is Extract<DecodedRunEvent, { type: "mcp.prompt.get.requested" }> => event.type === "mcp.prompt.get.requested")
    .map((requested) => {
      const invocation = invocations.get(requested.data.invocation_event_id);
      if (
        invocation === undefined ||
        invocation.sessionSeq >= requested.sessionSeq ||
        invocation.data.arguments_sha256 !== requested.data.arguments_sha256
      ) {
        throw new Error("MCP prompt get lacks a matching explicit-user invocation fact");
      }
      const terminal = events.filter((event) =>
        (event.type === "mcp.prompt.get.completed" || event.type === "mcp.prompt.get.failed") &&
        event.data.action_sha256 === requested.data.action_sha256
      );
      if (terminal.length > 1) throw new Error("MCP prompt action has multiple terminal events");
      const result = terminal[0];
      return {
        actionSha256: requested.data.action_sha256,
        byteLength: result?.type === "mcp.prompt.get.completed" ? result.data.byte_length : null,
        failureCode: result?.type === "mcp.prompt.get.failed" ? result.data.code : null,
        projectionArtifactId: result?.type === "mcp.prompt.get.completed" ? result.data.projection_artifact_id ?? null : null,
        promptId: requested.data.prompt_id,
        rawArtifactId: result?.type === "mcp.prompt.get.completed" ? result.data.raw_artifact_id : null,
        serverId: requested.data.server_id,
        status: result?.type === "mcp.prompt.get.completed" ? "completed" as const : result?.type === "mcp.prompt.get.failed" ? "failed" as const : "requested" as const,
        unsupportedContentCount: result?.type === "mcp.prompt.get.completed" ? result.data.unsupported_content_count : null,
      };
    });
  return mcpPrimitiveRunSummarySchema.parse({ promptGets, resourceReads, servers });
}
