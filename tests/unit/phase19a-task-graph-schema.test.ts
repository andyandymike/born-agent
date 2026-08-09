import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/completion/canonical-json.js";
import { TaskGraphFileLoader } from "../../src/task-graph/task-graph-file-loader.js";
import { canonicalTaskGraphIdentity } from "../../src/task-graph/task-graph-identity.js";
import { normalizeTaskGraphRevision } from "../../src/task-graph/task-graph-schema.js";

const SESSION = "10000000-0000-4000-8000-000000000019";
const GOAL = "20000000-0000-4000-8000-000000000019";
const PLAN = "30000000-0000-4000-8000-000000000019";
const GRAPH = "40000000-0000-4000-8000-000000000019";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 1024,
    maxAttempts: 3,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 4,
    maxReportedTokens: 4096,
    ...overrides,
  };
}

function graph(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    binding: {
      goalId: GOAL,
      goalRevision: 1,
      planId: PLAN,
      planRevision: 1,
      planSha256: "a".repeat(64),
      sessionId: SESSION,
    },
    graphBudget: budget(),
    graphId: GRAPH,
    nodes: [
      {
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget({ maxAttempts: 1 }),
        dependsOn: [],
        kind: "agent",
        nodeId: "inspect",
        objective: "Inspect the current implementation and emit structured evidence.",
        planItemIds: ["implementation"],
        requiredCapabilities: [],
        retry: { automaticOn: ["pre_effect_infrastructure_failure"], maxAttempts: 1 },
        sequence: 1,
        title: "Inspect implementation",
        workspace: { declaredPathPrefixes: ["src", "."], mode: "origin_read_only" },
      },
    ],
    schemaVersion: 1,
    title: "Durable implementation Graph",
    ...overrides,
  };
}

describe("Phase 19A strict TaskGraph schema", () => {
  it("canonicalizes only order-insensitive fields and hashes deterministically", () => {
    const left = canonicalTaskGraphIdentity(graph());
    const right = canonicalTaskGraphIdentity(graph({
      nodes: [{
        ...(graph().nodes[0] as Record<string, unknown>),
        planItemIds: ["implementation"],
        workspace: { declaredPathPrefixes: [".", "src"], mode: "origin_read_only" },
      }],
    }));
    expect(left.graphSha256).toBe(right.graphSha256);
    expect(left.content.nodes[0]?.workspace.declaredPathPrefixes).toEqual([".", "src"]);
    expect(left.byteLength).toBe(Buffer.byteLength(canonicalJson(left.content), "utf8"));
  });

  it("rejects cycles, orphan dependencies, invalid mode/workspace combinations, and short capabilities", () => {
    const node = graph().nodes[0] as Record<string, unknown>;
    expect(() => normalizeTaskGraphRevision(graph({ nodes: [{ ...node, dependsOn: ["inspect"] }] }))).toThrow(/itself|cycle/u);
    expect(() => normalizeTaskGraphRevision(graph({ nodes: [{ ...node, dependsOn: ["missing"] }] }))).toThrow(/unknown node/u);
    expect(() => normalizeTaskGraphRevision(graph({
      nodes: [{ ...node, agent: { mode: "build", taskProfile: "coding" } }],
    }))).toThrow(/origin_read_only/u);
    expect(() => normalizeTaskGraphRevision(graph({
      nodes: [{ ...node, requiredCapabilities: ["review-change"] }],
    }))).toThrow(/qualified/u);
  });

  it("rejects duplicate JSON keys before schema parsing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase19a-json-"));
    temporary.push(workspace);
    const source = canonicalJson(graph()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    await writeFile(join(workspace, "graph.json"), source, "utf8");
    await expect(new TaskGraphFileLoader().load(workspace, "graph.json")).rejects.toMatchObject({
      code: "task_graph_json_invalid",
    });
  });
});
