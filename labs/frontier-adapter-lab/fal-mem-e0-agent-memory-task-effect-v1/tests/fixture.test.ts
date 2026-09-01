import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  loadMemE0Fixture,
  MEM_E0_CASE_IDS,
  parseMemE0Case,
  parseMemE0Protocol,
  scanMemE0AgentVisibleLeaks,
} from "../src/fixture.js";

describe("FAL MEM-E0 fixture contract", () => {
  it("loads one self-hashed protocol with three dependent cases and one harm control", async () => {
    const fixture = await loadMemE0Fixture(resolve("."));
    expect(fixture.protocol.caseCounts).toEqual({
      harmControl: 1,
      memoryDependent: 3,
      total: 4,
    });
    expect(fixture.protocol.effectClaimAllowed).toBe(false);
    expect(fixture.protocol.providerCallsExpected).toBe(0);
    expect(fixture.cases.map((entry) => entry.definition.caseId)).toEqual(
      MEM_E0_CASE_IDS,
    );
    expect(fixture.cases.filter(
      (entry) => entry.definition.caseClass === "memory_dependent",
    )).toHaveLength(3);
    expect(fixture.cases.filter(
      (entry) => entry.definition.caseClass === "harm_control",
    )).toHaveLength(1);
  });

  it("strict-decodes protocol and cases and rejects unknown fields or self-hash tampering", async () => {
    const fixture = await loadMemE0Fixture(resolve("."));
    const protocolRaw = await readFile(
      `${fixture.directory}/protocol.json`,
      "utf8",
    );
    const protocol = parseStrictJson(protocolRaw) as Record<string, unknown>;
    expect(() => parseMemE0Protocol({ ...protocol, unexpected: true })).toThrow();
    expect(() => parseMemE0Protocol({
      ...protocol,
      effectClaimAllowed: true,
    })).toThrow();

    const definition = fixture.cases[0]!.definition;
    expect(() => parseMemE0Case({ ...definition, unexpected: true })).toThrow();
    expect(() => parseMemE0Case({
      ...definition,
      task: { ...definition.task, text: `${definition.task.text} tampered` },
    })).toThrow(/self-hash|task hash/u);
  });

  it("keeps hidden values and hidden verifier bytes out of every Agent-visible surface", async () => {
    const fixture = await loadMemE0Fixture(resolve("."));
    for (const loadedCase of fixture.cases) {
      const surfaces = [
        { label: "task", text: loadedCase.definition.task.text },
        ...loadedCase.publicFiles.map((file) => ({
          label: file.path,
          text: file.content,
        })),
      ];
      expect(scanMemE0AgentVisibleLeaks({
        definition: loadedCase.definition,
        surfaces,
      })).toEqual([]);
      expect(loadedCase.publicFiles.some(
        (file) => file.path.includes("hidden") || file.content.includes("hidden pass"),
      )).toBe(false);
      const sentinel = loadedCase.definition.memory.forbiddenPublicSubstrings[0]!;
      expect(scanMemE0AgentVisibleLeaks({
        definition: loadedCase.definition,
        surfaces: [{ label: "tampered-public", text: `leak=${sentinel}` }],
      })).toEqual(["tampered-public:exact_forbidden_value"]);
    }
  });
});
