import { describe, expect, it } from "vitest";

import { repositoryBenchmarkSuiteSchema, repositoryHiddenExpectedSchema, repositoryVisibleQuerySchema } from "../../src/repository-intelligence/benchmark/benchmark-schema.js";
import { createRepositoryEngineDecision, repositoryEngineDecisionSchema } from "../../src/repository-intelligence/benchmark/engine-decision-schema.js";

const SHA = "a".repeat(64);

function benchmarkCase(id: string) {
  return {
    category: "definition" as const,
    hiddenExpectedRef: `tasks/${id}/grader/expected.json`,
    id,
    limits: { maxObservationBytes: 65536, timeoutMs: 5000 },
    schemaVersion: 1 as const,
    version: 1,
    visibleQueryRef: `tasks/${id}/query.json`,
    workspaceRef: `tasks/${id}/workspace`,
    workspaceSha256: SHA,
  };
}

describe("Phase 17A benchmark schemas", () => {
  it("requires twenty unique cases and exactly eight valid smoke IDs", () => {
    const cases = Array.from({ length: 20 }, (_, index) => benchmarkCase(`case-${index + 1}`));
    expect(repositoryBenchmarkSuiteSchema.parse({ cases, id: "suite-v1", schemaVersion: 1, smokeCaseIds: cases.slice(0, 8).map((entry) => entry.id), suiteVersion: 1 }).cases).toHaveLength(20);
    expect(() => repositoryBenchmarkSuiteSchema.parse({ cases: [...cases.slice(0, 19), cases[0]], id: "suite-v1", schemaVersion: 1, smokeCaseIds: cases.slice(0, 8).map((entry) => entry.id), suiteVersion: 1 })).toThrow();
  });

  it("keeps visible programs and hidden expected data in separate strict schemas", () => {
    expect(repositoryVisibleQuerySchema.parse({ fixtureActions: [], program: [{ arguments: { glob: null, path: null }, tool: "list_files" }], requestKind: "definition", schemaVersion: 1 })).not.toHaveProperty("expected");
    expect(repositoryHiddenExpectedSchema.parse({ caseId: "case-1", confirmedAbsent: false, expected: [{ column: 1, line: 2, path: "src/a.ts" }], schemaVersion: 1 })).not.toHaveProperty("program");
    expect(() => repositoryVisibleQuerySchema.parse({ fixtureActions: [], program: [], requestKind: "definition", schemaVersion: 1, expected: [] })).toThrow();
  });

  it("binds engine decisions to a canonical self hash and every gate", () => {
    const rejected = createRepositoryEngineDecision({
      baselineReportSha256: SHA,
      candidateReportSha256: SHA,
      contextReductionGatePassed: true,
      correctnessGatePassed: true,
      engineIdentity: { adapter: "candidate-v1", engine: "candidate", packageName: "candidate", packageVersion: "1.0.0", protocolVersion: 1 },
      freshnessGatePassed: false,
      securityGatePassed: true,
      suiteSha256: SHA,
    });
    expect(rejected.status).toBe("rejected");
    expect(repositoryEngineDecisionSchema.parse(rejected)).toEqual(rejected);
    expect(() => repositoryEngineDecisionSchema.parse({ ...rejected, status: "accepted" })).toThrow();
  });
});
