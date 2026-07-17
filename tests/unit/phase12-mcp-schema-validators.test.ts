import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { McpCoreError } from "../../src/mcp/mcp-errors.js";
import {
  guardMcpInputSchema,
} from "../../src/mcp/mcp-schema-guard.js";
import {
  JsonSchemaToolValidator,
} from "../../src/tools/validators/json-schema-tool-validator.js";
import type {
  JsonSchemaCompilerPort,
} from "../../src/tools/validators/json-schema-tool-validator.js";
import { ZodToolValidator } from "../../src/tools/validators/zod-tool-validator.js";

function expectMcpCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected MCP error");
  } catch (error) {
    expect(error).toBeInstanceOf(McpCoreError);
    expect((error as McpCoreError).code).toBe(code);
  }
}

describe("Phase 12 MCP JSON Schema guard", () => {
  it("accepts optional fields, nested unions, additionalProperties, and local refs deterministically", () => {
    const schema = {
      $defs: {
        count: { minimum: 0, type: "integer" },
      },
      additionalProperties: false,
      properties: {
        mode: { anyOf: [{ const: "fast" }, { const: "safe" }] },
        nested: {
          additionalProperties: true,
          properties: { count: { $ref: "#/$defs/count" } },
          type: "object",
        },
        required_name: { type: "string" },
      },
      required: ["required_name"],
      type: "object",
    };

    const first = guardMcpInputSchema(schema);
    const second = guardMcpInputSchema({
      type: "object",
      required: ["required_name"],
      properties: schema.properties,
      additionalProperties: false,
      $defs: schema.$defs,
    });

    expect(first.schemaSha256).toBe(second.schemaSha256);
    expect(first.strictForModel).toBe(false);
    expect(first.modelSchema).toMatchObject({ type: "object" });
  });

  it("marks only fully required closed object roots as provider-strict hints", () => {
    expect(
      guardMcpInputSchema({
        additionalProperties: false,
        properties: { name: { type: "string" } },
        required: ["name"],
        type: "object",
      }).strictForModel,
    ).toBe(true);
    expect(
      guardMcpInputSchema({
        properties: { name: { type: "string" } },
        type: "object",
      }).strictForModel,
    ).toBe(false);
  });

  it("rejects remote, relative, missing, cyclic, and dynamic refs", () => {
    for (const ref of [
      "https://example.invalid/schema.json",
      "file:///tmp/schema.json",
      "other.json#/value",
      "#/missing",
    ]) {
      expectMcpCode(
        () => guardMcpInputSchema({ properties: { x: { $ref: ref } }, type: "object" }),
        "mcp_schema_ref_unsafe",
      );
    }
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          $defs: {
            a: { $ref: "#/$defs/b" },
            b: { $ref: "#/$defs/a" },
          },
          type: "object",
        }),
      "mcp_schema_ref_unsafe",
    );
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          $defs: {
            "a b": { $ref: "#/$defs/a%20b" },
          },
          type: "object",
        }),
      "mcp_schema_ref_unsafe",
    );
    expectMcpCode(
      () => guardMcpInputSchema({ $dynamicRef: "#node", type: "object" }),
      "mcp_schema_invalid",
    );
  });

  it("enforces depth, property, enum, regex, and serialized byte limits", () => {
    let deep: unknown = { type: "string" };
    for (let index = 0; index < 18; index += 1) {
      deep = { properties: { child: deep }, type: "object" };
    }
    expectMcpCode(() => guardMcpInputSchema(deep), "mcp_schema_limit");

    expectMcpCode(
      () =>
        guardMcpInputSchema({
          properties: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`p${index}`, { type: "string" }]),
          ),
          type: "object",
        }),
      "mcp_schema_limit",
    );
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          properties: { value: { enum: Array.from({ length: 513 }, (_, index) => index) } },
          type: "object",
        }),
      "mcp_schema_limit",
    );
    for (const pattern of ["[", "x".repeat(1025)]) {
      expectMcpCode(
        () =>
          guardMcpInputSchema({
            properties: { value: { pattern, type: "string" } },
            type: "object",
          }),
        pattern === "[" ? "mcp_schema_invalid" : "mcp_schema_limit",
      );
    }
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          properties: {
            value: {
              enum: Array.from({ length: 512 }, (_, index) => `${index}:${"x".repeat(180)}`),
            },
          },
          type: "object",
        }),
      "mcp_schema_limit",
    );
  });

  it("rejects prototype/accessor keys and unsupported keywords", () => {
    const prototypeSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as unknown;
    expectMcpCode(() => guardMcpInputSchema(prototypeSchema), "mcp_schema_invalid");
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          properties: { "\u001b]0;owned\u0007": { type: "string" } },
          type: "object",
        }),
      "mcp_schema_invalid",
    );

    const accessor: Record<string, unknown> = { type: "object" };
    Object.defineProperty(accessor, "properties", {
      enumerable: true,
      get: () => ({}),
    });
    expectMcpCode(() => guardMcpInputSchema(accessor), "mcp_schema_invalid");
    expectMcpCode(
      () =>
        guardMcpInputSchema({
          properties: { value: { format: "uri", type: "string" } },
          type: "object",
        }),
      "mcp_schema_invalid",
    );
  });

  it("sanitizes external schema descriptions before hashing/model exposure", () => {
    const guarded = guardMcpInputSchema({
      description: "\u001b]52;c;ZmFrZQ==\u0007safe",
      type: "object",
    });
    expect(guarded.modelSchema.description).toBe("safe");
  });
});

