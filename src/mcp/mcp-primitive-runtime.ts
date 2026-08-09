import { createHash } from "node:crypto";

import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { ArtifactStoredReference } from "../artifacts/artifact-types.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type {
  ContextArtifactReference,
  ContextItemInput,
  ContextJson,
} from "../context/context-item.js";
import type { PermissionEngineLike } from "../permissions/permission-types.js";
import { redactSensitiveText } from "../security/redact.js";
import type { ToolContext } from "../tools/tool-types.js";
import {
  createMcpPromptGetActionIdentity,
  createMcpResourceReadActionIdentity,
} from "./mcp-action-identity.js";
import { McpApprovalGate, type McpEventAppender } from "./mcp-approval-gate.js";
import {
  freezeMcpServerNegotiation,
  requireMcpPrimitive,
  type FrozenMcpServerNegotiation,
} from "./mcp-capability-negotiation.js";
import { McpCoreError } from "./mcp-errors.js";
import {
  canonicalCatalogArtifact,
  freezeMcpPromptCatalog,
  freezeMcpResourceCatalog,
  type FrozenMcpPrompt,
  type FrozenMcpPromptCatalog,
  type FrozenMcpResource,
  type FrozenMcpResourceCatalog,
} from "./mcp-primitive-catalog.js";
import type { StartedMcpServer } from "./mcp-server-launcher.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { EffectHookPipeline } from "../hooks/hook-pipeline.js";

const MAX_RESOURCE_RAW_BYTES = 1024 * 1024;
const MAX_RESOURCE_PROJECTION_BYTES = 256 * 1024;
const MAX_PROMPT_RAW_BYTES = 256 * 1024;

