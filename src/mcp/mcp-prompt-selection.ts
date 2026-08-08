import { McpCoreError } from "./mcp-errors.js";

const SERVER_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

export interface ExplicitMcpPromptSelection {
  readonly argumentsValue: Readonly<Record<string, string>>;
  readonly promptName: string;
  readonly selector: string;
  readonly serverId: string;
}

function validUnicode(value: string): boolean {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) === value;
}

function parseArguments(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined) return Object.freeze({});
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024 || !validUnicode(raw)) {
    throw new McpCoreError(
      "mcp_prompt_arguments_invalid",
      "MCP prompt arguments JSON must be valid UTF-8 and at most 64 KiB",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new McpCoreError(
      "mcp_prompt_arguments_invalid",
      "MCP prompt arguments must be a JSON object with string values",
    );
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new McpCoreError(
      "mcp_prompt_arguments_invalid",
      "MCP prompt arguments must be a JSON object with string values",
    );
  }
  const entries = Object.entries(decoded as Readonly<Record<string, unknown>>);
  if (entries.length > 64) {
    throw new McpCoreError(
      "mcp_prompt_arguments_invalid",
      "MCP prompt arguments exceed 64 entries",
    );
  }
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      /[\0\r\n]/u.test(key) ||
      typeof value !== "string" ||
      !validUnicode(value) ||
      value.includes("\0")
    ) {
      throw new McpCoreError(
        "mcp_prompt_arguments_invalid",
        "MCP prompt arguments must have bounded keys and valid string values",
      );
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>,
  );
}

export function parseExplicitMcpPromptSelection(input: {
  readonly argumentsJson?: string | undefined;
  readonly selectedServerIds: readonly string[];
  readonly selector?: string | undefined;
}): ExplicitMcpPromptSelection | undefined {
  if (input.selector === undefined) {
    if (input.argumentsJson !== undefined) {
      throw new McpCoreError(
        "mcp_prompt_arguments_invalid",
        "MCP prompt arguments require one explicit prompt selection",
      );
    }
    return undefined;
  }
  const separator = input.selector.indexOf(":");
  const serverId = separator < 0 ? "" : input.selector.slice(0, separator);
  const promptName = separator < 0 ? "" : input.selector.slice(separator + 1);
  if (
    !SERVER_ID.test(serverId) ||
    promptName.length === 0 ||
    Buffer.byteLength(promptName, "utf8") > 512 ||
    /[\0\r\n]/u.test(promptName) ||
    !validUnicode(promptName) ||
    Buffer.byteLength(input.selector, "utf8") > 640
  ) {
    throw new McpCoreError(
      "mcp_prompt_not_found",
      "MCP prompt selector must be <selected-server-id>:<prompt-name>",
    );
  }
  if (!input.selectedServerIds.includes(serverId)) {
    throw new McpCoreError(
      "mcp_prompt_not_found",
      "MCP prompt selection requires its exact server in --mcp",
    );
  }
  return Object.freeze({
    argumentsValue: parseArguments(input.argumentsJson),
    promptName,
    selector: input.selector,
    serverId,
  });
}
