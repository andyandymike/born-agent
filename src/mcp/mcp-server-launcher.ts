import { createHash } from "node:crypto";
import path from "node:path";

import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { ProcessTreeCleanup } from "../execution/process-tree-cleanup.js";
import type { PermissionEngineLike } from "../permissions/permission-types.js";
import { currentHostFingerprint } from "../sessions/process-identity.js";
import { sanitizeTerminalText } from "../tui/terminal-sanitizer.js";
import {
  createMcpServerStartActionIdentity,
  type McpServerStartActionIdentity,
} from "./mcp-action-identity.js";
import { McpApprovalGate, type McpEventAppender } from "./mcp-approval-gate.js";
import type { LoadedMcpServerConfig } from "./mcp-config-loader.js";
import { McpConfigLoader } from "./mcp-config-loader.js";
import { buildMinimalMcpEnvironment, MCP_ENVIRONMENT_POLICY_VERSION } from "./mcp-environment.js";
import { McpCoreError } from "./mcp-errors.js";
import {
  recheckMcpExecutable,
  resolveMcpExecutable,
  type ResolvedMcpExecutable,
} from "./mcp-executable-resolver.js";
import {
  McpIntegrityManifestBuilder,
  type McpIntegrityManifest,
} from "./mcp-integrity-manifest.js";
import { createMcpProcessIdentity, type McpProcessIdentity } from "./mcp-lifecycle.js";
import { isCheckedInOfflineFixture } from "./mcp-offline-fixture-policy.js";
import { StdioMcpClient } from "./stdio-mcp-client.js";

export interface StartedMcpServer {
  readonly action: McpServerStartActionIdentity;
  readonly client: StdioMcpClient;
  readonly config: LoadedMcpServerConfig;
  readonly integrityManifest: McpIntegrityManifest;
  readonly processIdentity: McpProcessIdentity;
  readonly authority: "frozen_capability" | "reviewed_offline_fixture";
  flushDiagnostics(): Promise<void>;
}

function startIdentity(pid: number, randomUUID: () => string, now: () => number): string {
  return createHash("sha256")
    .update(`${currentHostFingerprint()}\0${pid}\0${now()}\0${randomUUID()}`, "utf8")
    .digest("hex");
}

export class McpServerLauncher {
  private readonly approval: McpApprovalGate;

  public constructor(
    private readonly options: {
      readonly cleanup: ProcessTreeCleanup;
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly events: McpEventAppender;
      readonly now: () => number;
      readonly permissionEngine: PermissionEngineLike;
      readonly platform: NodeJS.Platform;
      readonly prompt: ApprovalPrompt;
      readonly randomUUID: () => string;
      readonly reviewOfflineStart?: typeof isCheckedInOfflineFixture;
      readonly workspace: string;
    },
  ) {
    this.approval = new McpApprovalGate({
      events: options.events,
      prompt: options.prompt,
      randomUUID: options.randomUUID,
    });
  }

