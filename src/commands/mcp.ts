import type { CliIO, CliRuntime } from "../cli/types.js";
import { ArtifactSessionRuntime } from "../artifacts/artifact-session-runtime.js";
import { sha256Canonical } from "../completion/canonical-json.js";
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

function parsePromptArguments(values: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator < 1 ? "" : value.slice(0, separator);
    const argument = separator < 0 ? "" : value.slice(separator + 1);
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      /[\0\r\n]/u.test(key) ||
      Object.hasOwn(output, key)
    ) {
      throw new McpCoreError("mcp_prompt_arguments_invalid", "prompt --arg must be a unique key=value pair");
    }
    output[key] = argument;
  }
  return Object.freeze(output);
}

async function withPromptManager<T>(input: {
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly serverId?: string;
  readonly run: (manager: NonNullable<ReturnType<NonNullable<CliRuntime["createMcpClientManager"]>>>, audit: McpAuditLog, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (input.runtime.createMcpClientManager === undefined) {
    throw new McpCoreError("mcp_config_invalid", "this runtime does not support MCP");
  }
  const loaded = await new McpConfigLoader({ workspace: input.runtime.cwd }).load();
  if (loaded.status === "missing") throw new McpCoreError("mcp_config_missing", "local MCP config is missing");
  const configs = input.serverId === undefined
    ? Object.values(loaded.servers)
    : loaded.servers[input.serverId] === undefined
      ? []
      : [loaded.servers[input.serverId]!];
  if (configs.length === 0 || configs.length > 4) {
    throw new McpCoreError(
      "mcp_config_invalid",
      configs.length === 0 ? "unknown MCP server" : "select one server when more than four are configured",
    );
  }
  const audit = await McpAuditLog.create({ auditId: input.runtime.randomUUID(), workspace: input.runtime.cwd });
  const runId = input.runtime.randomUUID();
  const artifacts = await ArtifactSessionRuntime.create({
    eventAppender: audit,
    events: [],
    runId,
    sessionId: audit.auditId,
    workspace: input.runtime.cwd,
  });
  const controller = new AbortController();
  const stopListening = input.runtime.onCancel(() => controller.abort());
  const manager = input.runtime.createMcpClientManager({
    artifacts,
    events: audit,
    prompt: input.runtime.createApprovalPrompt(input.io),
  });
  try {
    await manager.startSelected({
      configs,
      reservedModelNames: [],
      signal: controller.signal,
      workspaceRealPath: loaded.workspaceRealPath,
    });
    return await input.run(manager, audit, controller.signal);
  } finally {
    stopListening();
    await manager.stopAll();
    await audit.close();
    input.io.stderr.write(`MCP audit: .bornagent/${audit.relativeRef}\n`);
  }
}

export async function executeMcpPromptsList(
  options: { readonly json: boolean; readonly serverId?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    const prompts = await withPromptManager({
      io,
      runtime,
      ...(options.serverId === undefined ? {} : { serverId: options.serverId }),
      run: async (manager) => manager.listPrompts(options.serverId),
    });
    if (options.json) io.stdout.write(`${JSON.stringify({ prompts })}\n`);
    else {
      for (const prompt of prompts) {
        io.stdout.write(`${String(prompt.server_id)}:${String(prompt.name)}\targs=${String(Array.isArray(prompt.arguments) ? prompt.arguments.length : 0)}\t${String(prompt.description ?? "")}\n`);
      }
    }
    return 0;
  } catch (error) {
    io.stderr.write(`born: MCP prompts list failed: ${safeMessage(error)}\n`);
    return error instanceof McpCoreError && error.code.includes("config") ? 2 : 1;
  }
}

export async function executeMcpPromptGet(
  selector: string,
  options: { readonly arguments: readonly string[]; readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  const separator = selector.indexOf(":");
  if (separator < 1 || separator === selector.length - 1) {
    io.stderr.write("usage/config error: prompt selector must be <server-id>:<prompt-name>\n");
    return 2;
  }
  const serverId = selector.slice(0, separator);
  const promptName = selector.slice(separator + 1);
  try {
    const argumentsValue = parsePromptArguments(options.arguments);
    const result = await withPromptManager({
      io,
      run: async (manager, audit, signal) => {
        const prompt = manager.listPrompts(serverId).find((candidate) => candidate.name === promptName);
        if (prompt === undefined) throw new McpCoreError("mcp_prompt_not_found", "MCP prompt selector has no exact frozen match");
        const invocationEventId = runtime.randomUUID();
        await audit.append("mcp.prompt.user.invoked", {
          arguments_sha256: sha256Canonical(argumentsValue),
          invocation_id: invocationEventId,
          selector,
          source: "cli",
        }, invocationEventId);
        return manager.getPrompt({
          argumentsValue,
          invocationEventId,
          invocationSource: "explicit_user",
          promptId: String(prompt.prompt_id),
          signal,
        });
      },
      runtime,
      serverId,
    });
    io.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${String(result.content)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`born: MCP prompt get failed: ${safeMessage(error)}\n`);
    return error instanceof McpCoreError && (error.code.includes("arguments") || error.code.includes("not_found")) ? 2 : 1;
  }
}

function safeMessage(error: unknown): string {
  const message =
    error instanceof McpCoreError || error instanceof Error
      ? error.message
      : "MCP operation failed";
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