interface PrimitiveBinding {
  readonly negotiation: FrozenMcpServerNegotiation;
  promptCatalog?: FrozenMcpPromptCatalog;
  promptStale: boolean;
  resourceCatalog?: FrozenMcpResourceCatalog;
  resourceStale: boolean;
  readonly server: StartedMcpServer;
  staleTask: Promise<void> | null;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactReference(artifact: ArtifactStoredReference): ContextArtifactReference {
  return Object.freeze({
    artifactId: artifact.artifactId,
    bytes: artifact.bytes,
    mediaType: artifact.mediaType,
    relativeRef: artifact.objectRef,
    sha256: artifact.sha256,
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpCoreError("mcp_resource_content_invalid", "MCP response must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function validUnicode(value: string): boolean {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) === value;
}

function utf8Prefix(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function displayUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol === "file:") return "file://[redacted-local-path]";
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return utf8Prefix(parsed.toString(), 256);
}

async function materialize(
  artifacts: ArtifactSessionRuntimeLike | undefined,
  content: string,
  originEventId: string,
): Promise<ArtifactStoredReference | undefined> {
  if (artifacts === undefined) return undefined;
  const bytes = Buffer.from(content, "utf8");
  return artifacts.materializeText({
    bytes,
    expectedSha256: sha256(bytes),
    mediaType: "text/plain; charset=utf-8",
    originEventId,
  });
}

function parseResourceContent(raw: unknown, uri: string, maximumProjectionBytes: number) {
  const response = record(raw);
  if (!Array.isArray(response.contents) || response.contents.length > 16) {
    throw new McpCoreError("mcp_resource_content_invalid", "MCP resource contents must contain at most 16 parts");
  }
  let decodedBytes = 0;
  let unsupported = 0;
  const rawParts: Record<string, unknown>[] = [];
  const projectedParts: Record<string, unknown>[] = [];
  let projectionTextBudget = Math.max(0, maximumProjectionBytes - 4096);
  let truncated = false;
  for (const value of response.contents) {
    const part = record(value);
    if (part.uri !== uri || (part.mimeType !== undefined && typeof part.mimeType !== "string")) {
      throw new McpCoreError("mcp_resource_content_invalid", "MCP resource response URI or MIME does not match its request");
    }
    if (typeof part.text === "string" && part.blob === undefined) {
      if (!validUnicode(part.text)) {
        throw new McpCoreError("mcp_resource_content_invalid", "MCP resource text is not valid Unicode");
      }
      const bytes = Buffer.byteLength(part.text, "utf8");
      decodedBytes += bytes;
      const selected = utf8Prefix(part.text, projectionTextBudget);
      const selectedBytes = Buffer.byteLength(selected, "utf8");
      projectionTextBudget -= selectedBytes;
      truncated ||= selectedBytes < bytes;
      rawParts.push({
        ...(part.mimeType === undefined ? {} : { mime_type: part.mimeType }),
        text: part.text,
        uri,
      });
      projectedParts.push({
        bytes,
        ...(part.mimeType === undefined ? {} : { mime_type: part.mimeType }),
        text: selected,
        text_sha256: sha256(part.text),
        type: "text",
      });
    } else if (typeof part.blob === "string" && part.text === undefined) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(part.blob)) {
        throw new McpCoreError("mcp_resource_content_invalid", "MCP resource blob is not strict base64");
      }
      const bytes = Buffer.from(part.blob, "base64");
      if (bytes.toString("base64") !== part.blob) {
        throw new McpCoreError("mcp_resource_content_invalid", "MCP resource blob has a non-canonical base64 encoding");
      }
      decodedBytes += bytes.byteLength;
      unsupported += 1;
      rawParts.push({
        blob: part.blob,
        ...(part.mimeType === undefined ? {} : { mime_type: part.mimeType }),
        uri,
      });
      projectedParts.push({
        bytes: bytes.byteLength,
        content_sha256: sha256(bytes),
        ...(part.mimeType === undefined ? {} : { mime_type: part.mimeType }),
        type: "blob_metadata_only",
      });
    } else {
      throw new McpCoreError("mcp_resource_content_invalid", "MCP resource content part has an unsupported shape");
    }
    if (decodedBytes > MAX_RESOURCE_RAW_BYTES) {
      throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource exceeds the 1 MiB decoded limit");
    }
  }
  const rawCanonical = `${canonicalJson({ contents: rawParts, schema_version: 1 })}\n`;
  const projection = `BORNAGENT_UNTRUSTED_MCP_RESOURCE_V1\n${canonicalJson({
    authority: "untrusted_content",
    parts: projectedParts,
    schema_version: 1,
    source_uri_sha256: sha256(uri),
    truncated,
  })}`;
  if (Buffer.byteLength(projection, "utf8") > maximumProjectionBytes) {
    throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource projection metadata exceeds its limit");
  }
  return Object.freeze({
    decodedBytes,
    partCount: rawParts.length,
    projection,
    rawCanonical,
    truncated,
    unsupported,
  });
}

function validatePromptArguments(
  prompt: FrozenMcpPrompt,
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const declared = new Map(prompt.arguments.map((argument) => [argument.name, argument]));
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!declared.has(key) || !validUnicode(value) || value.includes("\0")) {
      throw new McpCoreError("mcp_prompt_arguments_invalid", "MCP prompt arguments do not match the frozen declaration");
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > 8 * 1024) {
      throw new McpCoreError("mcp_prompt_arguments_invalid", "MCP prompt argument exceeds 8 KiB");
    }
    total += bytes;
  }
  if (
    total > 32 * 1024 ||
    prompt.arguments.some((argument) => argument.required && input[argument.name] === undefined)
  ) {
    throw new McpCoreError("mcp_prompt_arguments_invalid", "MCP prompt required arguments are incomplete");
  }
  return Object.freeze(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
}

function parsePromptContent(raw: unknown) {
  const response = record(raw);
  if (!Array.isArray(response.messages) || response.messages.length > 32) {
    throw new McpCoreError("mcp_prompt_content_unsupported", "MCP prompt must contain at most 32 messages");
  }
  const rawCanonical = `${canonicalJson(response)}\n`;
  if (Buffer.byteLength(rawCanonical, "utf8") > MAX_PROMPT_RAW_BYTES) {
    throw new McpCoreError("mcp_prompt_content_unsupported", "MCP prompt exceeds 256 KiB");
  }
  let unsupported = 0;
  const messages = response.messages.map((value) => {
    const message = record(value);
    if ((message.role !== "user" && message.role !== "assistant") || message.content === undefined) {
      throw new McpCoreError("mcp_prompt_content_unsupported", "MCP prompt message is invalid");
    }
    const content = record(message.content);
    if (content.type === "text" && typeof content.text === "string" && validUnicode(content.text)) {
      return Object.freeze({
        source_role: message.role,
        text: content.text,
        text_sha256: sha256(content.text),
        type: "quoted_text",
      });
    }
    unsupported += 1;
    return Object.freeze({
      content_sha256: sha256Canonical(content),
      source_role: message.role,
      source_type: typeof content.type === "string" ? content.type : "unknown",
      type: "unsupported_content_metadata",
    });
  });
  // PHASE18: source roles are quoted metadata. A server saying "system" or
  // returning a user message never receives system/user instruction authority.
  const projection = `BORNAGENT_UNTRUSTED_MCP_PROMPT_V1\n${canonicalJson({
    authority: "untrusted_content",
    messages,
    schema_version: 1,
  })}`;
  if (Buffer.byteLength(projection, "utf8") > MAX_PROMPT_RAW_BYTES) {
    throw new McpCoreError("mcp_prompt_content_unsupported", "MCP prompt projection exceeds 256 KiB");
  }
  return Object.freeze({
    messageCount: messages.length,
    projection,
    rawCanonical,
    unsupported,
  });
}

