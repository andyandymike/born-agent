import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { compareRepositoryBenchmarkReports } from "../../src/repository-intelligence/benchmark/benchmark-comparator.js";
import { runRepositoryBenchmark } from "../../src/repository-intelligence/benchmark/benchmark-runner.js";
import { LegacyScanAdapter } from "../../src/repository-intelligence/benchmark/legacy-scan-adapter.js";
import { TypeScriptSemanticCandidateAdapter } from "../../src/repository-intelligence/benchmark/typescript-candidate-adapter.js";
import { loadAcceptedRepositoryEngineDecision } from "../../src/repository-intelligence/engine-decision-loader.js";
import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";
import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeModelTurnSignal,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime, InMemorySessionWriter } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function toolTurn(name: string, callId: string, input: Readonly<Record<string, unknown>>): readonly FakeModelTurnSignal[] {
  return [
    { call: { argumentsJson: JSON.stringify(input), callId, name }, type: "tool_call" },
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    { continuation: new FakeContinuation(callId), providerResponseId: `response-${callId}`, type: "turn_completed" },
  ];
}

function finalTurn(): readonly FakeModelTurnSignal[] {
  return [
    { delta: "Repository navigation contract completed.", type: "text_delta" },
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    { continuation: new FakeContinuation("final"), providerResponseId: "response-final", type: "turn_completed" },
  ];
}

describe("Phase 17E M8 zero-cost gate", () => {
  it("passes the full model-free retrieval gates without network or model-quality claims", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is forbidden"));
    const suitePath = resolve("evals/repository-intelligence/suite-v1.json");
    const [baseline, semantic] = await Promise.all([
      runRepositoryBenchmark({ adapter: new LegacyScanAdapter(), mode: "full", runId: "phase17e-m8-baseline", suitePath }),
      runRepositoryBenchmark({ adapter: new TypeScriptSemanticCandidateAdapter(), mode: "full", runId: "phase17e-m8-semantic", suitePath }),
    ]);
    const comparison = compareRepositoryBenchmarkReports(baseline, semantic);
    const decision = await loadAcceptedRepositoryEngineDecision(resolve("."));

    expect(comparison).toMatchObject({ compatible: true, exitCode: 0, regressions: [] });
    expect(comparison.contextReductionRatio).not.toBeNull();
    expect(comparison.contextReductionRatio!).toBeLessThanOrEqual(0.7);
    expect(semantic.metrics).toMatchObject({
      definitionTop1: 1,
      harnessInvalidCount: 0,
      referencePrecision: 1,
      referenceRecall: 1,
      ruleScopeAccuracy: 1,
      staleFalseNegativeCount: 0,
    });
    expect(decision.decision.status).toBe("accepted");
    expect(decision.identity.adapterVersion).toBe("bornagent-typescript-adapter-v2");
    expect(semantic).toMatchObject({
      modelFreeRetrieval: true,
      modelQualityEvidence: "not_measured",
      remoteExecution: "not_run_by_policy",
    });
    expect(fetch).not.toHaveBeenCalled();
  }, 60_000);

  it("runs all three production navigation tools through a fake Agent loop and durable events", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17e-m8-agent-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "alpha.ts"), "export class Alpha {}\n", "utf8");
    await writeFile(
      join(root, "src", "consumer.ts"),
      'import { Alpha } from "./alpha.js";\nexport const current = new Alpha();\n',
      "utf8",
    );
    const writer = new InMemorySessionWriter();
    let turn = 0;
    const backend = new FakeStreamingChatClient(async function* (request) {
      const names = request.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["find_references", "find_symbol", "repository_outline"]));
      if (turn === 0) {
        turn += 1;
        yield* toolTurn("repository_outline", "outline", { cursor: null, limit: 10, max_depth: 2, path: null });
        return;
      }
      if (turn === 1) {
        if (request.input.kind !== "tool_result") throw new Error("outline tool result was not continued");
        expect(request.input.output).toContain('"relativePath":"src/alpha.ts"');
        turn += 1;
        yield* toolTurn("find_symbol", "symbol", { cursor: null, kinds: null, limit: 5, path_prefix: null, query: "Alpha" });
        return;
      }
      if (turn === 2) {
        if (request.input.kind !== "tool_result") throw new Error("symbol tool result was not continued");
        const output = JSON.parse(request.input.output) as { readonly result: readonly { readonly symbolId: string }[] };
        turn += 1;
        yield* toolTurn("find_references", "references", {
          cursor: null,
          limit: 20,
          relations: null,
          symbol_id: output.result[0]!.symbolId,
        });
        return;
      }
      if (request.input.kind !== "tool_result") throw new Error("reference tool result was not continued");
      expect(request.input.output).toContain('"relativePath":"src/consumer.ts"');
      turn += 1;
      yield* finalTurn();
    }, { model: "qwen3:1.7b", provider: "ollama" });
    const memory = createMemoryIO();
    const runtime = createRuntime({
      createAgentToolRegistry: async (options) => createReadonlyToolRegistry(
        options.workspace,
        options.secrets,
        options.artifactRuntime,
        options.additionalTools,
        options.repositoryRules === undefined
          ? undefined
          : { assertFresh: options.repositoryRules.assertFresh, tracker: options.repositoryRules.tracker },
        options.repositoryNavigation,
      ),
      createModelBackend: () => backend,
      createRepositoryNavigationService: (workspace, secrets, events) =>
        DefaultRepositoryNavigationService.create(workspace, {
          ...(events === undefined ? {} : { events }),
          secrets,
        }),
      createSessionWriter: async () => writer,
      cwd: root,
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
      platform: process.platform,
    });

    const exitCode = await runCli([
      "agent",
      "Inspect Alpha with structured repository navigation.",
      "--task-profile",
      "read-only",
      "--provider",
      "ollama",
      "--model",
      "qwen3:1.7b",
      "--max-steps",
      "6",
    ], memory.io, runtime);

    expect(exitCode).toBe(0);
    expect(turn).toBe(4);
    expect(memory.readStdout()).toContain("Repository navigation contract completed.");
    expect(writer.runEventsV2.map((event) => event.type)).toContain("repository.index.selected");
    expect(writer.events.filter((event) => event.type === "tool.call.completed")).toHaveLength(3);
    expect(writer.events.at(-1)).toMatchObject({ data: { tool_calls: 3 }, type: "run.completed" });
  }, 30_000);
});
