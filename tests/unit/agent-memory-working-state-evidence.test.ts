import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  AgentMemoryWorkingStateEvidenceError,
  parseAgentMemoryWorkingStateManifest,
} from "../../src/memory/benchmark/agent-memory-working-state-evidence.js";

const manifestPath = resolve(
  "tests/evidence/agent-memory-working-state-v1.json",
);
const source = await readFile(manifestPath, "utf8");
const manifest = parseAgentMemoryWorkingStateManifest(source);

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMemoryWorkingStateEvidenceError);
    expect((error as AgentMemoryWorkingStateEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("AM1 working-state evidence manifest", () => {
  test("freezes all AM0 equivalence cases and the pre-declared performance gate", () => {
    expect(manifest).toMatchObject({
      defaultMode: "off",
      evaluatedMode: "working",
      evidenceId: "AM-E002-WORKING-STATE",
      workPackage: "AM1",
    });
    expect(manifest.equivalenceCaseIds).toHaveLength(36);
    expect(manifest.performance).toEqual([
      {
        caseId: "N03",
        historyClass: "short",
        maximumWorkingToBaselineRatio: 1.1,
        minimumImprovementRatio: null,
        repetitions: 9,
        warmupIterations: 2,
      },
      {
        caseId: "N12",
        historyClass: "long",
        maximumWorkingToBaselineRatio: null,
        minimumImprovementRatio: 0.3,
        repetitions: 9,
        warmupIterations: 2,
      },
    ]);
    expect(manifest.faults).toHaveLength(6);
  });

  test("rejects duplicate identities and stale oracle roots", () => {
    const duplicate = JSON.parse(source) as {
      equivalenceCaseIds: string[];
    };
    duplicate.equivalenceCaseIds[1] = duplicate.equivalenceCaseIds[0]!;
    expectCode(
      () => parseAgentMemoryWorkingStateManifest(JSON.stringify(duplicate)),
      "agent_memory_working_manifest_duplicate_id",
    );

    const stale = JSON.parse(source) as {
      faults: Array<{ expectedResult: string }>;
    };
    stale.faults[0]!.expectedResult = "corrupt";
    expectCode(
      () => parseAgentMemoryWorkingStateManifest(JSON.stringify(stale)),
      "agent_memory_working_manifest_root_mismatch",
    );
  });

  test("binds collection roots and rejects duplicate JSON keys", () => {
    expect(manifest.faultMatrixSha256).toBe(sha256Canonical(manifest.faults));
    expect(manifest.performanceOracleSha256).toBe(
      sha256Canonical(manifest.performance),
    );
    const finalBrace = source.lastIndexOf("}");
    const duplicate = `${source.slice(0, finalBrace)},\n  "workPackage": "AM1"\n}\n`;
    expectCode(
      () => parseAgentMemoryWorkingStateManifest(duplicate),
      "agent_memory_working_manifest_invalid",
    );
  });
});
