import type { CliIO, CliRuntime } from "../cli/types.js";
import { McpAuditLog } from "../mcp/mcp-audit-log.js";
import { McpConfigLoader } from "../mcp/mcp-config-loader.js";
import { McpCoreError } from "../mcp/mcp-errors.js";

export async function executeMcpList(
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1> {
  try {
    const loaded = await new McpConfigLoader({ workspace: runtime.cwd }).load();
    if (loaded.status === "missing") {
      io.stdout.write("No MCP servers configured.\n");
      return 0;
    }
    for (const server of Object.values(loaded.servers)) {
      io.stdout.write(
        `${server.serverId}\ttransport=stdio\texecutable=${server.executable}\tcwd=${server.canonicalCwd}\tintegrity=${server.integrityFiles.length === 0 ? "not_bound" : "explicit"}\n`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr.write(`born: MCP config error: ${safeMessage(error)}\n`);
    return 1;
  }
}

export async function executeMcpInspect(
  serverId: string,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(serverId)) {
    io.stderr.write("usage/config error: invalid MCP server id\n");
    return 2;
  }
  if (runtime.createMcpClientManager === undefined) {
    io.stderr.write("usage/config error: this runtime does not support MCP\n");
    return 2;
  }
  const loaded = await new McpConfigLoader({ workspace: runtime.cwd }).load().catch((error: unknown) => {
    io.stderr.write(`born: MCP config error: ${safeMessage(error)}\n`);
    return null;
  });
  if (loaded === null) return 1;
  if (loaded.status === "missing" || loaded.servers[serverId] === undefined) {
    io.stderr.write(`usage/config error: unknown MCP server id: ${serverId}\n`);
    return 2;
  }
  let audit: McpAuditLog;
  try {
    audit = await McpAuditLog.create({
      auditId: runtime.randomUUID(),
      workspace: runtime.cwd,
    });
  } catch {
    io.stderr.write("born: MCP audit storage error\n");
    return 1;
  }
  const controller = new AbortController();
  const stopListening = runtime.onCancel(() => controller.abort());
  const manager = runtime.createMcpClientManager({
    events: audit,
    prompt: runtime.createApprovalPrompt(io),
  });
  let result: 0 | 1;
  try {
    const tools = await manager.startSelected({
      configs: [loaded.servers[serverId]],
      reservedModelNames: [],
      signal: controller.signal,
      workspaceRealPath: loaded.workspaceRealPath,
    });
    io.stdout.write(`MCP server ${serverId}\n`);
    for (const tool of tools) {
      const origin = tool.origin.kind === "mcp" ? tool.origin : undefined;
      io.stdout.write(
        `  ${tool.name}\traw=${origin?.rawName ?? "unknown"}\tschema=${tool.validator.schemaSha256}\tstrict=${String(tool.validator.strictForModel)}\n`,
      );
    }
    io.stderr.write(`MCP audit: .bornagent/${audit.relativeRef}\n`);
    result = 0;
  } catch (error) {
    io.stderr.write(`born: MCP inspect failed: ${safeMessage(error)}\n`);
    result = 1;
  } finally {
    stopListening();
    try {
      await manager.stopAll();
    } catch {
      io.stderr.write("born: MCP process cleanup could not be verified\n");
      result = 1;
    }
    await audit.close().catch(() => {
      result = 1;
    });
  }
  return result;
}

function safeMessage(error: unknown): string {
  const message =
    error instanceof McpCoreError || error instanceof Error
      ? error.message
      : "MCP operation failed";
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
