import { describe, expect, it } from "vitest";

import {
  createMcpServerStartActionIdentity,
  createMcpToolCallActionIdentity,
} from "../../src/mcp/mcp-action-identity.js";
import {
  buildMinimalMcpEnvironment,
  isReviewedOfflineMcpStart,
} from "../../src/mcp/mcp-environment.js";
import { McpCoreError } from "../../src/mcp/mcp-errors.js";
import type { McpIntegrityManifest } from "../../src/mcp/mcp-integrity-manifest.js";
import { guardMcpInputSchema } from "../../src/mcp/mcp-schema-guard.js";
import {
  createMcpCatalogState,
  freezeMcpCatalog,
  observeMcpCatalog,
  requireFrozenMcpTool,
} from "../../src/mcp/mcp-tool-catalog.js";
import { mapMcpToolName, mapMcpToolNames } from "../../src/mcp/mcp-tool-name-mapper.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

function manifest(): McpIntegrityManifest {
  return {
    binding: "explicit",
    entries: [{ bytes: 1, path: "fixture.mjs", sha256: C }],
    manifestSha256: D,
    totalBytes: 1,
  };
}

function startAction(
  overrides: Partial<Parameters<typeof createMcpServerStartActionIdentity>[0]> = {},
) {
  return createMcpServerStartActionIdentity({
    args: ["fixture.mjs"],
    canonicalCwd: ".",
    configSha256: A,
    env: [{ source: "BORN_MCP_TOKEN", target: "TOKEN" }],
    environmentPolicyVersion: "mcp-minimal-env-v1",
    executable: {
      bytesSha256: B,
      canonicalIdentitySha256: C,
      logicalName: "node",
      versionIdentity: "node-test",
    },
    integrityManifest: manifest(),
    serverId: "fixture",
    startupTimeoutMs: 10_000,
    ...overrides,
  });
}

describe("Phase 12 MCP action identities and environment", () => {
  it("binds config, executable, argv, cwd, env mapping, manifest, policy, and timeout", () => {
    const original = startAction();
    expect(original.actionSha256).toMatch(/^[a-f0-9]{64}$/u);
    const variants = [
      startAction({ args: ["fixture.mjs", "extra"] }),
      startAction({ canonicalCwd: "fixture" }),
      startAction({ configSha256: B }),
      startAction({ env: [{ source: "BORN_MCP_OTHER", target: "TOKEN" }] }),
      startAction({ environmentPolicyVersion: "mcp-minimal-env-v2" }),
      startAction({ integrityManifest: { ...manifest(), manifestSha256: A } }),
      startAction({ startupTimeoutMs: 10_001 }),
    ];
    expect(new Set(variants.map((variant) => variant.actionSha256))).toHaveLength(
      variants.length,
    );
    expect(variants.every((variant) => variant.actionSha256 !== original.actionSha256)).toBe(true);
  });

  it("canonicalizes exact tool arguments and binds every call authority field", () => {
    const base = {
      argumentsValue: { b: 2, a: 1 },
      callTimeoutMs: 1000,
      catalogSha256: A,
      configSha256: B,
      modelToolName: "mcp__fixture__read",
      processIdentitySha256: C,
      rawToolName: "read",
      schemaSha256: D,
      serverId: "fixture",
    };
    const first = createMcpToolCallActionIdentity(base);
    const reordered = createMcpToolCallActionIdentity({
      ...base,
      argumentsValue: { a: 1, b: 2 },
    });
    expect(reordered.actionSha256).toBe(first.actionSha256);
    expect(reordered.argumentsJson).toBe('{"a":1,"b":2}');

    for (const change of [
      { argumentsValue: { a: 1, b: 3 } },
      { callTimeoutMs: 1001 },
      { catalogSha256: B },
      { configSha256: A },
      { modelToolName: "mcp__fixture__other" },
      { processIdentitySha256: D },
      { rawToolName: "other" },
      { schemaSha256: C },
      { serverId: "other" },
    ]) {
      expect(
        createMcpToolCallActionIdentity({ ...base, ...change }).actionSha256,
      ).not.toBe(first.actionSha256);
    }
  });

  it("builds a minimal child environment without provider, SSH, Git, or source names", () => {
    const environment = buildMinimalMcpEnvironment({
      mappings: [{ source: "BORN_MCP_TOKEN", target: "FIXTURE_TOKEN" }],
      sourceEnvironment: {
        BORN_MCP_TOKEN: "fixture-value",
        GIT_ASKPASS: "should-not-pass",
        OPENAI_API_KEY: "should-not-pass",
        PATH: "runtime-path",
        SSH_AUTH_SOCK: "should-not-pass",
      },
    });
    expect(environment).toEqual({
      FIXTURE_TOKEN: "fixture-value",
      PATH: "runtime-path",
    });
    expect(environment).not.toHaveProperty("BORN_MCP_TOKEN");
    expect(() =>
      buildMinimalMcpEnvironment({
        mappings: [{ source: "BORN_MCP_MISSING", target: "TOKEN" }],
        sourceEnvironment: { PATH: "runtime-path" },
      }),
    ).toThrowError(McpCoreError);
  });

  it("requires an exact reviewed offline start action", () => {
    const action = startAction();
    expect(
      isReviewedOfflineMcpStart(action, [
        { actionSha256: action.actionSha256, serverId: action.serverId },
      ]),
    ).toBe(true);
    expect(
      isReviewedOfflineMcpStart(action, [
        { actionSha256: A, serverId: action.serverId },
      ]),
    ).toBe(false);
  });
});