export class McpPrimitiveRuntime {
  readonly #approval: McpApprovalGate;
  readonly #bindings = new Map<string, PrimitiveBinding>();
  readonly #contextItems: ContextItemInput[] = [];

  constructor(private readonly options: {
    readonly artifacts?: ArtifactSessionRuntimeLike;
    readonly events: McpEventAppender;
    readonly hooks?: EffectHookPipeline;
    readonly permissionEngine: PermissionEngineLike;
    readonly prompt: ApprovalPrompt;
    readonly randomUUID: () => string;
    readonly recency?: () => number;
    readonly secrets?: readonly (string | undefined)[];
  }) {
    this.#approval = new McpApprovalGate(options);
  }

  contextItems(): readonly ContextItemInput[] {
    return Object.freeze([...this.#contextItems]);
  }

  hasResources(): boolean {
    return [...this.#bindings.values()].some(
      (binding) => binding.resourceCatalog !== undefined,
    );
  }

  async discover(server: StartedMcpServer, signal: AbortSignal): Promise<void> {
    const rawNegotiation = server.client.negotiation();
    const negotiation = freezeMcpServerNegotiation({
      configSha256: server.config.configSha256,
      processIdentitySha256: server.processIdentity.processIdentitySha256,
      raw: rawNegotiation,
      serverId: server.config.serverId,
    });
    const binding: PrimitiveBinding = {
      negotiation,
      promptStale: false,
      resourceStale: false,
      server,
      staleTask: null,
    };
    this.#bindings.set(server.config.serverId, binding);
    const negotiationEventId = this.options.randomUUID();
    const instructionsArtifact = rawNegotiation.instructions === undefined
      ? undefined
      : await materialize(this.options.artifacts, rawNegotiation.instructions, negotiationEventId);
    await this.options.events.append("mcp.server.negotiated", {
      ...(negotiation.instructionsSha256 === undefined ? {} : {
        ...(instructionsArtifact === undefined ? {} : { instructions_artifact_id: instructionsArtifact.artifactId }),
        instructions_sha256: negotiation.instructionsSha256,
      }),
      negotiation_sha256: negotiation.negotiationSha256,
      process_identity_sha256: negotiation.processIdentitySha256,
      prompts_list_changed: negotiation.prompts.listChanged,
      prompts_supported: negotiation.prompts.supported,
      protocol_version: negotiation.protocolVersion,
      resources_list_changed: negotiation.resources.listChanged,
      resources_subscribe: negotiation.resources.subscribe,
      resources_supported: negotiation.resources.supported,
      server_identity_sha256: negotiation.serverIdentitySha256,
      server_id: server.config.serverId,
      server_name: negotiation.serverName,
      ...(negotiation.serverVersion === undefined ? {} : { server_version: negotiation.serverVersion }),
      tools_list_changed: negotiation.tools.listChanged,
      tools_supported: negotiation.tools.supported,
    }, negotiationEventId);
    if (negotiation.resources.supported) {
      const catalog = freezeMcpResourceCatalog({
        negotiationSha256: negotiation.negotiationSha256,
        processIdentitySha256: negotiation.processIdentitySha256,
        resources: await server.client.listResources({ signal, timeoutMs: server.config.callTimeoutMs }),
        serverId: server.config.serverId,
      });
      binding.resourceCatalog = catalog;
      const eventId = this.options.randomUUID();
      const artifact = await materialize(this.options.artifacts, canonicalCatalogArtifact(catalog), eventId);
      await this.options.events.append("mcp.resource.cataloged", {
        ...(artifact === undefined ? {} : { catalog_artifact_id: artifact.artifactId }),
        catalog_generation_sha256: catalog.catalogGenerationSha256,
        catalog_sha256: catalog.catalogSha256,
        count: catalog.resources.length,
        negotiation_sha256: negotiation.negotiationSha256,
        process_identity_sha256: negotiation.processIdentitySha256,
        server_id: server.config.serverId,
      }, eventId);
    }
    if (negotiation.prompts.supported) {
      const catalog = freezeMcpPromptCatalog({
        negotiationSha256: negotiation.negotiationSha256,
        processIdentitySha256: negotiation.processIdentitySha256,
        prompts: await server.client.listPrompts({ signal, timeoutMs: server.config.callTimeoutMs }),
        serverId: server.config.serverId,
      });
      binding.promptCatalog = catalog;
      const eventId = this.options.randomUUID();
      const artifact = await materialize(this.options.artifacts, canonicalCatalogArtifact(catalog), eventId);
      await this.options.events.append("mcp.prompt.cataloged", {
        ...(artifact === undefined ? {} : { catalog_artifact_id: artifact.artifactId }),
        catalog_generation_sha256: catalog.catalogGenerationSha256,
        catalog_sha256: catalog.catalogSha256,
        count: catalog.prompts.length,
        negotiation_sha256: negotiation.negotiationSha256,
        process_identity_sha256: negotiation.processIdentitySha256,
        server_id: server.config.serverId,
      }, eventId);
    }
  }

  markStale(serverId: string, primitive: "prompt" | "resource"): void {
    const binding = this.#bindings.get(serverId);
    if (binding === undefined) return;
    const catalog = primitive === "resource" ? binding.resourceCatalog : binding.promptCatalog;
    if (catalog === undefined) return;
    if (primitive === "resource") binding.resourceStale = true;
    else binding.promptStale = true;
    // PHASE18: listChanged only revokes the frozen generation. It never starts
    // an implicit list/read that could silently replace an approved identity.
    const appendTask = this.options.events.append(
      primitive === "resource" ? "mcp.resource.catalog.stale" : "mcp.prompt.catalog.stale",
      {
        catalog_generation_sha256: catalog.catalogGenerationSha256,
        process_identity_sha256: catalog.processIdentitySha256,
        reason: "list_changed",
        server_id: serverId,
      },
    );
    const durableTask = appendTask.finally(() => {
      if (binding.staleTask === durableTask) binding.staleTask = null;
    });
    binding.staleTask = durableTask;
  }

  listResources(input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly query?: string;
    readonly serverId?: string;
  }): Readonly<Record<string, unknown>> {
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || Buffer.byteLength(input.query ?? "", "utf8") > 256) {
      throw new McpCoreError("mcp_catalog_invalid", "MCP resource list arguments are invalid");
    }
    const catalogs = [...this.#bindings.values()]
      .filter((binding) => input.serverId === undefined || binding.server.config.serverId === input.serverId)
      .map((binding) => {
        requireMcpPrimitive(binding.negotiation, "resources");
        if (binding.resourceStale) throw new McpCoreError("mcp_resource_catalog_stale", "MCP resource catalog is stale");
        return binding.resourceCatalog!;
      });
    const query = (input.query ?? "").normalize("NFC").toLowerCase();
    const identity = sha256Canonical(catalogs.map((catalog) => catalog.catalogGenerationSha256));
    let offset = 0;
    if (input.cursor !== undefined) {
      let cursor: Readonly<Record<string, unknown>>;
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Readonly<Record<string, unknown>>;
      } catch (error) {
        throw new McpCoreError("mcp_catalog_invalid", "MCP resource cursor is invalid", { cause: error });
      }
      if (
        cursor.catalog_identity !== identity || cursor.limit !== limit ||
        cursor.query_sha256 !== sha256Canonical(query) ||
        typeof cursor.offset !== "number" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
      ) {
        throw new McpCoreError("mcp_resource_catalog_stale", "MCP resource cursor is stale");
      }
      offset = cursor.offset;
    }
    const resources = catalogs.flatMap((catalog) => catalog.resources).filter((resource) =>
      query.length === 0 || `${resource.name} ${resource.description ?? ""} ${resource.mimeType ?? ""}`.toLowerCase().includes(query)
    );
    const page = resources.slice(offset, offset + limit).map((resource) => ({
      catalog_generation: resource.catalogGenerationSha256.slice(0, 16),
      description: resource.description ?? null,
      display_uri: displayUri(resource.uri),
      mime_type: resource.mimeType ?? null,
      name: resource.name,
      resource_id: resource.resourceId,
      server_id: resource.serverId,
    }));
    if (Buffer.byteLength(canonicalJson(page), "utf8") > 32 * 1024) {
      throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource list page exceeds 32 KiB");
    }
    const nextOffset = offset + page.length;
    return Object.freeze({
      entries: Object.freeze(page),
      next_cursor: nextOffset < resources.length
        ? Buffer.from(canonicalJson({
            catalog_identity: identity,
            limit,
            offset: nextOffset,
            query_sha256: sha256Canonical(query),
          }), "utf8").toString("base64url")
        : null,
    });
  }

