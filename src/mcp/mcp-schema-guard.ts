import { createHash } from "node:crypto";

import { canonicalJson } from "../completion/canonical-json.js";
import { sanitizeTerminalText } from "../tui/terminal-sanitizer.js";
import { McpCoreError } from "./mcp-errors.js";

export const MAX_MCP_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_SCHEMA_DEPTH = 16;
export const MAX_MCP_SCHEMA_PROPERTIES = 256;
export const MAX_MCP_SCHEMA_ENUM_ITEMS = 512;
export const MAX_MCP_SCHEMA_PATTERN_CHARS = 1024;
export const MAX_MCP_DESCRIPTION_BYTES = 4 * 1024;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const JSON_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const ALLOWED_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
  "uniqueItems",
]);
const ACCEPTED_META_SCHEMAS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
]);

type JsonPrimitive = boolean | null | number | string;
interface SafeJsonObject {
  readonly [key: string]: SafeJsonValue;
}
type SafeJsonValue = JsonPrimitive | readonly SafeJsonValue[] | SafeJsonObject;
type SafeSchema = boolean | SafeJsonObject;

interface GuardState {
  enumItems: number;
  nodes: number;
  properties: number;
  readonly refEdges: Map<string, readonly string[]>;
  readonly seen: Set<object>;
}

export interface GuardedMcpSchema {
  readonly modelSchema: Readonly<Record<string, unknown>>;
  readonly schemaSha256: string;
  readonly strictForModel: boolean;
}

function schemaError(
  code: "mcp_schema_invalid" | "mcp_schema_limit" | "mcp_schema_ref_unsafe",
  message: string,
): never {
  throw new McpCoreError(code, message);
}

