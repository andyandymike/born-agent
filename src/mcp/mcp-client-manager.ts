import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { PermissionEngineLike } from "../permissions/permission-types.js";
import { redactSensitiveText } from "../security/redact.js";
import { toolError } from "../tools/tool-errors.js";
import {
  FatalToolExecutionError,
  MAX_TOOL_OUTPUT_BYTES,
  type RegisteredTool,
  type ToolContext,
  type ToolRawResult,
} from "../tools/tool-types.js";
import {
  createMcpToolCallActionIdentity,
  type McpToolCallActionIdentity,
} from "./mcp-action-identity.js";
import { McpApprovalGate, type McpEventAppender } from "./mcp-approval-gate.js";
import type { LoadedMcpServerConfig } from "./mcp-config-loader.js";
import { MAX_MCP_ENABLED_SERVERS } from "./mcp-config-schema.js";
import { McpCoreError } from "./mcp-errors.js";
import { createMcpCatalogState, observeMcpCatalog, requireFrozenMcpTool, type McpCatalogState } from "./mcp-tool-catalog.js";
import { createMcpToolAdapter } from "./mcp-tool-adapter.js";
import { discoverMcpTools, type DiscoveredMcpCatalog } from "./mcp-tool-discovery.js";
import { MCP_RESULT_MAPPER_VERSION, mapMcpTextResult } from "./mcp-result-mapper.js";
import type { McpServerLauncher, StartedMcpServer } from "./mcp-server-launcher.js";

interface ManagedServer {
  activeCallId: string | null;
  catalogChangedNotification: boolean;
  catalogState: McpCatalogState;
  changeTask: Promise<void> | null;
  discovery: DiscoveredMcpCatalog;
  server: StartedMcpServer;
}

export class McpClientManager {
  private readonly approval: McpApprovalGate;
  private readonly managed = new Map<string, ManagedServer>();
  private stopping = false;

  public constructor(
    private readonly options: {
      readonly events: McpEventAppender;
      readonly launcher: McpServerLauncher;
      readonly permissionEngine: PermissionEngineLike;
      readonly prompt: ApprovalPrompt;
      readonly randomUUID: () => string;
      readonly secrets?: readonly (string | undefined)[];
    },
  ) {
    this.approval = new McpApprovalGate({
      events: options.events,
      prompt: options.prompt,
      randomUUID: options.randomUUID,
    });
  }

  public async startSelected(input: {
    readonly configs: readonly LoadedMcpServerConfig[];
    readonly reservedModelNames: readonly string[];
    readonly signal: AbortSignal;
    readonly workspaceRealPath: string;
  }): Promise<readonly RegisteredTool[]> {
    if (
      input.configs.length > MAX_MCP_ENABLED_SERVERS ||
      new Set(input.configs.map((config) => config.serverId)).size !== input.configs.length
    ) {
      throw new McpCoreError("mcp_config_invalid", "a run may enable at most four unique MCP servers");
    }
    const reserved = [...input.reservedModelNames];
    try {
      for (const config of input.configs) {
        let notification = false;
        const server = await this.options.launcher.start(
          config,
          input.workspaceRealPath,
          input.signal,
          () => {
            notification = true;
            const managed = this.managed.get(config.serverId);
            if (managed !== undefined) {
              managed.catalogChangedNotification = true;
              this.scheduleCatalogRefresh(managed, input.signal, reserved);
            }
          },
        );
        const discovery = await discoverMcpTools({
          reservedModelNames: reserved,
          server,
          signal: input.signal,
        });
        const managed: ManagedServer = {
          activeCallId: null,
          catalogChangedNotification: notification,
          catalogState: createMcpCatalogState(discovery.catalog),
          changeTask: null,
          discovery,
          server,
        };
        this.managed.set(config.serverId, managed);
        await this.options.events.append("mcp.catalog.discovered", {
          catalog_sha256: discovery.catalog.catalogSha256,
          process_identity_sha256: server.processIdentity.processIdentitySha256,
          server_id: config.serverId,
          tools: discovery.catalog.tools.map((tool) => ({
            description_sha256: tool.descriptionSha256,
            model_name: tool.modelName,
            raw_name: tool.rawName,
            schema_sha256: tool.schema.schemaSha256,
            strict_for_model: tool.schema.strictForModel,
          })),
        });
        reserved.push(...discovery.catalog.tools.map((tool) => tool.modelName));
        if (notification) this.scheduleCatalogRefresh(managed, input.signal, reserved);
      }
    } catch (error) {
      await this.stopAll();
      throw error;
    }
    return Object.freeze(
      [...this.managed.values()].flatMap((managed) =>
        managed.discovery.catalog.tools.map((tool) =>
          createMcpToolAdapter({
            caller: this,
            catalogSha256: managed.discovery.catalog.catalogSha256,
            serverId: managed.server.config.serverId,
            tool,
            validator: managed.discovery.validators.get(tool.modelName)!,
          }),
        ),
      ),
    );
  }

