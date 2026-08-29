import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { materializeEmR1Corpus } from "../src/corpus-materializer.js";
import { loadEmR1Split, validateEmR1CrossSplitCorpus } from "../src/experiment-schema.js";

describe("FAL-EM-R1 frozen corpus revision 2", () => {
  it("binds two group-disjoint 48-case splits to exact 128-row pools", async () => {
    const [calibration, evaluation, overlap] = await Promise.all([
      loadEmR1Split(process.cwd(), "calibration"),
      loadEmR1Split(process.cwd(), "evaluation"),
      validateEmR1CrossSplitCorpus(process.cwd()),
    ]);

    expect(calibration.manifest.corpusRevision).toBe(2);
    expect(calibration.pool.rows).toHaveLength(128);
    expect(evaluation.pool.rows).toHaveLength(128);
    expect(calibration.cases.cases).toHaveLength(48);
    expect(evaluation.cases.cases).toHaveLength(48);
    expect(Object.values(overlap)).toEqual([0, 0, 0, 0]);
    for (const pack of [calibration.cases, evaluation.cases]) {
      expect(pack.cases.filter((entry) =>
        entry.golden.answerability === "answerable")).toHaveLength(24);
      expect(pack.cases.filter((entry) =>
        entry.golden.answerability === "must_abstain")).toHaveLength(24);
      expect(pack.cases.filter((entry) =>
        entry.category === "filtered_target_abstention")).toHaveLength(8);
    }
  });

  it("proves the calibration vector-negative preflight on the live FTS path", async () => {
    const calibration = await loadEmR1Split(process.cwd(), "calibration");
    const root = await mkdtemp(join(tmpdir(), "bornagent-em-r1-preflight-"));
    const materialized = await materializeEmR1Corpus(root, calibration.pool);
    try {
      const negatives = calibration.cases.cases.filter((entry) =>
        entry.golden.answerability === "must_abstain");
      const results = [];
      for (const definition of negatives) {
        if (definition.query.mode !== "text") throw new Error("negative query is not text");
        results.push({
          category: definition.category,
          result: await materialized.service.search({ limit: 5, query: definition.query.value }),
        });
      }
      expect(results).toHaveLength(24);
      expect(results.every((entry) => entry.result.query.kind === "lexical")).toBe(true);
      expect(results.filter((entry) => entry.result.status === "abstained")).toHaveLength(16);
      expect(results.filter((entry) =>
        ["lexical_collision", "boilerplate_collision"].includes(entry.category) &&
        entry.result.status === "matched")).toHaveLength(8);
    } finally {
      materialized.store.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