function safeRecordEntries(value: unknown, label: string): readonly [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return schemaError("mcp_schema_invalid", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return schemaError("mcp_schema_invalid", `${label} must be a plain object`);
  }
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      return schemaError("mcp_schema_invalid", `${label} contains an unsafe key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      return schemaError("mcp_schema_invalid", `${label} must not contain accessors`);
    }
    entries.push([key, descriptor?.value]);
  }
  return entries;
}

function safeArrayValues(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return schemaError("mcp_schema_invalid", `${label} must be an array`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      return schemaError("mcp_schema_invalid", `${label} contains an unsafe array key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      return schemaError("mcp_schema_invalid", `${label} must not contain accessors`);
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return schemaError("mcp_schema_invalid", `${label} must not contain holes`);
    }
    output.push(Object.getOwnPropertyDescriptor(value, String(index))?.value);
  }
  return output;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  state: GuardState,
  label: string,
): SafeJsonValue {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return schemaError("mcp_schema_limit", "MCP schema value nesting exceeds 16");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return schemaError("mcp_schema_invalid", `${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    return schemaError("mcp_schema_invalid", `${label} is not JSON data`);
  }
  if (state.seen.has(value)) {
    return schemaError("mcp_schema_invalid", "MCP schema must not be cyclic");
  }
  state.seen.add(value);
  let cloned: SafeJsonValue;
  if (Array.isArray(value)) {
    cloned = Object.freeze(
      safeArrayValues(value, label).map((entry, index) =>
        cloneJsonValue(entry, depth + 1, state, `${label}[${index}]`),
      ),
    );
  } else {
    const output: Record<string, SafeJsonValue> = Object.create(null) as Record<
      string,
      SafeJsonValue
    >;
    for (const [key, entry] of safeRecordEntries(value, label)) {
      output[key] = cloneJsonValue(entry, depth + 1, state, `${label}.${key}`);
    }
    cloned = Object.freeze(output);
  }
  state.seen.delete(value);
  return cloned;
}

function pointerPath(parent: string, key: string): string {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function cloneSchemaMap(
  value: unknown,
  depth: number,
  state: GuardState,
  path: string,
  countProperties: boolean,
): Readonly<Record<string, SafeJsonValue>> {
  const output: Record<string, SafeJsonValue> = Object.create(null) as Record<
    string,
    SafeJsonValue
  >;
  const entries = safeRecordEntries(value, path);
  if (countProperties) {
    state.properties += entries.length;
    if (state.properties > MAX_MCP_SCHEMA_PROPERTIES) {
      return schemaError("mcp_schema_limit", "MCP schema contains more than 256 properties");
    }
  }
  for (const [key, child] of entries) {
    if (
      Buffer.byteLength(key, "utf8") > 512 ||
      [...key].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      })
    ) {
      return schemaError("mcp_schema_invalid", "MCP schema map key is unsafe or too large");
    }
    output[key] = cloneSchema(child, depth + 1, state, pointerPath(path, key));
  }
  return Object.freeze(output);
}

function requireBoundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return schemaError("mcp_schema_limit", `${label} exceeds its text bound`);
  }
  return value;
}

function cloneSchema(
  value: unknown,
  depth: number,
  state: GuardState,
  path: string,
): SafeSchema {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return schemaError("mcp_schema_limit", "MCP schema depth exceeds 16");
  }
  state.nodes += 1;
  if (state.nodes > 4096) {
    return schemaError("mcp_schema_limit", "MCP schema contains too many nodes");
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return schemaError("mcp_schema_invalid", `${path} must be a schema object or boolean`);
  }
  if (state.seen.has(value)) {
    return schemaError("mcp_schema_invalid", "MCP schema must not be cyclic");
  }
  state.seen.add(value);
  const output: Record<string, SafeJsonValue> = Object.create(null) as Record<
    string,
    SafeJsonValue
  >;
  const refs: string[] = [];
  for (const [keyword, raw] of safeRecordEntries(value, path)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      return schemaError("mcp_schema_invalid", `unsupported MCP schema keyword: ${keyword}`);
    }
    switch (keyword) {
      case "$ref": {
        if (typeof raw !== "string" || (raw !== "#" && !raw.startsWith("#/"))) {
          return schemaError("mcp_schema_ref_unsafe", "MCP $ref must be a local document fragment");
        }
        refs.push(raw);
        output[keyword] = raw;
        break;
      }
      case "$schema":
        if (typeof raw !== "string" || !ACCEPTED_META_SCHEMAS.has(raw)) {
          return schemaError("mcp_schema_invalid", "unsupported MCP JSON Schema dialect");
        }
        output[keyword] = raw;
        break;
      case "$defs":
        output[keyword] = cloneSchemaMap(raw, depth, state, pointerPath(path, keyword), false);
        break;
      case "properties":
        output[keyword] = cloneSchemaMap(raw, depth, state, pointerPath(path, keyword), true);
        break;
      case "additionalProperties":
      case "items":
      case "not":
        output[keyword] = cloneSchema(raw, depth + 1, state, pointerPath(path, keyword));
        break;
      case "allOf":
      case "anyOf":
      case "oneOf": {
        const entries = safeArrayValues(raw, `${path}/${keyword}`);
        if (entries.length === 0 || entries.length > 64) {
          return schemaError("mcp_schema_limit", `${keyword} must contain 1..64 schemas`);
        }
        output[keyword] = Object.freeze(
          entries.map((entry, index) =>
            cloneSchema(entry, depth + 1, state, `${pointerPath(path, keyword)}/${index}`),
          ),
        );
        break;
      }
      case "enum": {
        const entries = safeArrayValues(raw, `${path}/enum`);
        state.enumItems += entries.length;
        if (entries.length === 0 || state.enumItems > MAX_MCP_SCHEMA_ENUM_ITEMS) {
          return schemaError("mcp_schema_limit", "MCP schema enum item limit exceeded");
        }
        output[keyword] = Object.freeze(
          entries.map((entry, index) =>
            cloneJsonValue(entry, depth + 1, state, `${path}/enum/${index}`),
          ),
        );
        break;
      }
      case "const":
        output[keyword] = cloneJsonValue(raw, depth + 1, state, `${path}/const`);
        break;
      case "required": {
        const entries = safeArrayValues(raw, `${path}/required`);
        if (
          entries.length > MAX_MCP_SCHEMA_PROPERTIES ||
          entries.some(
            (entry) =>
              typeof entry !== "string" || DANGEROUS_KEYS.has(entry),
          ) ||
          new Set(entries).size !== entries.length
        ) {
          return schemaError("mcp_schema_invalid", "MCP required list is invalid");
        }
        output[keyword] = Object.freeze(entries as string[]);
        break;
      }
      case "type": {
        const entries = Array.isArray(raw) ? safeArrayValues(raw, `${path}/type`) : [raw];
        if (
          entries.length === 0 ||
          entries.length > JSON_TYPES.size ||
          entries.some((entry) => typeof entry !== "string" || !JSON_TYPES.has(entry)) ||
          new Set(entries).size !== entries.length
        ) {
          return schemaError("mcp_schema_invalid", "MCP schema type is invalid");
        }
        output[keyword] = Array.isArray(raw)
          ? Object.freeze(entries as string[])
          : (raw as string);
        break;
      }
      case "description": {
        const bounded = requireBoundedText(raw, "description", MAX_MCP_DESCRIPTION_BYTES);
        output[keyword] = sanitizeTerminalText(bounded);
        break;
      }
      case "title": {
        const bounded = requireBoundedText(raw, "title", MAX_MCP_DESCRIPTION_BYTES);
        output[keyword] = sanitizeTerminalText(bounded);
        break;
      }
      case "pattern": {
        if (typeof raw !== "string" || [...raw].length > MAX_MCP_SCHEMA_PATTERN_CHARS) {
          return schemaError("mcp_schema_limit", "MCP schema regex exceeds 1024 characters");
        }
        try {
          new RegExp(raw, "u");
        } catch {
          return schemaError("mcp_schema_invalid", "MCP schema regex is invalid");
        }
        output[keyword] = raw;
        break;
      }
      case "maxItems":
      case "maxLength":
      case "maxProperties":
      case "minItems":
      case "minLength":
      case "minProperties":
        if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
          return schemaError("mcp_schema_invalid", `${keyword} must be a nonnegative integer`);
        }
        output[keyword] = raw as number;
        break;
      case "exclusiveMaximum":
      case "exclusiveMinimum":
      case "maximum":
      case "minimum":
      case "multipleOf":
        if (typeof raw !== "number" || !Number.isFinite(raw) || (keyword === "multipleOf" && raw <= 0)) {
          return schemaError("mcp_schema_invalid", `${keyword} must be a finite number`);
        }
        output[keyword] = raw;
        break;
      case "uniqueItems":
        if (typeof raw !== "boolean") {
          return schemaError("mcp_schema_invalid", "uniqueItems must be boolean");
        }
        output[keyword] = raw;
        break;
    }
  }
  if (refs.length > 0) state.refEdges.set(path, Object.freeze(refs));
  state.seen.delete(value);
  return Object.freeze(output);
}

function decodePointer(ref: string): readonly string[] {
  if (ref === "#") return [];
  let fragment: string;
  try {
    fragment = decodeURIComponent(ref.slice(1));
  } catch {
    return schemaError("mcp_schema_ref_unsafe", "MCP $ref contains invalid escaping");
  }
  const segments = fragment
    .slice(1)
    .split("/");
  if (segments.some((segment) => /~(?:[^01]|$)/u.test(segment))) {
    return schemaError("mcp_schema_ref_unsafe", "MCP $ref contains invalid JSON Pointer escaping");
  }
  return segments.map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~"),
  );
}

function canonicalReferenceLocation(ref: string): string {
  return decodePointer(ref).reduce(pointerPath, "#");
}

function resolvePointer(root: SafeSchema, ref: string): SafeSchema {
  let value: unknown = root;
  for (const segment of decodePointer(ref)) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return schemaError("mcp_schema_ref_unsafe", "MCP $ref target does not exist");
    }
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return schemaError("mcp_schema_ref_unsafe", "MCP $ref target is not a schema");
  }
  return value as SafeSchema;
}

function validateReferenceGraph(root: SafeSchema, state: GuardState): void {
  const visit = (location: string, stack: readonly string[], depth: number): void => {
    if (depth > MAX_MCP_SCHEMA_DEPTH) {
      schemaError("mcp_schema_ref_unsafe", "MCP $ref chain exceeds 16");
    }
    for (const rawTarget of state.refEdges.get(location) ?? []) {
      resolvePointer(root, rawTarget);
      const target = canonicalReferenceLocation(rawTarget);
      if (stack.includes(target) || target === location) {
        schemaError("mcp_schema_ref_unsafe", "cyclic MCP $ref is not allowed");
      }
      visit(target, [...stack, target], depth + 1);
    }
  };
  for (const location of state.refEdges.keys()) visit(location, [location], 0);
}

function strictObjectSchema(schema: Readonly<Record<string, unknown>>): boolean {
  if (schema.type !== "object" || schema.additionalProperties !== false) return false;
  if (Object.hasOwn(schema, "$ref") || Object.hasOwn(schema, "oneOf") || Object.hasOwn(schema, "not")) {
    return false;
  }
  const properties =
    typeof schema.properties === "object" &&
    schema.properties !== null &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Readonly<Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  return Object.keys(properties).every((name) => required.has(name));
}

export function guardMcpInputSchema(input: unknown): GuardedMcpSchema {
  const state: GuardState = {
    enumItems: 0,
    nodes: 0,
    properties: 0,
    refEdges: new Map(),
    seen: new Set(),
  };
  // PHASE12: remote refs, cycles, and unbounded schemas fail closed before a
  // compiler sees them, so validation cannot become hidden network/filesystem I/O.
  const guarded = cloneSchema(input, 0, state, "#");
  if (typeof guarded === "boolean" || guarded.type !== "object") {
    return schemaError("mcp_schema_invalid", "MCP tool input schema root must have type object");
  }
  const serialized = canonicalJson(guarded);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_SCHEMA_BYTES) {
    return schemaError("mcp_schema_limit", "MCP schema exceeds 64 KiB");
  }
  validateReferenceGraph(guarded, state);
  return Object.freeze({
    modelSchema: guarded,
    schemaSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    strictForModel: strictObjectSchema(guarded),
  });
}
