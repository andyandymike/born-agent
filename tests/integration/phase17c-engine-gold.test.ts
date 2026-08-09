import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runRepositoryBenchmark } from "../../src/repository-intelligence/benchmark/benchmark-runner.js";
import { TypeScriptSemanticCandidateAdapter, TypeScriptSyntacticCandidateAdapter } from "../../src/repository-intelligence/benchmark/typescript-candidate-adapter.js";

describe("Phase 17C model-free engine gold", () => {
  it("selects the semantic candidate only after the same full suite gate", async () => {
    const suitePath = resolve("evals/repository-intelligence/suite-v1.json");
    const [syntactic, semantic] = await Promise.all([
      runRepositoryBenchmark({ adapter: new TypeScriptSyntacticCandidateAdapter(), mode: "full", runId: "phase17c-syntactic-test", suitePath }),
      runRepositoryBenchmark({ adapter: new TypeScriptSemanticCandidateAdapter(), mode: "full", runId: "phase17c-semantic-test", suitePath }),
    ]);
    expect(syntactic.metrics.referenceRecall).toBe(0);
    expect(semantic.metrics).toMatchObject({
      definitionTop1: 1,
      harnessInvalidCount: 0,
      referencePrecision: 1,
      referenceRecall: 1,
      ruleScopeAccuracy: 1,
      staleFalseNegativeCount: 0,
    });
    expect(semantic.modelQualityEvidence).toBe("not_measured");
    expect(semantic.remoteExecution).toBe("not_run_by_policy");
  }, 20_000);
});
