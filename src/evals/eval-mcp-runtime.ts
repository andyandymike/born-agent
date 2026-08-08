import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { McpApprovalGate, type McpEventAppender } from "../mcp/mcp-approval-gate.js";
import {
  createMcpServerStartActionIdentity,
} from "../mcp/mcp-action-identity.js";
import type { LoadedMcpServerConfig } from "../mcp/mcp-config-loader.js";
import { McpIntegrityManifestBuilder } from "../mcp/mcp-integrity-manifest.js";
import { createMcpProcessIdentity } from "../mcp/mcp-lifecycle.js";
import type {
  McpServerLauncher,
  StartedMcpServer,
} from "../mcp/mcp-server-launcher.js";
import type { PermissionEngineLike } from "../permissions/permission-types.js";
import type { EvalServiceMode } from "./eval-service-registry.js";

const EXECUTABLE_BYTES_SHA256 = "d".repeat(64);
const EXECUTABLE_IDENTITY_SHA256 = "e".repeat(64);

export class InProcessEvalMcpLauncher {
  readonly #started = new Map<string, StartedMcpServer>();

  public constructor(
    private readonly options: {
      readonly events: McpEventAppender;
      readonly mode: EvalServiceMode;
      readonly permissionEngine: PermissionEngineLike;
      readonly prompt: ApprovalPrompt;
      readonly randomUUID: () => string;
    },
  ) {}

  public async start(
    config: LoadedMcpServerConfig,
    workspaceRealPath: string,
    signal: AbortSignal,
    onToolsChanged: () => void,
  ): Promise<StartedMcpServer> {
    void onToolsChanged;
    const integrityManifest = await new McpIntegrityManifestBuilder({
      workspaceRealPath,
    }).build([]);
    const action = createMcpServerStartActionIdentity({
      args: config.args,
      canonicalCwd: config.canonicalCwd,
      configSha256: config.configSha256,
      env: config.env,
      environmentPolicyVersion: "phase14-eval-empty-env-v1",
      executable: {
        bytesSha256: EXECUTABLE_BYTES_SHA256,
        canonicalIdentitySha256: EXECUTABLE_IDENTITY_SHA256,
        logicalName: "eval-mcp-fixture",
        versionIdentity: "phase14-v1",
      },
      integrityManifest,
      serverId: config.serverId,
      startupTimeoutMs: config.startupTimeoutMs,
    });
    const permission = this.options.permissionEngine.evaluate(action, {
      reviewedOfflineMcpActionSha256: [action.actionSha256],
      reviewedOfflineMcpServerIds: [config.serverId],
    });
    await this.options.events.append("mcp.permission.evaluated", {
      action_kind: "mcp.server.start",
      action_sha256: action.actionSha256,
      effect: permission.effect,
      policy_version: permission.policyVersion,
      ...(permission.effect === "allow" ? {} : { reason_code: permission.reasonCode }),
      rule_id: permission.ruleId,
      server_id: config.serverId,
    });
    if (permission.effect === "deny") {
      throw new Error("eval MCP start was denied by the production permission engine");
    }
    let approvalRequestId = this.options.randomUUID();
    if (permission.effect === "ask") {
      const approval = await new McpApprovalGate({
        events: this.options.events,
        prompt: this.options.prompt,
        randomUUID: this.options.randomUUID,
      }).request(
        {
          actionKind: "mcp.server.start",
          actionSha256: action.actionSha256,
          reviewLines: [
            `server: ${config.serverId}`,
            "transport: in-process checked-in eval fixture",
          ],
          riskWarning: "eval fixture exposes no socket or host subprocess",
          serverId: config.serverId,
          title: "Start eval MCP fixture?",
        },
        signal,
      );
      approvalRequestId = approval.approvalRequestId;
      if (approval.decision !== "approved") {
        throw new Error("eval MCP start approval was denied");
      }
    }
    await this.options.events.append("mcp.server.start.requested", {
      action_sha256: action.actionSha256,
      approval_request_id: approvalRequestId,
      config_sha256: action.configSha256,
      env_mapping_sha256: action.envMappingSha256,
      executable_identity_sha256: action.executableIdentitySha256,
      integrity_binding: action.integrityBinding,
      integrity_manifest_sha256: action.integrityManifestSha256,
      server_id: config.serverId,
      startup_timeout_ms: config.startupTimeoutMs,
    });
    const processIdentity = createMcpProcessIdentity({
      hostFingerprint: "f".repeat(64),
      pid: 4242,
      processStartIdentity: `eval-in-process:${config.serverId}`,
    });
    await this.options.events.append("mcp.server.started", {
      action_sha256: action.actionSha256,
      config_sha256: config.configSha256,
      host_fingerprint: processIdentity.hostFingerprint,
      pid: processIdentity.pid,
      process_identity_sha256: processIdentity.processIdentitySha256,
      process_start_identity: processIdentity.processStartIdentity,
      sdk_version: "1.29.0",
      server_id: config.serverId,
    });

    const client = {
      negotiation: () => ({
        capabilities: Object.freeze({ tools: Object.freeze({}) }),
        protocolVersion: "2025-06-18",
        serverName: "bornagent-eval-fixture",
        serverVersion: "1",
      }),
      listTools: async () => [
        {
          description: "Search two deterministic public fixture files",
          inputSchema: {
            additionalProperties: false,
            properties: { query: { type: "string" } },
            required: ["query"],
            type: "object",
          },
          name: "search_two_files",
        },
      ],
      callTool: async (input: {
        readonly signal: AbortSignal;
        readonly timeoutMs: number;
      }) => {
        if (this.options.mode === "crash_before_result") {
          throw new Error("eval MCP fixture crashed before its result");
        }
        if (this.options.mode === "hang_after_start") {
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("eval MCP fixture was cancelled while hanging");
        }
        return {
          content: [
            {
              text: "search-two-files-v1:answer",
              type: "text",
            },
          ],
          isError: false,
        };
      },
    };
    // The actual MCP manager/catalog/validator/call path is used. Only the
    // transport endpoint is a checked-in in-process mock, so no child process
    // or socket can survive an injected crash boundary.
    const started = Object.freeze({
      action,
      authority: "reviewed_offline_fixture" as const,
      client,
      config,
      flushDiagnostics: async () => undefined,
      integrityManifest,
      processIdentity,
    }) as unknown as StartedMcpServer;
    this.#started.set(config.serverId, started);
    return started;
  }

  public async stop(server: StartedMcpServer): Promise<void> {
    await this.options.events.append("mcp.server.stopping", {
      active_call_count: 0,
      process_identity_sha256: server.processIdentity.processIdentitySha256,
      server_id: server.config.serverId,
    });
    await this.options.events.append("mcp.server.stopped", {
      cleanup_verified: true,
      host_fingerprint: server.processIdentity.hostFingerprint,
      pid: server.processIdentity.pid,
      process_identity_sha256: server.processIdentity.processIdentitySha256,
      process_start_identity: server.processIdentity.processStartIdentity,
      server_id: server.config.serverId,
      termination: "graceful",
    });
    this.#started.delete(server.config.serverId);
  }

  public asProductionPort(): McpServerLauncher {
    // McpClientManager currently types its launcher as the concrete production
    // class. This adapter intentionally implements only its public start/stop
    // surface and is confined to the eval-only dependency-injection root.
    return this as unknown as McpServerLauncher;
  }

  public identitySha256(): string {
    return sha256Canonical({
      kind: "in_process_eval_mcp",
      modes: [this.options.mode],
      version: 1,
    });
  }
}
