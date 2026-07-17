import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../completion/canonical-json.js";
import type {
  RuntimeToolValidator,
  ValidationResult,
} from "./runtime-tool-validator.js";
import { parseBoundedSafeArgumentsJson } from "./runtime-tool-validator.js";

export class ZodToolValidator<T> implements RuntimeToolValidator<T> {
  public readonly modelSchema: Readonly<Record<string, unknown>>;
  public readonly schemaSha256: string;
  public readonly strictForModel = true;

  public constructor(private readonly schema: z.ZodType<T>) {
    const modelSchema = z.toJSONSchema(schema, { target: "draft-7" });
    this.modelSchema = deepFreeze(modelSchema);
    this.schemaSha256 = createHash("sha256")
      .update(canonicalJson(modelSchema), "utf8")
      .digest("hex");
  }

  public parseJson(argumentsJson: string): ValidationResult<T> {
    const decoded = parseBoundedSafeArgumentsJson(argumentsJson);
    if (!decoded.success) return decoded;
    const parsed = this.schema.safeParse(decoded.data);
    if (parsed.success) return { data: parsed.data, success: true };
    return {
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        keyword: issue.code,
        path:
          issue.path.length === 0
            ? "$"
            : `$.${issue.path.map((entry) => String(entry)).join(".")}`,
      })),
      success: false,
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