  private resource(resourceId: string): { binding: PrimitiveBinding; resource: FrozenMcpResource } {
    for (const binding of this.#bindings.values()) {
      const resource = binding.resourceCatalog?.resources.find((candidate) => candidate.resourceId === resourceId);
      if (resource !== undefined) return { binding, resource };
    }
    throw new McpCoreError("mcp_resource_not_found", "MCP resource ID is not in the frozen run catalog");
  }

  async readResource(
    resourceId: string,
    maxBytes: number,
    context: ToolContext,
  ): Promise<Readonly<Record<string, unknown>>> {
    const { binding, resource } = this.resource(resourceId);
    if (binding.staleTask !== null) await binding.staleTask;
    requireMcpPrimitive(binding.negotiation, "resources");
    if (binding.resourceStale) throw new McpCoreError("mcp_resource_catalog_stale", "MCP resource catalog is stale");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESOURCE_PROJECTION_BYTES) {
      throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource max_bytes must be 1..256 KiB");
    }
    const action = createMcpResourceReadActionIdentity({
      callTimeoutMs: binding.server.config.callTimeoutMs,
      catalogGenerationSha256: resource.catalogGenerationSha256,
      configSha256: binding.server.config.configSha256,
      negotiationSha256: binding.negotiation.negotiationSha256,
      processIdentitySha256: resource.processIdentitySha256,
      resourceId: resource.resourceId,
      resourceItemSha256: resource.itemSha256,
      serverId: resource.serverId,
      uri: resource.uri,
    });
    const permission = this.options.permissionEngine.evaluate(action, { startedMcpServerIds: [resource.serverId] });
    await this.options.events.append("mcp.permission.evaluated", {
      action_kind: action.actionKind,
      action_sha256: action.actionSha256,
      effect: permission.effect,
      policy_version: permission.policyVersion,
      ...(permission.effect === "allow" ? {} : { reason_code: permission.reasonCode }),
      rule_id: permission.ruleId,
      server_id: resource.serverId,
    });
    if (permission.effect === "deny") throw new McpCoreError("mcp_resource_read_denied", "MCP resource read was denied by policy");
    const approval = permission.effect === "ask"
      ? await this.#approval.request({
          actionKind: "mcp.resource.read",
          actionSha256: action.actionSha256,
          reviewLines: [
            `server: ${resource.serverId}`,
            `resource: ${resource.name}`,
            `uri: ${displayUri(resource.uri)}`,
            `catalog: ${resource.catalogGenerationSha256}`,
            `max_bytes: ${String(maxBytes)}`,
          ],
          riskWarning: "server content and annotations remain untrusted reference data",
          serverId: resource.serverId,
          title: "Read MCP resource?",
        }, context.signal)
      : { approvalRequestId: this.options.randomUUID(), decision: "approved" as const };
    if (approval.decision !== "approved") throw new McpCoreError("mcp_resource_read_denied", "MCP resource read was not approved");
    const hookDecision = await this.options.hooks?.run(
      "tool.before_effect",
      {
        action: {
          actionKind: "mcp.resource.read",
          capabilityIds: [resource.serverId],
          originalActionSha256: action.actionSha256,
          toolName: "read_mcp_resource",
        },
        revalidateOriginalAction: async () => {
          if (binding.staleTask !== null) await binding.staleTask;
          const current = binding.resourceCatalog?.resources.find((candidate) => candidate.resourceId === resource.resourceId);
          if (binding.resourceStale || current === undefined) return false;
          const currentAction = createMcpResourceReadActionIdentity({
            callTimeoutMs: binding.server.config.callTimeoutMs,
            catalogGenerationSha256: current.catalogGenerationSha256,
            configSha256: binding.server.config.configSha256,
            negotiationSha256: binding.negotiation.negotiationSha256,
            processIdentitySha256: binding.server.processIdentity.processIdentitySha256,
            resourceId: current.resourceId,
            resourceItemSha256: current.itemSha256,
            serverId: current.serverId,
            uri: current.uri,
          });
          return currentAction.actionSha256 === action.actionSha256;
        },
      },
      context.signal,
    );
    if (hookDecision?.decision === "deny") {
      throw new McpCoreError("mcp_resource_read_denied", hookDecision.message ?? "MCP resource read was denied by a lifecycle Hook");
    }
    const requestedEventId = this.options.randomUUID();
    await this.options.events.append("mcp.resource.read.requested", {
      action_sha256: action.actionSha256,
      approval_request_id: approval.approvalRequestId,
      call_id: context.callId,
      catalog_generation_sha256: action.catalogGenerationSha256,
      config_sha256: action.configSha256,
      max_bytes: maxBytes,
      negotiation_sha256: action.negotiationSha256,
      process_identity_sha256: action.processIdentitySha256,
      resource_id: action.resourceId,
      resource_item_sha256: action.resourceItemSha256,
      server_id: action.serverId,
      step: context.step,
      timeout_ms: action.callTimeoutMs,
      uri_sha256: action.uriSha256,
    }, requestedEventId);
    try {
      const raw = await binding.server.client.readResource({
        signal: context.signal,
        timeoutMs: action.callTimeoutMs,
        uri: resource.uri,
      });
      if (binding.resourceStale) throw new McpCoreError("mcp_resource_catalog_stale", "MCP resource catalog changed during read");
      const mapped = parseResourceContent(raw, resource.uri, maxBytes);
      const rawArtifact = await materialize(this.options.artifacts, mapped.rawCanonical, requestedEventId);
      const projectionArtifact = await materialize(this.options.artifacts, mapped.projection, requestedEventId);
      if (rawArtifact === undefined) throw new McpCoreError("mcp_primitive_effect_unknown", "MCP resource artifact runtime is unavailable");
      await this.options.events.append("mcp.resource.read.completed", {
        action_sha256: action.actionSha256,
        byte_length: mapped.decodedBytes,
        content_part_count: mapped.partCount,
        ...(projectionArtifact === undefined ? {} : {
          projection_artifact_id: projectionArtifact.artifactId,
          projection_sha256: projectionArtifact.sha256,
        }),
        raw_artifact_id: rawArtifact.artifactId,
        raw_sha256: rawArtifact.sha256,
        resource_id: resource.resourceId,
        server_id: resource.serverId,
        truncated: mapped.truncated,
        unsupported_content_count: mapped.unsupported,
      });
      if (projectionArtifact !== undefined) {
        this.#contextItems.push(Object.freeze({
          artifactRefs: Object.freeze([artifactReference(rawArtifact), artifactReference(projectionArtifact)]),
          authority: "untrusted_content",
          content: mapped.projection,
          kind: "mcp_resource",
          metadata: {
            action_identity_sha256: action.actionSha256,
            projection_artifact_id: projectionArtifact.artifactId,
            raw_artifact_id: rawArtifact.artifactId,
            resource_id: resource.resourceId,
            server_identity_sha256: binding.negotiation.serverIdentitySha256,
          },
          priority: "normal",
          recency: this.options.recency?.() ?? 0,
          role: "system",
          sourceEventIds: [requestedEventId],
          visibility: "provider_context",
        }));
      }
      await this.options.hooks?.run(
        "tool.after_result",
        {
          action: {
            actionKind: "mcp.resource.read",
            capabilityIds: [resource.serverId],
            originalActionSha256: action.actionSha256,
            terminalState: "completed",
            toolName: "read_mcp_resource",
          },
          result: {
            raw_sha256: rawArtifact.sha256,
            truncated: mapped.truncated,
          },
        },
        context.signal,
      );
      return Object.freeze({
        content: mapped.projection,
        projection_artifact_id: projectionArtifact?.artifactId ?? null,
        raw_artifact_id: rawArtifact.artifactId,
        resource_id: resource.resourceId,
        server_id: resource.serverId,
        truncated: mapped.truncated,
      });
    } catch (error) {
      const code = error instanceof McpCoreError ? error.code : "mcp_primitive_effect_unknown";
      await this.options.events.append("mcp.resource.read.failed", {
        action_sha256: action.actionSha256,
        code,
        effect: code === "mcp_resource_catalog_stale" ? "stale" : "effect_unknown",
        resource_id: resource.resourceId,
        server_id: resource.serverId,
      });
      throw error instanceof McpCoreError
        ? error
        : new McpCoreError("mcp_primitive_effect_unknown", "MCP resource read did not reach a durable terminal result", { cause: error });
    }
  }

  listPrompts(serverId?: string): readonly Readonly<Record<string, unknown>>[] {
    return Object.freeze([...this.#bindings.values()]
      .filter((binding) => serverId === undefined || binding.server.config.serverId === serverId)
      .flatMap((binding) => {
        requireMcpPrimitive(binding.negotiation, "prompts");
        if (binding.promptStale) throw new McpCoreError("mcp_prompt_catalog_stale", "MCP prompt catalog is stale");
        return binding.promptCatalog!.prompts.map((prompt) => Object.freeze({
          arguments: prompt.arguments,
          description: prompt.description ?? null,
          name: prompt.name,
          prompt_id: prompt.promptId,
          server_id: prompt.serverId,
        }));
      }));
  }

  async getPrompt(input: {
    readonly argumentsValue: Readonly<Record<string, string>>;
    readonly invocationEventId: string;
    readonly invocationSource: "explicit_user";
    readonly promptId: string;
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, unknown>>> {
    // PHASE18: this source is supplied only by a user command/TUI boundary;
    // model, Skill, Hook, repository, and MCP content have no prompt-get tool.
    if (input.invocationSource !== "explicit_user") {
      throw new McpCoreError("mcp_prompt_user_control_required", "MCP prompt get requires explicit user control");
    }
    let binding: PrimitiveBinding | undefined;
    let prompt: FrozenMcpPrompt | undefined;
    for (const candidate of this.#bindings.values()) {
      const found = candidate.promptCatalog?.prompts.find((value) => value.promptId === input.promptId);
      if (found !== undefined) { binding = candidate; prompt = found; break; }
    }
    if (binding === undefined || prompt === undefined) throw new McpCoreError("mcp_prompt_not_found", "MCP prompt ID is not in the frozen catalog");
    if (binding.staleTask !== null) await binding.staleTask;
    if (binding.promptStale) throw new McpCoreError("mcp_prompt_catalog_stale", "MCP prompt catalog is stale");
    const argumentsValue = validatePromptArguments(prompt, input.argumentsValue);
    const action = createMcpPromptGetActionIdentity({
      argumentsValue,
      callTimeoutMs: binding.server.config.callTimeoutMs,
      catalogGenerationSha256: prompt.catalogGenerationSha256,
      configSha256: binding.server.config.configSha256,
      invocationEventId: input.invocationEventId,
      negotiationSha256: binding.negotiation.negotiationSha256,
      processIdentitySha256: prompt.processIdentitySha256,
      promptId: prompt.promptId,
      promptItemSha256: prompt.itemSha256,
      promptName: prompt.name,
      serverId: prompt.serverId,
    });
    const permission = this.options.permissionEngine.evaluate(action, { startedMcpServerIds: [prompt.serverId] });
    await this.options.events.append("mcp.permission.evaluated", {
      action_kind: action.actionKind,
      action_sha256: action.actionSha256,
      effect: permission.effect,
      policy_version: permission.policyVersion,
      ...(permission.effect === "allow" ? {} : { reason_code: permission.reasonCode }),
      rule_id: permission.ruleId,
      server_id: prompt.serverId,
    });
    if (permission.effect === "deny") throw new McpCoreError("mcp_permission_denied", "MCP prompt get was denied by policy");
    const approval = permission.effect === "ask"
      ? await this.#approval.request({
          actionKind: "mcp.prompt.get",
          actionSha256: action.actionSha256,
          reviewLines: [
            `server: ${prompt.serverId}`,
            `prompt: ${prompt.name}`,
            `arguments: ${redactSensitiveText(action.argumentsJson, this.options.secrets ?? [])}`,
            `catalog: ${prompt.catalogGenerationSha256}`,
          ],
          riskWarning: "server roles and content remain untrusted quoted reference data",
          serverId: prompt.serverId,
          title: "Get MCP prompt?",
        }, input.signal)
      : { approvalRequestId: this.options.randomUUID(), decision: "approved" as const };
    if (approval.decision !== "approved") throw new McpCoreError("mcp_approval_denied", "MCP prompt get was not approved");
    const hookDecision = await this.options.hooks?.run(
      "tool.before_effect",
      {
        action: {
          actionKind: "mcp.prompt.get",
          capabilityIds: [prompt.serverId],
          originalActionSha256: action.actionSha256,
          toolName: "get_mcp_prompt",
        },
        revalidateOriginalAction: async () => {
          if (binding.staleTask !== null) await binding.staleTask;
          const current = binding.promptCatalog?.prompts.find((candidate) => candidate.promptId === prompt.promptId);
          if (binding.promptStale || current === undefined) return false;
          const currentAction = createMcpPromptGetActionIdentity({
            argumentsValue,
            callTimeoutMs: binding.server.config.callTimeoutMs,
            catalogGenerationSha256: current.catalogGenerationSha256,
            configSha256: binding.server.config.configSha256,
            invocationEventId: input.invocationEventId,
            negotiationSha256: binding.negotiation.negotiationSha256,
            processIdentitySha256: binding.server.processIdentity.processIdentitySha256,
            promptId: current.promptId,
            promptItemSha256: current.itemSha256,
            promptName: current.name,
            serverId: current.serverId,
          });
          return currentAction.actionSha256 === action.actionSha256;
        },
      },
      input.signal,
    );
    if (hookDecision?.decision === "deny") {
      throw new McpCoreError("mcp_permission_denied", hookDecision.message ?? "MCP prompt get was denied by a lifecycle Hook");
    }
    const requestedEventId = this.options.randomUUID();
    await this.options.events.append("mcp.prompt.get.requested", {
      action_sha256: action.actionSha256,
      approval_request_id: approval.approvalRequestId,
      arguments_sha256: action.argumentsSha256,
      catalog_generation_sha256: action.catalogGenerationSha256,
      config_sha256: action.configSha256,
      invocation_event_id: action.invocationEventId,
      negotiation_sha256: action.negotiationSha256,
      process_identity_sha256: action.processIdentitySha256,
      prompt_id: action.promptId,
      prompt_item_sha256: action.promptItemSha256,
      prompt_name: action.promptName,
      server_id: action.serverId,
      timeout_ms: action.callTimeoutMs,
    }, requestedEventId);
    try {
      const raw = await binding.server.client.getPrompt({
        argumentsValue,
        name: prompt.name,
        signal: input.signal,
        timeoutMs: action.callTimeoutMs,
      });
      if (binding.promptStale) throw new McpCoreError("mcp_prompt_catalog_stale", "MCP prompt catalog changed during get");
      const mapped = parsePromptContent(raw);
      const rawArtifact = await materialize(this.options.artifacts, mapped.rawCanonical, requestedEventId);
      const projectionArtifact = await materialize(this.options.artifacts, mapped.projection, requestedEventId);
      if (rawArtifact === undefined) throw new McpCoreError("mcp_primitive_effect_unknown", "MCP prompt artifact runtime is unavailable");
      await this.options.events.append("mcp.prompt.get.completed", {
        action_sha256: action.actionSha256,
        byte_length: Buffer.byteLength(mapped.rawCanonical, "utf8"),
        message_count: mapped.messageCount,
        ...(projectionArtifact === undefined ? {} : {
          projection_artifact_id: projectionArtifact.artifactId,
          projection_sha256: projectionArtifact.sha256,
        }),
        prompt_id: prompt.promptId,
        raw_artifact_id: rawArtifact.artifactId,
        raw_sha256: rawArtifact.sha256,
        server_id: prompt.serverId,
        truncated: false,
        unsupported_content_count: mapped.unsupported,
      });
      if (projectionArtifact !== undefined) {
        this.#contextItems.push(Object.freeze({
          artifactRefs: Object.freeze([artifactReference(rawArtifact), artifactReference(projectionArtifact)]),
          authority: "untrusted_content",
          content: mapped.projection,
          kind: "mcp_prompt",
          metadata: {
            action_identity_sha256: action.actionSha256,
            prompt_id: prompt.promptId,
            source_roles_untrusted: true,
          } as ContextJson,
          priority: "high",
          recency: this.options.recency?.() ?? 0,
          role: "system",
          sourceEventIds: [input.invocationEventId, requestedEventId],
          visibility: "provider_context",
        }));
      }
      await this.options.hooks?.run(
        "tool.after_result",
        {
          action: {
            actionKind: "mcp.prompt.get",
            capabilityIds: [prompt.serverId],
            originalActionSha256: action.actionSha256,
            terminalState: "completed",
            toolName: "get_mcp_prompt",
          },
          result: { raw_sha256: rawArtifact.sha256 },
        },
        input.signal,
      );
      return Object.freeze({
        content: mapped.projection,
        projection_artifact_id: projectionArtifact?.artifactId ?? null,
        prompt_id: prompt.promptId,
        raw_artifact_id: rawArtifact.artifactId,
        server_id: prompt.serverId,
      });
    } catch (error) {
      const code = error instanceof McpCoreError ? error.code : "mcp_primitive_effect_unknown";
      await this.options.events.append("mcp.prompt.get.failed", {
        action_sha256: action.actionSha256,
        code,
        effect: code === "mcp_prompt_catalog_stale" ? "stale" : "effect_unknown",
        prompt_id: prompt.promptId,
        server_id: prompt.serverId,
      });
      throw error instanceof McpCoreError
        ? error
        : new McpCoreError("mcp_primitive_effect_unknown", "MCP prompt get did not reach a durable terminal result", { cause: error });
    }
  }
}