describe("Phase 12 MCP stable names and frozen catalog", () => {
  it("maps safe, Unicode, transformed, and long raw names deterministically", () => {
    expect(mapMcpToolName("fixture", "read_file").modelName).toBe(
      "mcp__fixture__read_file",
    );
    for (const rawName of ["Read File", "读取文件", "x".repeat(200)]) {
      const first = mapMcpToolName("fixture", rawName);
      const second = mapMcpToolName("fixture", rawName);
      expect(second).toEqual(first);
      expect(first.modelName).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      expect(first.modelName).toMatch(/_[a-f0-9]{8}$/u);
    }
  });

  it("fails discovery on raw duplicates or model-name collision", () => {
    expect(() => mapMcpToolNames("fixture", ["same", "same"])).toThrowError(
      McpCoreError,
    );
    expect(() =>
      mapMcpToolNames("fixture", ["read_file"], ["mcp__fixture__read_file"]),
    ).toThrowError(McpCoreError);
  });

  it("freezes a sorted sanitized catalog and blocks calls after list_changed", () => {
    const schema = guardMcpInputSchema({ type: "object" });
    const create = (description: string, reverse = false) =>
      freezeMcpCatalog({
        serverId: "fixture",
        serverIdentitySha256: A,
        tools: (reverse
          ? [
              { description: "second", rawName: "zeta", schema },
              { description, rawName: "alpha", schema },
            ]
          : [
              { description, rawName: "alpha", schema },
              { description: "second", rawName: "zeta", schema },
            ]),
      });
    const first = create("\u001b]0;owned\u0007safe");
    const reordered = create("\u001b]0;owned\u0007safe", true);
    expect(reordered.catalogSha256).toBe(first.catalogSha256);
    expect(first.tools.map((tool) => tool.rawName)).toEqual(["alpha", "zeta"]);
    expect(first.tools[0]?.description).toContain("untrusted description] safe");
    expect(first.tools[0]?.description).not.toContain("owned");

    const active = createMcpCatalogState(first);
    expect(requireFrozenMcpTool(active, "mcp__fixture__alpha").rawName).toBe(
      "alpha",
    );
    const changed = observeMcpCatalog(active, create("changed"));
    expect(changed.callsBlocked).toBe(true);
    expect(() => requireFrozenMcpTool(changed, "mcp__fixture__alpha")).toThrowError(
      McpCoreError,
    );
  });
});
