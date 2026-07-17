import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalPrompt } from "../../src/approvals/approval-types.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import { McpConfigLoader } from "../../src/mcp/mcp-config-loader.js";
import { phase12McpRunEventDataSchemas } from "../../src/mcp/mcp-event-schema.js";
import type {
  Phase12McpRunEventData,
  Phase12McpRunEventType,
} from "../../src/mcp/mcp-event-schema.js";
import { McpServerLauncher } from "../../src/mcp/mcp-server-launcher.js";
import { PermissionEngine } from "../../src/permissions/permission-engine.js";
import { localFreeOnlyPermissionPolicy } from "../../src/permissions/local-free-policy.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

const RAW_STDIO_SERVER = String.raw`
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "offline-test", version: "1" }
      }});
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
        name: "echo",
        description: "offline echo",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        }
      }] }});
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: "echo:" + message.params.arguments.text }]
      }});
    }
  }
});
`;

describe("Phase 12 offline stdio integration", () => {
  it("discovers, validates, separately approves, calls, and cleans up without a socket", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "bornagent-mcp-integration-"));
    temporaryDirectories.push(workspace);
    await mkdir(path.join(workspace, ".bornagent"), { recursive: true });
    await mkdir(path.join(workspace, "fixtures", "mcp"), { recursive: true });
    await writeFile(path.join(workspace, "fixtures", "mcp", "server.mjs"), RAW_STDIO_SERVER, "utf8");
    await writeFile(path.join(workspace, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      path.join(workspace, ".bornagent", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            executable: "node",
            args: ["fixtures/mcp/server.mjs"],
            cwd: ".",
            integrity_files: ["fixtures/mcp/server.mjs", "package.json", "pnpm-lock.yaml"],
            env: [],
            startup_timeout_ms: 5000,
            call_timeout_ms: 5000,
          },
        },
      }),
      "utf8",
    );
    const loaded = await new McpConfigLoader({ workspace }).load();
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") throw new Error("missing test config");

    const events: Array<{ readonly data: unknown; readonly type: string }> = [];
    const eventAppender = {
      append: async <TType extends Phase12McpRunEventType>(
        type: TType,
        data: Phase12McpRunEventData<TType>,
      ) => {
        phase12McpRunEventDataSchemas[type].parse(data);
        events.push({ data, type });
      },
    };
    const prompt: ApprovalPrompt = { request: async () => "approved" };
    const permissionEngine = new PermissionEngine(localFreeOnlyPermissionPolicy);
    const launcher = new McpServerLauncher({
      cleanup: {
        terminate: async (pid) => {
          if (pid !== undefined) {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              try {
                process.kill(pid, 0);
              } catch {
                return { detail: "clean", forced: false, verified: true } as const;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          return { detail: "force_failed", forced: false, verified: false } as const;
        },
      },
      environment: process.env,
      events: eventAppender,
      now: Date.now,
      permissionEngine,
      platform: process.platform,
      prompt,
      randomUUID,
      reviewOfflineStart: () => true,
      workspace,
    });
    const manager = new McpClientManager({
      events: eventAppender,
      launcher,
      permissionEngine,
      prompt,
      randomUUID,
    });
    const controller = new AbortController();
    const registrations = await manager.startSelected({
      configs: [loaded.servers.fixture!],
      reservedModelNames: ["read_file"],
      signal: controller.signal,
      workspaceRealPath: loaded.workspaceRealPath,
    });
    expect(registrations).toHaveLength(1);
    const registry = new ToolRegistry(registrations);
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify({ text: "hello" }),
        callId: "call-1",
        name: registrations[0]!.name,
        step: 1,
      },
      controller.signal,
    );
    expect(execution.ok).toBe(true);
    expect(execution.output).toContain("echo:hello");
    const inner = events.find((event) => event.type === "mcp.tool.call.completed");
    expect((inner?.data as { observation?: string }).observation).toBe(execution.output);
    expect(events.filter((event) => event.type === "mcp.approval.requested")).toHaveLength(2);

    await manager.stopAll();
    expect(events.at(-1)?.type).toBe("mcp.server.stopped");
  }, 20_000);

  it("accepts the exact checked-in SDK fixture manifest without a test review bypass", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "bornagent-mcp-reviewed-"));
    temporaryDirectories.push(workspace);
    await mkdir(path.join(workspace, ".bornagent"), { recursive: true });
    await mkdir(path.join(workspace, "fixtures", "mcp"), { recursive: true });
    await Promise.all([
      copyFile("fixtures/mcp/server.mjs", path.join(workspace, "fixtures", "mcp", "server.mjs")),
      copyFile("package.json", path.join(workspace, "package.json")),
      copyFile("pnpm-lock.yaml", path.join(workspace, "pnpm-lock.yaml")),
    ]);
    await symlink(
      path.resolve("node_modules"),
      path.join(workspace, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      path.join(workspace, ".bornagent", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            executable: "node",
            args: ["fixtures/mcp/server.mjs"],
            cwd: ".",
            integrity_files: ["fixtures/mcp/server.mjs", "package.json", "pnpm-lock.yaml"],
            env: [],
            startup_timeout_ms: 5000,
            call_timeout_ms: 5000,
          },
        },
      }),
      "utf8",
    );
    const loaded = await new McpConfigLoader({ workspace }).load();
    if (loaded.status !== "loaded") throw new Error("missing reviewed fixture config");
    const events: Array<{ readonly data: unknown; readonly type: string }> = [];
    const eventAppender = {
      append: async <TType extends Phase12McpRunEventType>(
        type: TType,
        data: Phase12McpRunEventData<TType>,
      ) => {
        phase12McpRunEventDataSchemas[type].parse(data);
        events.push({ data, type });
      },
    };
    const prompt: ApprovalPrompt = { request: async () => "approved" };
    const permissionEngine = new PermissionEngine(localFreeOnlyPermissionPolicy);
    const launcher = new McpServerLauncher({
      cleanup: {
        terminate: async (pid) => {
          if (pid !== undefined) {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              try {
                process.kill(pid, 0);
              } catch {
                return { detail: "clean", forced: false, verified: true } as const;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          return { detail: "force_failed", forced: false, verified: false } as const;
        },
      },
      environment: process.env,
      events: eventAppender,
      now: Date.now,
      permissionEngine,
      platform: process.platform,
      prompt,
      randomUUID,
      workspace,
    });
    const manager = new McpClientManager({
      events: eventAppender,
      launcher,
      permissionEngine,
      prompt,
      randomUUID,
    });
    const controller = new AbortController();
    const registrations = await manager.startSelected({
      configs: [loaded.servers.fixture!],
      reservedModelNames: [],
      signal: controller.signal,
      workspaceRealPath: loaded.workspaceRealPath,
    });
    const versionTool = registrations.find(
      (tool) => tool.origin.kind === "mcp" && tool.origin.rawName === "get_project_version",
    );
    expect(versionTool).toBeDefined();
    const execution = await new ToolRegistry([versionTool!]).execute(
      {
        argumentsJson: "{}",
        callId: "version-call",
        name: versionTool!.name,
        step: 1,
      },
      controller.signal,
    );
    expect(execution).toMatchObject({ ok: true });
    expect(execution.output).toContain("0.0.0");
    await manager.stopAll();
    expect(events.at(-1)?.type).toBe("mcp.server.stopped");
  }, 20_000);
});