  public async call(
    serverId: string,
    modelToolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolRawResult> {
    const managed = this.managed.get(serverId);
    if (managed === undefined || this.stopping) {
      return {
        error: toolError("system", "mcp_server_unavailable", "MCP server is unavailable"),
        ok: false,
      };
    }
    if (managed.changeTask !== null) await managed.changeTask;
    if (managed.catalogChangedNotification) {
      await this.refreshCatalog(managed, context.signal, []);
    }
    const tool = requireFrozenMcpTool(managed.catalogState, modelToolName);
    if (managed.activeCallId !== null) {
      return {
        error: toolError("system", "mcp_call_already_active", "MCP server already has an active call"),
        ok: false,
      };
    }
    const action = createMcpToolCallActionIdentity({
      argumentsValue: input,
      callTimeoutMs: managed.server.config.callTimeoutMs,
      catalogSha256: managed.discovery.catalog.catalogSha256,
      configSha256: managed.server.config.configSha256,
      modelToolName,
      processIdentitySha256: managed.server.processIdentity.processIdentitySha256,
      rawToolName: tool.rawName,
      schemaSha256: tool.schema.schemaSha256,
      serverId,
    });
    const permission = this.options.permissionEngine.evaluate(action, {
      reviewedOfflineMcpServerIds: [serverId],
    });
    await this.options.events.append("mcp.permission.evaluated", {
      action_kind: action.actionKind,
      action_sha256: action.actionSha256,
      effect: permission.effect,
      policy_version: permission.policyVersion,
      ...(permission.effect === "allow" ? {} : { reason_code: permission.reasonCode }),
      rule_id: permission.ruleId,
      server_id: serverId,
    });
    if (permission.effect === "deny") {
      return {
        error: toolError("permission", "mcp_call_denied", "MCP tool call was denied by policy"),
        ok: false,
      };
    }
    const approval =
      permission.effect === "ask"
        ? await this.approval.request(
            {
              actionKind: "mcp.tool.call",
              actionSha256: action.actionSha256,
              reviewLines: [
                `server: ${serverId}`,
                `tool: ${tool.rawName}`,
                `arguments: ${redactSensitiveText(action.argumentsJson, this.options.secrets ?? [])}`,
                `timeout_ms: ${action.callTimeoutMs}`,
              ],
              riskWarning: "server annotations are untrusted; this approval authorizes only these exact arguments",
              serverId,
              title: "Call MCP tool?",
            },
            context.signal,
          )
        : { approvalRequestId: this.options.randomUUID(), decision: "approved" as const };
    if (approval.decision !== "approved") {
      return {
        error: toolError("permission", "mcp_call_not_approved", "MCP tool call was not approved"),
        ok: false,
      };
    }
    managed.activeCallId = context.callId;
    await this.options.events.append("mcp.tool.call.started", callEventIdentity(action, context.callId, approval.approvalRequestId, context.step));
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await managed.server.client.callTool({
        argumentsValue: input,
        name: tool.rawName,
        signal: context.signal,
        timeoutMs: action.callTimeoutMs,
      });
    } catch (error) {
      await this.options.events.append("mcp.tool.call.effect_unknown", {
        ...callEventIdentity(action, context.callId, approval.approvalRequestId, context.step),
        code: context.signal.aborted ? "call_cancelled_after_start" : "call_failed_after_start",
      });
      managed.activeCallId = null;
      throw new FatalToolExecutionError(
        "ambiguous_mcp_state",
        "MCP tool call effect is unknown; the server must be stopped and reconciled",
        { cause: error, workspaceMayHaveChanged: false },
      );
    }

    let mappedErrorCode: string | undefined;
    let mapped;
    try {
      mapped = mapMcpTextResult(raw, {
        maxObservationBytes: MAX_TOOL_OUTPUT_BYTES,
        ...(this.options.secrets === undefined ? {} : { secrets: this.options.secrets }),
      });
    } catch (error) {
      mappedErrorCode =
        error instanceof McpCoreError
          ? error.code
          : "mcp_result_invalid";
      mapped = mapMcpTextResult(
        {
          content: [
            {
              text: `MCP result rejected: ${mappedErrorCode}`,
              type: "text",
            },
          ],
          isError: true,
        },
        {
          maxObservationBytes: MAX_TOOL_OUTPUT_BYTES,
          ...(this.options.secrets === undefined ? {} : { secrets: this.options.secrets }),
        },
      );
    }
    try {
      await this.options.events.append("mcp.tool.call.completed", {
        ...callEventIdentity(action, context.callId, approval.approvalRequestId, context.step),
        bytes: mapped.bytes,
        duration_ms: Math.max(0, Date.now() - started),
        mapper_version: MCP_RESULT_MAPPER_VERSION,
        observation: mapped.observation,
        observation_sha256: mapped.observationSha256,
        status: mapped.status,
        truncated: mapped.truncated,
      });
      const parsed = JSON.parse(mapped.observation) as Readonly<Record<string, unknown>>;
      managed.activeCallId = null;
      return mapped.status === "success"
        ? {
            ok: true,
            preSerializedOutput: mapped.observation,
            truncated: mapped.truncated,
            value: parsed,
          }
        : {
            error: toolError(
              "tool",
              mappedErrorCode ?? "mcp_tool_error",
              mappedErrorCode === undefined
                ? "MCP tool returned an error"
                : "MCP tool result was rejected by the local content policy",
            ),
            ok: false,
            preSerializedOutput: mapped.observation,
            truncated: mapped.truncated,
            value: parsed,
          };
    } catch (error) {
      try {
        await this.options.events.append("mcp.tool.call.effect_unknown", {
          ...callEventIdentity(action, context.callId, approval.approvalRequestId, context.step),
          code: "completed_result_not_durable",
        });
      } catch {
        // A failed writer cannot safely receive a synthetic terminal event.
      }
      managed.activeCallId = null;
      throw new FatalToolExecutionError(
        "ambiguous_mcp_state",
        "MCP tool call effect is unknown; the server must be stopped and reconciled",
        { cause: error, workspaceMayHaveChanged: false },
      );
    }
  }

