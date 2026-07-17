import { createHash } from "node:crypto";

import { canonicalJson } from "../completion/canonical-json.js";
import { sanitizeTerminalText } from "../tui/terminal-sanitizer.js";
import { McpCoreError } from "./mcp-errors.js";

export const MCP_RESULT_MAPPER_VERSION = "mcp-text-result-v1";
export const MAX_MCP_RESULT_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_RESULT_ITEMS = 256;

export interface MappedMcpResult {
  readonly bytes: number;
  readonly mapperVersion: typeof MCP_RESULT_MAPPER_VERSION;
  readonly observation: string;
  readonly observationSha256: string;
  readonly status: "error" | "success";
  readonly truncated: boolean;
}

interface MappedObservation {
  readonly is_error: boolean;
  readonly ok: boolean;
  readonly text: readonly string[];
  readonly truncated: boolean;
  readonly version: typeof MCP_RESULT_MAPPER_VERSION;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) {
    return null;
  }
  if (
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.get !== undefined || descriptor?.set !== undefined;
    })
  ) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function structuredContentIsNonempty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Reflect.ownKeys(value).length > 0;
  return true;
}

function observationJson(
  texts: readonly string[],
  isError: boolean,
  truncated: boolean,
): string {
  const observation: MappedObservation = {
    is_error: isError,
    ok: !isError,
    text: texts,
    truncated,
    version: MCP_RESULT_MAPPER_VERSION,
  };
  return canonicalJson(observation);
}

function takeCharacters(texts: readonly string[], limit: number): readonly string[] {
  let remaining = limit;
  return texts.map((text) => {
    if (remaining <= 0) return "";
    const characters = [...text];
    const selected = characters.slice(0, remaining).join("");
    remaining -= characters.length;
    return selected;
  });
}

function boundedObservation(
  texts: readonly string[],
  isError: boolean,
  maximumBytes: number,
): { readonly observation: string; readonly truncated: boolean } {
  const complete = observationJson(texts, isError, false);
  if (Buffer.byteLength(complete, "utf8") <= maximumBytes) {
    return { observation: complete, truncated: false };
  }
  const empty = observationJson(texts.map(() => ""), isError, true);
  if (Buffer.byteLength(empty, "utf8") > maximumBytes) {
    throw new McpCoreError("mcp_result_limit", "MCP result bound cannot hold its structural envelope");
  }
  const totalCharacters = texts.reduce((total, text) => total + [...text].length, 0);
  let low = 0;
  let high = totalCharacters;
  let best = empty;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = observationJson(takeCharacters(texts, middle), isError, true);
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { observation: best, truncated: true };
}

export function mapMcpTextResult(
  input: unknown,
  options: {
    readonly maxObservationBytes: number;
    readonly secrets?: readonly (string | undefined)[];
  },
): MappedMcpResult {
  if (!Number.isSafeInteger(options.maxObservationBytes) || options.maxObservationBytes <= 0) {
    throw new McpCoreError("mcp_result_limit", "MCP observation limit must be positive");
  }
  const result = plainRecord(input);
  if (result === null) {
    throw new McpCoreError("mcp_result_invalid", "MCP result must be a plain object");
  }
  const allowedKeys = new Set(["content", "isError", "structuredContent"]);
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
    throw new McpCoreError("mcp_result_content_unsupported", "MCP result contains unsupported fields");
  }
  if (structuredContentIsNonempty(result.structuredContent)) {
    throw new McpCoreError(
      "mcp_result_content_unsupported",
      "MCP structured content is unsupported in text-only mode",
    );
  }
  if (!Array.isArray(result.content) || result.content.length > MAX_MCP_RESULT_ITEMS) {
    throw new McpCoreError("mcp_result_invalid", "MCP result content must be a bounded array");
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new McpCoreError("mcp_result_invalid", "MCP isError must be boolean");
  }
  let sourceBytes = 0;
  const texts = result.content.map((item, index) => {
    const record = plainRecord(item);
    if (
      record === null ||
      Object.keys(record).some((key) => key !== "type" && key !== "text") ||
      record.type !== "text" ||
      typeof record.text !== "string"
    ) {
      throw new McpCoreError(
        "mcp_result_content_unsupported",
        `MCP content item ${index} is not a supported text item`,
      );
    }
    sourceBytes += Buffer.byteLength(record.text, "utf8");
    if (sourceBytes > MAX_MCP_RESULT_SOURCE_BYTES) {
      throw new McpCoreError("mcp_result_limit", "MCP result source exceeds 4 MiB");
    }
    // PHASE12: server result text is untrusted data. It is redacted and stripped
    // of terminal controls before it can become a model observation or UI text.
    return sanitizeTerminalText(record.text, {
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    });
  });
  const isError = result.isError === true;
  const bounded = boundedObservation(texts, isError, options.maxObservationBytes);
  const bytes = Buffer.byteLength(bounded.observation, "utf8");
  return Object.freeze({
    bytes,
    mapperVersion: MCP_RESULT_MAPPER_VERSION,
    observation: bounded.observation,
    observationSha256: createHash("sha256")
      .update(bounded.observation, "utf8")
      .digest("hex"),
    status: isError ? "error" : "success",
    truncated: bounded.truncated,
  });
}

export function recoverDurableMappedMcpResult(input: {
  readonly bytes: number;
  readonly mapperVersion: string;
  readonly observation: string;
  readonly observationSha256: string;
  readonly status: "error" | "success";
  readonly truncated: boolean;
}): MappedMcpResult {
  // PHASE12: once the inner call completed, recovery may only reuse its exact
  // durable mapped bytes; calling the MCP server again could duplicate an effect.
  const actualSha256 = createHash("sha256")
    .update(input.observation, "utf8")
    .digest("hex");
  if (
    input.mapperVersion !== MCP_RESULT_MAPPER_VERSION ||
    input.bytes !== Buffer.byteLength(input.observation, "utf8") ||
    input.observationSha256 !== actualSha256
  ) {
    throw new McpCoreError("mcp_result_invalid", "durable MCP mapped result cannot be verified");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.observation) as unknown;
  } catch {
    throw new McpCoreError("mcp_result_invalid", "durable MCP observation is not valid JSON");
  }
  const record = plainRecord(decoded);
  if (
    record === null ||
    Object.keys(record).sort().join(",") !==
      "is_error,ok,text,truncated,version" ||
    !Array.isArray(record.text) ||
    record.text.some((entry) => typeof entry !== "string") ||
    typeof record.is_error !== "boolean" ||
    typeof record.ok !== "boolean" ||
    typeof record.truncated !== "boolean" ||
    record.version !== MCP_RESULT_MAPPER_VERSION ||
    record.truncated !== input.truncated ||
    record.is_error !== (input.status === "error") ||
    record.ok !== (input.status === "success")
  ) {
    throw new McpCoreError("mcp_result_invalid", "durable MCP result metadata does not match its observation");
  }
  return Object.freeze({
    bytes: input.bytes,
    mapperVersion: MCP_RESULT_MAPPER_VERSION,
    observation: input.observation,
    observationSha256: input.observationSha256,
    status: input.status,
    truncated: input.truncated,
  });
}