describe("Phase 12 runtime validator abstraction", () => {
  it("keeps Zod built-ins strict and derives the model schema from the same source", () => {
    const validator = new ZodToolValidator(
      z.object({ name: z.string(), optional: z.number().optional() }).strict(),
    );

    expect(validator.strictForModel).toBe(true);
    expect(validator.schemaSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(validator.parseJson('{"name":"ok"}')).toEqual({
      data: { name: "ok" },
      success: true,
    });
    expect(validator.parseJson('{"name":"ok","extra":true}')).toMatchObject({
      success: false,
    });
    expect(validator.parseJson('{"__proto__":{}}')).toEqual({
      issues: [{ keyword: "unsafeJson", path: "$" }],
      success: false,
    });
  });

  it("passes a locked no-network/no-coercion policy to the injected compiler", () => {
    const compile = vi.fn<JsonSchemaCompilerPort["compile"]>(() => ({
      validate: (value) => {
        const record = value as Readonly<Record<string, unknown>>;
        return record.name === "ok"
          ? { valid: true }
          : {
              issues: [
                { instancePath: "/name", keyword: "type" },
                { instancePath: "/name", keyword: "raw-secret-must-not-appear" },
              ],
              valid: false,
            };
      },
    }));
    const guarded = guardMcpInputSchema({
      properties: { name: { type: "string" } },
      type: "object",
    });
    const validator = new JsonSchemaToolValidator(guarded, { compile });

    expect(compile).toHaveBeenCalledWith(
      guarded.modelSchema,
      expect.objectContaining({
        allowRemoteRefs: false,
        coerceTypes: false,
        loadSchema: false,
        removeAdditional: false,
        useDefaults: false,
      }),
    );
    expect(validator.strictForModel).toBe(false);
    expect(validator.parseJson('{"name":"ok"}')).toMatchObject({ success: true });
    expect(validator.parseJson('{"name":1}')).toEqual({
      issues: [
        { keyword: "type", path: "/name" },
        { keyword: "schema", path: "/name" },
      ],
      success: false,
    });
  });

  it("fails closed for compiler exceptions, validator exceptions, and input mutation", () => {
    const guarded = guardMcpInputSchema({ type: "object" });
    expectMcpCode(
      () =>
        new JsonSchemaToolValidator(guarded, {
          compile: () => {
            throw new Error("compiler internals");
          },
        }),
      "mcp_schema_compile_failed",
    );

    const throwing = new JsonSchemaToolValidator(guarded, {
      compile: () => ({
        validate: () => {
          throw new Error("validator internals");
        },
      }),
    });
    expect(throwing.parseJson("{}")).toEqual({
      issues: [{ keyword: "validator", path: "$" }],
      success: false,
    });

    const mutating = new JsonSchemaToolValidator(guarded, {
      compile: () => ({
        validate: (value) => {
          (value as Record<string, unknown>).changed = true;
          return { valid: true };
        },
      }),
    });
    expect(mutating.parseJson("{}")).toEqual({
      issues: [{ keyword: "mutation", path: "$" }],
      success: false,
    });
  });
});