  public async stopAll(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    let firstError: unknown;
    for (const managed of [...this.managed.values()].reverse()) {
      try {
        if (managed.changeTask !== null) await managed.changeTask;
        if (managed.activeCallId !== null) {
          throw new McpCoreError("mcp_effect_unknown", "cannot stop MCP server with an active call");
        }
        await this.options.launcher.stop(managed.server);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.managed.clear();
    if (firstError !== undefined) throw firstError;
  }

  private scheduleCatalogRefresh(
    managed: ManagedServer,
    signal: AbortSignal,
    reserved: readonly string[],
  ): void {
    if (managed.changeTask !== null) return;
    managed.changeTask = this.refreshCatalog(managed, signal, reserved).finally(() => {
      managed.changeTask = null;
    });
  }

  private async refreshCatalog(
    managed: ManagedServer,
    signal: AbortSignal,
    reserved: readonly string[],
  ): Promise<void> {
    managed.catalogChangedNotification = false;
    const current = await discoverMcpTools({
      reservedModelNames: reserved.filter(
        (name) => !managed.discovery.catalog.tools.some((tool) => tool.modelName === name),
      ),
      server: managed.server,
      signal,
    });
    const next = observeMcpCatalog(managed.catalogState, current.catalog);
    managed.catalogState = next;
    if (next.callsBlocked && next.changedCatalogSha256 !== null) {
      await this.options.events.append("mcp.catalog.changed", {
        catalog_sha256: managed.discovery.catalog.catalogSha256,
        changed_catalog_sha256: next.changedCatalogSha256,
        process_identity_sha256: managed.server.processIdentity.processIdentitySha256,
        server_id: managed.server.config.serverId,
      });
    }
  }
}

function callEventIdentity(
  action: McpToolCallActionIdentity,
  callId: string,
  approvalRequestId: string,
  step: number,
) {
  return {
    action_sha256: action.actionSha256,
    approval_request_id: approvalRequestId,
    arguments_sha256: action.argumentsSha256,
    call_id: callId,
    catalog_sha256: action.catalogSha256,
    config_sha256: action.configSha256,
    model_tool_name: action.modelToolName,
    process_identity_sha256: action.processIdentitySha256,
    raw_tool_name: action.rawToolName,
    schema_sha256: action.schemaSha256,
    server_id: action.serverId,
    step,
    timeout_ms: action.callTimeoutMs,
  } as const;
}
