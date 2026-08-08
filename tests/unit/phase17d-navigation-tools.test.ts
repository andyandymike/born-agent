import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";
import { RepositoryIntelligenceError } from "../../src/repository-intelligence/repository-intelligence-error.js";
import { createPlanToolRegistry } from "../../src/tools/create-plan-tool-registry.js";
import { createReadonlyToolDefinitions } from "../../src/tools/create-readonly-tool-registry.js";
import { createFindSymbolTool } from "../../src/tools/find-symbol-tool.js";
import { REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS } from "../../src/tools/repository-navigation-tool-contract.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { updatePlanInputSchema, type UpdatePlanInput } from "../../src/plans/update-plan-input-schema.js";
import type { ToolDefinition } from "../../src/tools/tool-types.js";

const temporary: string[] = [];
const SHA = "a".repeat(64);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function workspace(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase17d-tools-"));
  temporary.push(value);
  return value;
}

function emptySymbolResult() {
  return {
    confirmedAbsent: false,
    coverage: "partial" as const,
    engine: { id: "typescript-language-service", identitySha256: SHA },
    evidenceLevel: "semantic" as const,
    freshness: "current" as const,
    generationSha256: SHA,
    nextCursor: null,
    repositoryStatusSha256: SHA,
    result: [],
    ruleManifestSha256: SHA,
    schemaVersion: 1 as const,
    sourceStateSha256: SHA,
    truncated: false,
  };
}

function service(findSymbols = vi.fn(async () => emptySymbolResult())): RepositoryNavigationService {
  return {
    ensureCurrent: async () => { throw new Error("unused"); },
    findReferences: async () => { throw new Error("unused"); },
    findSymbols,
    outline: async () => { throw new Error("unused"); },
    status: async () => { throw new Error("unused"); },
  };
}

describe("Phase 17D read-only navigation tool boundary", () => {
  it("adds the exact three read tools to readonly/Plan and shares qualification schemas", async () => {
    const root = await workspace();
    const navigation = service();
    const readonly = await createReadonlyToolDefinitions(root, undefined, undefined, navigation);
    expect(readonly.filter((tool) => tool.name.includes("symbol") || tool.name.includes("references") || tool.name.includes("outline")).map((tool) => tool.name).sort()).toEqual([
      "find_references",
      "find_symbol",
      "repository_outline",
    ]);
    expect(readonly.every((tool) => tool.capability === "read")).toBe(true);

    const updatePlan: ToolDefinition<UpdatePlanInput> = {
      capability: "mutation" as const,
      description: "fixture",
      execute: async () => ({ ok: true as const, truncated: false, value: { updated: true } }),
      inputSchema: updatePlanInputSchema,
      name: "update_plan",
    };
    const plan = await createPlanToolRegistry(root, updatePlan, [], undefined, undefined, navigation);
    expect(plan.modelDefinitions.map((tool) => tool.name).sort()).toEqual([
      "find_references",
      "find_symbol",
      "list_files",
      "read_file",
      "repository_outline",
      "search",
      "update_plan",
    ]);
    const actualNavigationSchemas = plan.modelDefinitions.filter((tool) =>
      ["find_references", "find_symbol", "repository_outline"].includes(tool.name),
    );
    expect(actualNavigationSchemas).toEqual(REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS);
  });

  it("rejects an absolute path at the registry schema before calling the service", async () => {
    const findSymbols = vi.fn(async () => emptySymbolResult());
    const registry = new ToolRegistry([createFindSymbolTool(service(findSymbols))]);
    const execution = await registry.execute({
      argumentsJson: JSON.stringify({ cursor: null, kinds: null, limit: 1, path_prefix: "C:/outside", query: "Session" }),
      callId: "call-one",
      name: "find_symbol",
      step: 1,
    }, new AbortController().signal);
    expect(execution).toMatchObject({ ok: false, error: { code: "arguments_schema_mismatch" } });
    expect(findSymbols).not.toHaveBeenCalled();
  });

  it("returns exact bounded JSON and maps stale failures without raw cache/parser details", async () => {
    const successRegistry = new ToolRegistry([createFindSymbolTool(service())]);
    const success = await successRegistry.execute({
      argumentsJson: JSON.stringify({ cursor: null, kinds: null, limit: 1, path_prefix: null, query: "Session" }),
      callId: "call-success",
      name: "find_symbol",
      step: 1,
    }, new AbortController().signal);
    expect(success.ok).toBe(true);
    expect(JSON.parse(success.output)).toEqual({ ...emptySymbolResult(), ok: true });

    const stale = service(vi.fn(async () => {
      throw new RepositoryIntelligenceError("repository_index_stale", "absolute C:/secret parser failure", 8);
    }));
    const failureRegistry = new ToolRegistry([createFindSymbolTool(stale)]);
    const failure = await failureRegistry.execute({
      argumentsJson: JSON.stringify({ cursor: null, kinds: null, limit: 1, path_prefix: null, query: "Session" }),
      callId: "call-stale",
      name: "find_symbol",
      step: 1,
    }, new AbortController().signal);
    expect(failure).toMatchObject({ ok: false, error: { code: "repository_index_stale", retryable: true } });
    expect(failure.output).not.toContain("C:/secret");
    expect(failure.output).not.toContain("parser failure");
  });
});
