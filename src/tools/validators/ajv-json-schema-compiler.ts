import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";

import type {
  CompiledJsonSchemaIssue,
  CompiledJsonSchemaValidator,
  JsonSchemaCompilerPolicy,
  JsonSchemaCompilerPort,
} from "./json-schema-tool-validator.js";

function issues(errors: ErrorObject[] | null | undefined): readonly CompiledJsonSchemaIssue[] {
  return (errors ?? []).slice(0, 8).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
  }));
}

class AjvCompiledValidator implements CompiledJsonSchemaValidator {
  public constructor(private readonly validateFunction: ValidateFunction) {}

  public validate(value: unknown): {
    readonly issues?: readonly CompiledJsonSchemaIssue[];
    readonly valid: boolean;
  } {
    const valid = this.validateFunction(value) === true;
    return valid
      ? { valid: true }
      : { issues: issues(this.validateFunction.errors), valid: false };
  }
}

export class AjvJsonSchemaCompiler implements JsonSchemaCompilerPort {
  public compile(
    schema: Readonly<Record<string, unknown>>,
    policy: JsonSchemaCompilerPolicy,
  ): CompiledJsonSchemaValidator {
    if (
      policy.allowRemoteRefs !== false ||
      policy.coerceTypes !== false ||
      policy.loadSchema !== false ||
      policy.removeAdditional !== false ||
      policy.useDefaults !== false
    ) {
      throw new TypeError("unsafe MCP JSON Schema compiler policy");
    }
    // PHASE12: the guard has already rejected remote refs and unsupported
    // keywords. Ajv is still pinned and configured without async loading,
    // coercion, defaults, format plugins, or data mutation.
    const Ajv = AjvModule as unknown as new (
      options: Readonly<Record<string, unknown>>,
    ) => { compile(schema: object): ValidateFunction };
    const ajv = new Ajv({
      allErrors: policy.allErrors,
      code: { optimize: 1, source: false },
      coerceTypes: false,
      messages: false,
      removeAdditional: false,
      strict: true,
      strictRequired: true,
      useDefaults: false,
      validateFormats: false,
    });
    return new AjvCompiledValidator(ajv.compile(schema));
  }
}

export const ajvJsonSchemaCompiler = Object.freeze(
  new AjvJsonSchemaCompiler(),
);