  public async start(
    config: LoadedMcpServerConfig,
    workspaceRealPath: string,
    signal: AbortSignal,
    onToolsChanged: () => void,
    onResourcesChanged?: () => void,
    onPromptsChanged?: () => void,
  ): Promise<StartedMcpServer> {
    const executable = await resolveMcpExecutable({
      environment: this.options.environment,
      executable: config.executable,
      platform: this.options.platform,
    });
    const manifestBuilder = new McpIntegrityManifestBuilder({
      workspaceRealPath: config.integrityRoot ?? workspaceRealPath,
    });
    const integrityManifest = await manifestBuilder.build(config.integrityFiles);
    const action = createMcpServerStartActionIdentity({
      args: config.args,
      canonicalCwd: config.canonicalCwd,
      configSha256: config.configSha256,
      env: config.env,
      environmentPolicyVersion: MCP_ENVIRONMENT_POLICY_VERSION,
      executable: executable.identity,
      integrityManifest,
      serverId: config.serverId,
      startupTimeoutMs: config.startupTimeoutMs,
    });
    const reviewedOffline = (this.options.reviewOfflineStart ?? isCheckedInOfflineFixture)({
      action,
      config,
      manifest: integrityManifest,
    });
    const frozenCapability = config.origin === "capability_snapshot";
    const permission = this.options.permissionEngine.evaluate(action, {
      ...(reviewedOffline
        ? {
            reviewedOfflineMcpActionSha256: [action.actionSha256],
            reviewedOfflineMcpServerIds: [config.serverId],
          }
        : {}),
      ...(frozenCapability
        ? { frozenCapabilityMcpActionSha256: [action.actionSha256] }
        : {}),
    });
    await this.options.events.append("mcp.permission.evaluated", {
      action_kind: action.actionKind,
      action_sha256: action.actionSha256,
      effect: permission.effect,
      policy_version: permission.policyVersion,
      ...(permission.effect === "allow" ? {} : { reason_code: permission.reasonCode }),
      rule_id: permission.ruleId,
      server_id: config.serverId,
    });
    if (permission.effect === "deny" || (!reviewedOffline && !frozenCapability)) {
      throw new McpCoreError(
        "mcp_permission_denied",
        "MCP start is neither an exact reviewed fixture nor a run-frozen enabled capability action",
      );
    }

    let approvalRequestId: string | undefined;
    if (permission.effect === "ask") {
      const approval = await this.approval.request(
        {
          actionKind: "mcp.server.start",
          actionSha256: action.actionSha256,
          reviewLines: [
            `server: ${config.serverId}`,
            `executable: ${action.argv[0]}`,
            ...action.argv.slice(1).map((argument, index) => `argv[${index}]: ${argument}`),
            `cwd: ${config.canonicalCwd}`,
            ...config.env.map((mapping) => `env: ${mapping.source} -> ${mapping.target} (value hidden)`),
            integrityManifest.binding === "explicit"
              ? `server code integrity: ${integrityManifest.entries.length} explicit file(s)`
              : "server code integrity: not bound",
            frozenCapability
              ? "authority: user-enabled run-frozen Plugin (does not grant effects)"
              : "authority: checked-in reviewed offline fixture",
          ],
          riskWarning: "approval and shell:false do not sandbox this host process",
          serverId: config.serverId,
          title: "Start MCP server?",
        },
        signal,
      );
      approvalRequestId = approval.approvalRequestId;
      if (approval.decision !== "approved") {
        throw new McpCoreError("mcp_approval_denied", "MCP server start was not approved");
      }
    }
    if (approvalRequestId === undefined) approvalRequestId = this.options.randomUUID();

    await this.recheck(config, executable, integrityManifest, manifestBuilder);
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

    const environment = buildMinimalMcpEnvironment({
      mappings: config.env,
      sourceEnvironment: this.options.environment,
    });
    let processIdentity: McpProcessIdentity | undefined;
    let startedDurable = false;
    let stderrBytes = 0;
    const diagnosticTasks: Promise<void>[] = [];
    const client = new StdioMcpClient({
      args: config.spawnArgs ?? config.args,
      command: executable.canonicalPath,
      cwd: config.executionCwd ?? path.resolve(workspaceRealPath, config.canonicalCwd),
      environment,
      onSpawned: async (pid) => {
        processIdentity = createMcpProcessIdentity({
          hostFingerprint: currentHostFingerprint(),
          pid,
          processStartIdentity: startIdentity(pid, this.options.randomUUID, this.options.now),
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
        startedDurable = true;
      },
      onStderr: (chunk) => {
        if (processIdentity === undefined || stderrBytes >= 64 * 1024) return;
        const remaining = 64 * 1024 - stderrBytes;
        const source = Buffer.from(chunk).subarray(0, remaining);
        const sanitized = sanitizeTerminalText(source.toString("utf8"), {
          secrets: config.env.map((mapping) => this.options.environment[mapping.source]),
        });
        if (sanitized.length === 0) return;
        const bytes = Buffer.byteLength(sanitized, "utf8");
        stderrBytes += bytes;
        diagnosticTasks.push(
          this.options.events.append("mcp.server.stderr", {
            bytes,
            chunk: sanitized,
            process_identity_sha256: processIdentity.processIdentitySha256,
            server_id: config.serverId,
            truncated: source.byteLength < chunk.byteLength || stderrBytes >= 64 * 1024,
          }),
        );
      },
      ...(onPromptsChanged === undefined ? {} : { onPromptsChanged }),
      ...(onResourcesChanged === undefined ? {} : { onResourcesChanged }),
      onToolsChanged,
    });

    try {
      await client.connect({ signal, timeoutMs: config.startupTimeoutMs });
    } catch (error) {
      await this.handleStartFailure({
        action,
        client,
        processIdentity,
        serverId: config.serverId,
        startedDurable,
      });
      throw new McpCoreError(
        startedDurable ? "mcp_protocol_failed" : processIdentity === undefined ? "mcp_start_failed" : "mcp_effect_unknown",
        "MCP server did not complete a safe stdio startup",
        { cause: error },
      );
    }
    if (processIdentity === undefined || !startedDurable) {
      throw new McpCoreError("mcp_effect_unknown", "MCP process identity was not durably established");
    }
    return Object.freeze({
      action,
      authority: frozenCapability ? "frozen_capability" as const : "reviewed_offline_fixture" as const,
      client,
      config,
      flushDiagnostics: async () => {
        await Promise.all(diagnosticTasks.splice(0));
      },
      integrityManifest,
      processIdentity,
    });
  }

  public async stop(server: StartedMcpServer): Promise<void> {
    await server.flushDiagnostics();
    await this.options.events.append("mcp.server.stopping", {
      active_call_count: 0,
      process_identity_sha256: server.processIdentity.processIdentitySha256,
      server_id: server.config.serverId,
    });
    try {
      await server.client.close();
    } catch {
      // Process-tree verification below is authoritative.
    }
    const cleanup = await this.options.cleanup.terminate(server.processIdentity.pid);
    if (!cleanup.verified) {
      throw new McpCoreError("mcp_effect_unknown", "MCP process-tree cleanup could not be verified");
    }
    // PHASE12: SDK close only requests protocol shutdown. Completion is durable
    // only after the recorded process identity and its tree are confirmed gone.
    await this.options.events.append("mcp.server.stopped", {
      cleanup_verified: true,
      host_fingerprint: server.processIdentity.hostFingerprint,
      pid: server.processIdentity.pid,
      process_identity_sha256: server.processIdentity.processIdentitySha256,
      process_start_identity: server.processIdentity.processStartIdentity,
      server_id: server.config.serverId,
      termination: cleanup.forced ? "forced" : "graceful",
    });
  }

  private async recheck(
    config: LoadedMcpServerConfig,
    executable: ResolvedMcpExecutable,
    manifest: McpIntegrityManifest,
    manifestBuilder: McpIntegrityManifestBuilder,
  ): Promise<void> {
    if (config.origin === "capability_snapshot") {
      await Promise.all([
        config.revalidate?.(),
        manifestBuilder.recheck(manifest),
        recheckMcpExecutable(executable, {
          environment: this.options.environment,
          executable: config.executable,
          platform: this.options.platform,
        }),
      ]);
      return;
    }
    const loaded = await new McpConfigLoader({ workspace: this.options.workspace }).load();
    const current = loaded.status === "loaded" ? loaded.servers[config.serverId] : undefined;
    if (current?.configSha256 !== config.configSha256) {
      throw new McpCoreError("mcp_config_invalid", "MCP config changed after approval");
    }
    await Promise.all([
      manifestBuilder.recheck(manifest),
      recheckMcpExecutable(executable, {
        environment: this.options.environment,
        executable: config.executable,
        platform: this.options.platform,
      }),
    ]);
  }

  private async handleStartFailure(input: {
    readonly action: McpServerStartActionIdentity;
    readonly client: StdioMcpClient;
    readonly processIdentity: McpProcessIdentity | undefined;
    readonly serverId: string;
    readonly startedDurable: boolean;
  }): Promise<void> {
    if (input.processIdentity === undefined) {
      await this.options.events.append("mcp.server.start.failed", {
        action_sha256: input.action.actionSha256,
        code: "spawn_rejected",
        effect: "not_started",
        server_id: input.serverId,
        zero_process_proof_sha256: sha256Canonical({
          action_sha256: input.action.actionSha256,
          proof: "transport_pid_never_observed",
        }),
      });
      return;
    }
    if (!input.startedDurable) {
      try {
        await this.options.events.append("mcp.server.start.effect_unknown", {
          action_sha256: input.action.actionSha256,
          code: "started_event_not_durable",
          server_id: input.serverId,
        });
      } catch {
        // The writer is already untrusted; do not invent a terminal fact.
      }
    } else {
      await this.options.events.append("mcp.server.stopping", {
        active_call_count: 0,
        process_identity_sha256: input.processIdentity.processIdentitySha256,
        server_id: input.serverId,
      });
    }
    try {
      await input.client.close();
    } catch {
      // Continue to process-tree cleanup.
    }
    const cleanup = await this.options.cleanup.terminate(input.processIdentity.pid);
    if (input.startedDurable && cleanup.verified) {
      await this.options.events.append("mcp.server.stopped", {
        cleanup_verified: true,
        host_fingerprint: input.processIdentity.hostFingerprint,
        pid: input.processIdentity.pid,
        process_identity_sha256: input.processIdentity.processIdentitySha256,
        process_start_identity: input.processIdentity.processStartIdentity,
        server_id: input.serverId,
        termination: cleanup.forced ? "forced" : "graceful",
      });
    }
  }
}
