import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalPrompt } from "../../src/approvals/approval-types.js";
import { DefaultCapabilityPlatform } from "../../src/capabilities/capability-platform.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { createFrozenCapabilityMcpConfig } from "../../src/mcp/mcp-capability-config.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import {
  phase12McpRunEventDataSchemas,
  type Phase12McpRunEventData,
  type Phase12McpRunEventType,
} from "../../src/mcp/mcp-event-schema.js";
import { McpServerLauncher } from "../../src/mcp/mcp-server-launcher.js";
import { PermissionEngine } from "../../src/permissions/permission-engine.js";
import { localFreeOnlyPermissionPolicy } from "../../src/permissions/local-free-policy.js";
import { PluginLifecycle } from "../../src/plugins/plugin-lifecycle.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 18E Plugin-contained MCP", () => {
  it("starts exact frozen script bytes through the host Node executable and keeps every action ask-gated", async () => {
    const base = await mkdtemp(join(tmpdir(), "bornagent-phase18e-plugin-mcp-"));
    temporary.push(base);
    const workspace = join(base, "workspace");
    const userRoot = join(base, "user");
    const builtinRoot = join(base, "builtin");
    await Promise.all([mkdir(workspace), mkdir(builtinRoot)]);
    await writeFile(join(builtinRoot, "index.json"), `${canonicalJson({ packages: [], revision: 1, schema_version: 1 })}\n`, "utf8");
    const lifecycle = new PluginLifecycle({
      isProcessAlive: (pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      },
      now: () => new Date().toISOString(),
      randomUUID,
      root: userRoot,
      workspace,
    });
    const installed = await lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    await lifecycle.enable(installed.exactSelector);
    const platform = new DefaultCapabilityPlatform({
      builtinRoot,
      env: process.env,
      platform: process.platform,
      pluginLifecycle: lifecycle,
      userStateRoot: userRoot,
      workspace,
    });
    const snapshot = await platform.createSnapshot(new Date().toISOString());
    const config = await createFrozenCapabilityMcpConfig({
      content: platform.createContentSource(snapshot),
      hostExecutable: process.execPath,
      selector: "offline-docs",
      snapshot,
      workspace,
    });
    expect(config).toMatchObject({
      canonicalCwd: "plugin_root",
      origin: "capability_snapshot",
      serverId: "offline-docs",
    });
    expect(config?.args[0]).toContain("capability:user_install:");
    expect(config?.spawnArgs?.[0]).toContain("server.mjs");

    const events: Array<{ readonly type: string }> = [];
    const appender = {
      append: async <TType extends Phase12McpRunEventType>(
        type: TType,
        data: Phase12McpRunEventData<TType>,
      ) => {
        phase12McpRunEventDataSchemas[type].parse(data);
        events.push({ type });
      },
    };
    const approvals: ApprovalPrompt = { request: async () => "approved" };
    const permissions = new PermissionEngine(localFreeOnlyPermissionPolicy);
    const launcher = new McpServerLauncher({
      cleanup: {
        terminate: async (pid) => {
          if (pid !== undefined) {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              try { process.kill(pid, 0); } catch { return { detail: "clean", forced: false, verified: true } as const; }
              await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
          }
          return { detail: "force_failed", forced: false, verified: false } as const;
        },
      },
      environment: process.env,
      events: appender,
      now: Date.now,
      permissionEngine: permissions,
      platform: process.platform,
      prompt: approvals,
      randomUUID,
      reviewOfflineStart: () => false,
      workspace,
    });
    const manager = new McpClientManager({
      events: appender,
      launcher,
      permissionEngine: permissions,
      prompt: approvals,
      randomUUID,
    });
    const controller = new AbortController();
    try {
      const tools = await manager.startSelected({
        configs: [config!],
        reservedModelNames: [],
        signal: controller.signal,
        workspaceRealPath: workspace,
      });
      const echo = tools.find((tool) => tool.name.endsWith("__echo"));
      expect(echo).toBeDefined();
      const result = await new ToolRegistry(tools).execute({
        argumentsJson: JSON.stringify({ text: "offline" }),
        callId: "plugin-echo",
        name: echo!.name,
        step: 1,
      }, controller.signal);
      expect(result).toMatchObject({ ok: true });
      expect(result.output).toContain("echo:offline");
      expect(events.map((event) => event.type)).toContain("mcp.server.negotiated");
    } finally {
      await manager.stopAll();
    }
  }, 30_000);
});
