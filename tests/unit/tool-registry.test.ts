import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ToolDefinition } from "../../src/tools/tool-types.js";

function definition(
  name: string,
  execute: ToolDefinition<{ path: string | null }>["execute"] = vi.fn(
    async () => ({
      ok: true as const,
      truncated: false,
      value: { value: "ok" },
    }),
  ),
): ToolDefinition<{ path: string | null }> {
  return {
    capability: "read",
    description: `${name} description`,
    execute,
    inputSchema: z.object({ path: z.string().nullable() }).strict(),
    name,
  };
}

function erased<T>(value: ToolDefinition<T>): ToolDefinition<unknown> {
  return value as ToolDefinition<unknown>;
}

function optionalDefinition(): ToolDefinition<{ path?: string | undefined }> {
  return {
    capability: "read",
    description: "optional",
    execute: async () => ({ ok: true, truncated: false, value: {} }),
    inputSchema: z.object({ path: z.string().optional() }).strict(),
    name: "optional_tool",
  };
}

describe("ToolRegistry", () => {
  it("exports sorted strict JSON schemas from the Zod source of truth", () => {
    const registry = new ToolRegistry([
      erased(definition("search")),
      erased(definition("read_file")),
    ]);

    expect(registry.modelDefinitions.map((tool) => tool.name)).toEqual([
      "read_file",
      "search",
    ]);
    expect(registry.modelDefinitions[0]?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        path: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["path"],
      type: "object",
    });
  });

  it("rejects duplicate, invalid, and optional tool definitions", () => {
    expect(
      () =>
        new ToolRegistry([
          erased(definition("read_file")),
          erased(definition("read_file")),
        ]),
    ).toThrow("duplicate");
    expect(
      () => new ToolRegistry([erased(definition("Read-File"))]),
    ).toThrow("invalid");
    expect(
      () =>
        new ToolRegistry([
          erased(optionalDefinition()),
        ]),
    ).toThrow("optional");
  });

  it("does not execute unknown, malformed, oversized, or schema-invalid calls", async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      truncated: false,
      value: { value: "ok" },
    }));
    const registry = new ToolRegistry([
      erased(definition("read_file", execute)),
    ]);
    const cases = [
      { argumentsJson: "{}", name: "unknown" },
      { argumentsJson: "{", name: "read_file" },
      { argumentsJson: "{}", name: "read_file" },
      {
        argumentsJson: JSON.stringify({ path: "x".repeat(17 * 1024) }),
        name: "read_file",
      },
    ];
    for (const item of cases) {
      const result = await registry.execute(
        { ...item, callId: "call_1", step: 1 },
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      expect(() => JSON.parse(result.output)).not.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("redacts secrets and fails closed when an executor returns oversized output", async () => {
    const secret = "sk-secret-value-123456";
    const registry = new ToolRegistry(
      [
        erased(
          definition("read_file", async () => ({
            ok: true,
            truncated: false,
            value: { content: `${secret}${"x".repeat(70 * 1024)}` },
          })),
        ),
      ],
      [secret],
    );
    const result = await registry.execute(
      {
        argumentsJson: JSON.stringify({ path: null }),
        callId: "call_1",
        name: "read_file",
        step: 1,
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain(secret);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(64 * 1024);
  });

  it("returns cancellation before executing", async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry([
      erased(definition("read_file", execute)),
    ]);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute(
      {
        argumentsJson: JSON.stringify({ path: null }),
        callId: "call_1",
        name: "read_file",
        step: 1,
      },
      controller.signal,
    );
    expect(result).toMatchObject({
      error: { category: "cancelled" },
      ok: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
