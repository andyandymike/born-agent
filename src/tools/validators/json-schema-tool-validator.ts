import { canonicalJson } from "../../completion/canonical-json.js";
import type { GuardedMcpSchema } from "../../mcp/mcp-schema-guard.js";
import { McpCoreError } from "../../mcp/mcp-errors.js";
import { sanitizeTerminalText } from "../../presentation/terminal-sanitizer.js";
import type {
  RuntimeToolValidator,
  RuntimeValidationIssue,
  ValidationResult,
} from "./runtime-tool-validator.js";
import { parseBoundedSafeArgumentsJson } from "./runtime-tool-validator.js";

export interface JsonSchemaCompilerPolicy {
  readonly allowRemoteRefs: false;
  readonly allErrors: true;
  readonly coerceTypes: false;
  readonly loadSchema: false;
  readonly maxErrors: 8;
  readonly removeAdditional: false;
  readonly useDefaults: false;
}

export interface CompiledJsonSchemaIssue {
  readonly instancePath?: string;
  readonly keyword?: string;
}

export interface CompiledJsonSchemaValidator {
  validate(value: unknown): {
    readonly issues?: readonly CompiledJsonSchemaIssue[];
    readonly valid: boolean;
  };
}

export interface JsonSchemaCompilerPort {
  compile(
    schema: Readonly<Record<string, unknown>>,
    policy: JsonSchemaCompilerPolicy,
  ): CompiledJsonSchemaValidator;
}

const COMPILER_POLICY: JsonSchemaCompilerPolicy = Object.freeze({
  allowRemoteRefs: false,
  allErrors: true,
  coerceTypes: false,
  loadSchema: false,
  maxErrors: 8,
  removeAdditional: false,
  useDefaults: false,
});

const STABLE_VALIDATION_KEYWORDS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
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
  "required",
  "type",
  "uniqueItems",
]);

function stableIssue(issue: CompiledJsonSchemaIssue): RuntimeValidationIssue {
  const keyword =
    typeof issue.keyword === "string" && STABLE_VALIDATION_KEYWORDS.has(issue.keyword)
      ? issue.keyword
      : "schema";
  const path =
    typeof issue.instancePath === "string" &&
    Buffer.byteLength(issue.instancePath, "utf8") <= 512 &&
    !issue.instancePath.includes("\0")
      ? sanitizeTerminalText(issue.instancePath) || "$"
      : "$";
  return { keyword, path };
}

export class JsonSchemaToolValidator implements RuntimeToolValidator<unknown> {
  private readonly compiled: CompiledJsonSchemaValidator;
  public readonly modelSchema: Readonly<Record<string, unknown>>;
  public readonly schemaSha256: string;
  public readonly strictForModel: boolean;

  public constructor(
    guarded: GuardedMcpSchema,
    compiler: JsonSchemaCompilerPort,
  ) {
    this.modelSchema = guarded.modelSchema;
    this.schemaSha256 = guarded.schemaSha256;
    this.strictForModel = guarded.strictForModel;
    try {
      this.compiled = compiler.compile(this.modelSchema, COMPILER_POLICY);
    } catch (error) {
      throw new McpCoreError(
        "mcp_schema_compile_failed",
        "MCP tool schema could not be compiled safely",
        { cause: error },
      );
    }
  }

  public parseJson(argumentsJson: string): ValidationResult<unknown> {
    const decoded = parseBoundedSafeArgumentsJson(argumentsJson);
    if (!decoded.success) return decoded;
    const before = canonicalJson(decoded.data);
    let result: ReturnType<CompiledJsonSchemaValidator["validate"]>;
    try {
      // PHASE12: provider strict-schema hints never replace this local runtime
      // validator; only validated arguments may cross the MCP process boundary.
      result = this.compiled.validate(decoded.data);
    } catch {
      return { issues: [{ keyword: "validator", path: "$" }], success: false };
    }
    if (canonicalJson(decoded.data) !== before) {
      return { issues: [{ keyword: "mutation", path: "$" }], success: false };
    }
    if (result.valid) return { data: decoded.data, success: true };
    return {
      issues: (result.issues ?? [])
        .slice(0, COMPILER_POLICY.maxErrors)
        .map(stableIssue),
      success: false,
    };
  }
}
