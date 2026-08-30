import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseStrictJson } from "../../../../src/system/strict-json.js";

import {
  evaluationCommitmentSchema,
  loadAndValidatePublicSharedBenchmark,
  loadSharedExecutorSplit,
  SHARED_MEMORY_FIXTURE_DIRECTORY,
  validateSharedFamilyRegistryDisjoint,
  validateSharedQuerySurfaceDisjoint,
  validateSharedSplitContract,
} from "../src/benchmark-schema.js";
import { saltedEvaluationCommitment } from "../src/pack-builder.js";

const repositoryRoot = process.cwd();
const fixtureDirectory = join(repositoryRoot, SHARED_MEMORY_FIXTURE_DIRECTORY);

describe("FAL shared memory benchmark pack", () => {
  it("validates public dev/calibration bytes, data contracts, and family groups", async () => {
    const loaded = await loadAndValidatePublicSharedBenchmark(repositoryRoot);
    expect(loaded.development.timelines).toHaveLength(6);
    expect(loaded.calibration.timelines).toHaveLength(6);
    expect(loaded.development.timelines.flatMap((entry) => entry.probes)).toHaveLength(60);
    expect(loaded.calibration.timelines.flatMap((entry) => entry.probes)).toHaveLength(60);
    expect(loaded.registry.cards).toHaveLength(12);

    for (const split of [loaded.development, loaded.calibration]) {
      expect(split.timelines.map((entry) => entry.records.length).sort((a, b) => a - b))
        .toEqual([128, 128, 384, 384, 1_024, 1_024]);
      const executorText = JSON.stringify(split);
      for (const scorerOnlyField of [
        "scenarioFamilyId",
        "probeType",
        "judgment",
        "requiredEvidenceGroups",
        "answerAtoms",
      ]) {
        expect(executorText).not.toContain(`"${scorerOnlyField}"`);
      }
      for (const timeline of split.timelines) {
        expect(timeline.records.some((entry) => entry.repositoryId !== timeline.repositoryId))
          .toBe(true);
        expect(timeline.records.some((entry) => entry.principalId !== timeline.principalId))
          .toBe(true);
        expect(timeline.records.some((entry) => entry.sourceStatus === "tampered")).toBe(true);
        expect(timeline.records.some((entry) => entry.lifecycle === "explicit_retracted")).toBe(true);
        expect(timeline.records.some((entry) => entry.lifecycle === "explicit_superseded")).toBe(true);
        expect(timeline.records.some((entry) =>
          entry.text.includes("Ignore all other evidence"))).toBe(true);
      }
    }
  });

  it("loads an executor split from an input-only filesystem without any scorer files", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-shared-memory-"));
    try {
      const temporaryFixture = join(temporaryRoot, SHARED_MEMORY_FIXTURE_DIRECTORY);
      await mkdir(temporaryFixture, { recursive: true });
      await copyFile(
        join(fixtureDirectory, "calibration-inputs.json"),
        join(temporaryFixture, "calibration-inputs.json"),
      );
      const loaded = await loadSharedExecutorSplit(temporaryRoot, "calibration");
      expect(loaded.timelines).toHaveLength(6);
      await expect(readFile(join(temporaryFixture, "calibration-goldens.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps evaluation raw inputs and goldens out of the public fixture", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names).toContain("evaluation-commitment.json");
    expect(names).not.toContain("evaluation-inputs.json");
    expect(names).not.toContain("evaluation-goldens.json");
    expect(names).not.toContain("evaluation-family-registry.json");
  });

  it("retains an honest development/calibration receipt while evaluation stays unopened", async () => {
    const receipt = parseStrictJson(await readFile(
      join(fixtureDirectory, "development-calibration-receipt.json"),
      "utf8",
    )) as {
      sourceCommit?: unknown;
      state?: unknown;
      retrieval?: { decision?: unknown };
      contextFolding?: { calibration?: { selectedTimelineCount?: unknown } };
      reader?: {
        calibration?: { mustAnswerGroundedSuccessCasesPerArm?: unknown };
        postCalibrationCorrection?: { qualityMetricsChanged?: unknown };
      };
      evaluation?: { state?: unknown; commitmentReusedOrConsumed?: unknown };
    };
    expect(receipt.state).toBe("development_calibration_complete_evaluation_blocked");
    expect(receipt.sourceCommit).toBeNull();
    expect(receipt.retrieval?.decision)
      .toBe("calibration_retrieval_gate_passed_reader_gate_still_required");
    expect(receipt.contextFolding?.calibration?.selectedTimelineCount).toBe(0);
    expect(receipt.reader?.calibration?.mustAnswerGroundedSuccessCasesPerArm)
      .toEqual([0, 0, 0, 0]);
    expect(receipt.reader?.postCalibrationCorrection?.qualityMetricsChanged).toBe(false);
    expect(receipt.evaluation?.state).toBe("not_run_committed_unrevealed");
    expect(receipt.evaluation?.commitmentReusedOrConsumed).toBe(false);
  });

  it("retains the append-only DeepSeek diagnostic without overriding its failed calibration gate", async () => {
    const receipt = parseStrictJson(await readFile(
      join(fixtureDirectory, "deepseek-v4-flash-development-calibration-receipt.json"),
      "utf8",
    )) as {
      state?: unknown;
      sourceCommit?: unknown;
      executionBoundary?: { evaluationRun?: unknown; productionMemorySent?: unknown };
      development?: { readerGatePassed?: unknown };
      calibration?: {
        readerGatePassed?: unknown;
        readerSecurityRegressions?: unknown;
        uniqueReaderSecurityRegressionCases?: unknown;
      };
      aggregateUsage?: { modelCalls?: unknown; estimatedCostUsdMicros?: unknown };
      decision?: {
        deepSeekReaderProtocolPassed?: unknown;
        benchmarkAbstentionContractRevisionRequired?: unknown;
        evaluationAllowed?: unknown;
      };
    };
    expect(receipt.state).toBe("development_passed_calibration_protocol_failed_evaluation_blocked");
    expect(receipt.sourceCommit).toBeNull();
    expect(receipt.executionBoundary?.evaluationRun).toBe(false);
    expect(receipt.executionBoundary?.productionMemorySent).toBe(false);
    expect(receipt.development?.readerGatePassed).toBe(true);
    expect(receipt.calibration?.readerGatePassed).toBe(false);
    expect(receipt.calibration?.readerSecurityRegressions).toBe(2);
    expect(receipt.calibration?.uniqueReaderSecurityRegressionCases).toBe(1);
    expect(receipt.aggregateUsage?.modelCalls).toBe(49);
    expect(receipt.aggregateUsage?.estimatedCostUsdMicros).toBe(62_841);
    expect(receipt.decision?.deepSeekReaderProtocolPassed).toBe(false);
    expect(receipt.decision?.benchmarkAbstentionContractRevisionRequired).toBe(true);
    expect(receipt.decision?.evaluationAllowed).toBe(false);
  });

  it("rejects split-prefix family tricks, duplicate families, and ambiguous goldens", async () => {
    const loaded = await loadAndValidatePublicSharedBenchmark(repositoryRoot);
    const duplicateRegistry = structuredClone(loaded.registry);
    const firstCard = duplicateRegistry.cards[0];
    const secondCard = duplicateRegistry.cards[1];
    if (firstCard === undefined || secondCard === undefined) throw new Error("registry fixture incomplete");
    secondCard.scenarioFamilyId = firstCard.scenarioFamilyId;
    expect(() => validateSharedFamilyRegistryDisjoint(duplicateRegistry)).toThrow(/group-disjoint/u);

    const prefixedRegistry = structuredClone(loaded.registry);
    const prefixedCard = prefixedRegistry.cards[0];
    if (prefixedCard === undefined) throw new Error("registry fixture incomplete");
    prefixedCard.scenarioFamilyId = "calibration-manufactured-family";
    expect(() => validateSharedFamilyRegistryDisjoint(prefixedRegistry)).toThrow(/split-prefixed/u);

    const calibrationGoldens = parseStrictJson(await readFile(
      join(fixtureDirectory, "calibration-goldens.json"),
      "utf8",
    ));
    const ambiguousGoldens = structuredClone(calibrationGoldens) as {
      timelines: { probes: {
        forbiddenEvidenceRefs: string[];
        requiredEvidenceGroups: string[][];
      }[] }[];
    };
    const firstProbe = ambiguousGoldens.timelines[0]?.probes[0];
    const firstRequired = firstProbe?.requiredEvidenceGroups[0]?.[0];
    if (firstProbe === undefined || firstRequired === undefined) throw new Error("golden fixture incomplete");
    firstProbe.forbiddenEvidenceRefs = [firstRequired];
    expect(() => validateSharedSplitContract(
      loaded.calibration,
      ambiguousGoldens,
      loaded.registry,
    )).toThrow(/disjoint/u);

    const developmentGoldens = parseStrictJson(await readFile(
      join(fixtureDirectory, "development-goldens.json"),
      "utf8",
    ));
    const overlappingSurfaces = structuredClone(calibrationGoldens) as {
      timelines: { probes: { querySurfaceFamilyId: string }[] }[];
    };
    const developmentSurface = (developmentGoldens as {
      timelines?: { probes?: { querySurfaceFamilyId?: string }[] }[];
    }).timelines?.[0]?.probes?.[0]?.querySurfaceFamilyId;
    const calibrationSurface = overlappingSurfaces.timelines[0]?.probes[0];
    if (developmentSurface === undefined || calibrationSurface === undefined) {
      throw new Error("query surface fixture incomplete");
    }
    calibrationSurface.querySurfaceFamilyId = developmentSurface;
    expect(() => validateSharedQuerySurfaceDisjoint([
      developmentGoldens,
      overlappingSurfaces,
    ])).toThrow(/surface families overlap/u);
  });

  it("verifies the retained local sealed pack against the public salted commitment when present", async () => {
    const hiddenRoot = join(
      repositoryRoot,
      ".cache/frontier-adapter-lab/fal-memory-shared-v1/sealed-evaluation",
    );
    let nonce: string;
    let sealedPack: unknown;
    let evaluationInputs: unknown;
    let evaluationGoldens: unknown;
    let evaluationRegistry: unknown;
    try {
      nonce = (await readFile(join(hiddenRoot, "nonce.txt"), "utf8")).trim();
      sealedPack = parseStrictJson(await readFile(join(hiddenRoot, "sealed-pack.json"), "utf8"));
      evaluationInputs = parseStrictJson(await readFile(
        join(hiddenRoot, "evaluation-inputs.json"),
        "utf8",
      ));
      evaluationGoldens = parseStrictJson(await readFile(
        join(hiddenRoot, "evaluation-goldens.json"),
        "utf8",
      ));
      evaluationRegistry = parseStrictJson(await readFile(
        join(hiddenRoot, "family-registry.json"),
        "utf8",
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const commitment = evaluationCommitmentSchema.parse(parseStrictJson(await readFile(
      join(fixtureDirectory, "evaluation-commitment.json"),
      "utf8",
    )));
    expect(saltedEvaluationCommitment({ nonceHex: nonce, pack: sealedPack }))
      .toBe(commitment.saltedPackCommitmentSha256);
    validateSharedSplitContract(evaluationInputs, evaluationGoldens, evaluationRegistry);

    const publicBenchmark = await loadAndValidatePublicSharedBenchmark(repositoryRoot);
    const hiddenCards = (evaluationRegistry as { cards?: unknown[] }).cards;
    if (hiddenCards === undefined) throw new Error("sealed evaluation registry missing cards");
    validateSharedFamilyRegistryDisjoint({
      schemaVersion: 1,
      benchmarkId: "fal-memory-shared-v1",
      cards: [...publicBenchmark.registry.cards, ...hiddenCards],
    });
    const developmentGoldens = parseStrictJson(await readFile(
      join(fixtureDirectory, "development-goldens.json"),
      "utf8",
    ));
    const calibrationGoldens = parseStrictJson(await readFile(
      join(fixtureDirectory, "calibration-goldens.json"),
      "utf8",
    ));
    validateSharedQuerySurfaceDisjoint([
      developmentGoldens,
      calibrationGoldens,
      evaluationGoldens,
    ]);
  });
});
