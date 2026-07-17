export interface RuntimeValidationIssue {
  readonly keyword: string;
  readonly path: string;
}

export type ValidationResult<T> =
  | {
      readonly issues: readonly RuntimeValidationIssue[];
      readonly success: false;
    }
  | { readonly data: T; readonly success: true };

export interface RuntimeToolValidator<T = unknown> {
  readonly modelSchema: Readonly<Record<string, unknown>>;
  readonly schemaSha256: string;
  readonly strictForModel: boolean;
  parseJson(argumentsJson: string): ValidationResult<T>;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeParsedJson(
  value: unknown,
  depth: number,
  nodes: { count: number },
): boolean {
  nodes.count += 1;
  if (depth > 32 || nodes.count > 4096) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.every((entry) => assertSafeParsedJson(entry, depth + 1, nodes));
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every(
    (key) =>
      !DANGEROUS_KEYS.has(key) &&
      assertSafeParsedJson(
        (value as Readonly<Record<string, unknown>>)[key],
        depth + 1,
        nodes,
      ),
  );
}

export function parseBoundedSafeArgumentsJson(
  argumentsJson: string,
): ValidationResult<unknown> {
  if (Buffer.byteLength(argumentsJson, "utf8") > 64 * 1024) {
    return {
      issues: [{ keyword: "maxBytes", path: "$" }],
      success: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return { issues: [{ keyword: "parse", path: "$" }], success: false };
  }
  if (!assertSafeParsedJson(parsed, 0, { count: 0 })) {
    return { issues: [{ keyword: "unsafeJson", path: "$" }], success: false };
  }
  return { data: parsed, success: true };
}
