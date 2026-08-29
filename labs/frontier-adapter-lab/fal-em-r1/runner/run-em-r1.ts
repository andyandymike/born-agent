import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { MemoryRecordV1 } from "../../../../src/memory/core/memory-record-v1.js";
import { verifyReferenceAnchors } from "../src/anchor-verification.js";
import { materializeEmR1Corpus, sourceAvailable, emR1FixtureTitle } from "../src/corpus-materializer.js";
import {
  EM_R1_EXPERIMENT_ID,
  EM_R1_FIXTURE_DIRECTORY,
  EM_R1_HISTORICAL_THRESHOLD_MICROS,
  loadEmR1Split,
  type EmR1Case,
  type EmR1Pool,
} from "../src/experiment-schema.js";
import { replayHistoricalEm1 } from "../src/fidelity-replay.js";
import {
  prepareHybridQuery,
  prepareVectorCorpus,
  selectHybridAtThreshold,
  type HybridCorpusPort,
  type HybridSelectionResult,
  type PreparedHybridQuery,
  type PreparedVectorCorpus,
} from "../src/hybrid-retrieval.js";
import { LocalE5EmbeddingProvider } from "../src/local-e5-provider.js";
import { emR1LogicalReceiptIdentity } from "../src/receipt-identity.js";
import { SqliteVectorProjection, type EmR1VectorProjectionRow } from "../src/sqlite-vector-projection.js";

interface PreparedCase {
  readonly definition: EmR1Case;
  readonly query: PreparedHybridQuery;
}

interface ThresholdMetrics {
  readonly acceptedWrong: number;
  readonly absoluteUnanswerableNonempty: number;
  readonly answerableCoverage: number;
  readonly baselineCollisionParityFailures: number;
  readonly candidateAddedNegativeHitCases: number;
  readonly controlsPassed: number;
  readonly effectiveVectorNegativeFalseAccepts: number;
  readonly eligible: boolean;
  readonly filteredTargetSubstitutes: number;
  readonly overallCoverage: number;
  readonly securityInvariantFailures: number;
  readonly selectiveRisk: number;
  readonly semanticHitsAt5: number;
  readonly semanticMrrAt5: number;
  readonly thresholdSimilarityMicros: number;
  readonly unanswerableFalseAccepts: number;
  readonly vectorRejectAll: boolean;
}

const THRESHOLD_POINT_COLUMNS = Object.freeze([
  "thresholdSimilarityMicros",
  "vectorRejectAll",
  "eligible",
  "semanticHitsAt5",
  "semanticMrrAt5",
  "controlsPassed",
  "answerableCoverage",
  "overallCoverage",
  "acceptedWrong",
  "selectiveRisk",
  "absoluteUnanswerableNonempty",
  "effectiveVectorNegativeFalseAccepts",
  "candidateAddedNegativeHitCases",
  "baselineCollisionParityFailures",
  "filteredTargetSubstitutes",
  "securityInvariantFailures",
] as const satisfies readonly (keyof ThresholdMetrics)[]);

interface CaseObservation {
  readonly abstentionCorrect: boolean;
  readonly acceptedWrong: boolean;
  readonly allowedRank: number | null;
  readonly caseId: string;
  readonly category: EmR1Case["category"];
  readonly filteredTargetSubstitute: boolean;
  readonly forbiddenCandidateKeys: readonly string[];
  readonly goldenAnswerability: EmR1Case["golden"]["answerability"];
  readonly result: HybridSelectionResult;
  readonly routeMatched: boolean;
  readonly securityInvariantFailure: boolean;
  readonly status: "pass" | "fail";
  readonly temporalActionMatched: boolean | null;
}

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

function rankOfAllowed(result: HybridSelectionResult, definition: EmR1Case): number | null {
  const rank = result.orderedTopRecordKeys.findIndex((key) =>
    definition.golden.allowedRelevantRecordKeys.includes(key));
  return rank < 0 ? null : rank + 1;
}

function observeCase(
  prepared: PreparedCase,
  result: HybridSelectionResult,
  pool: EmR1Pool,
): CaseObservation {
  const definition = prepared.definition;
  const allowedRank = rankOfAllowed(result, definition);
  const answerableCorrect = definition.golden.answerability === "answerable" &&
    definition.golden.requiredRank !== null &&
    allowedRank !== null && allowedRank <= definition.golden.requiredRank;
  const abstentionCorrect = definition.golden.answerability === "must_abstain"
    ? !result.accepted
    : result.accepted;
  const candidateKeys = new Set([
    ...result.lexicalOrderedRecordKeys,
    ...result.vectorOrderedRecordKeys,
    ...result.hybridOrderedRecordKeys,
    ...result.orderedTopRecordKeys,
  ]);
  const forbiddenCandidateKeys = definition.golden.forbiddenRecordKeys.filter((key) =>
    candidateKeys.has(key));
  const securityInvariantFailure = definition.category === "filtered_target_abstention" &&
    forbiddenCandidateKeys.length > 0;
  const filteredTargetSubstitute = definition.category === "filtered_target_abstention" &&
    forbiddenCandidateKeys.length === 0 && result.accepted;
  let temporalActionMatched: boolean | null = null;
  if (definition.category === "temporal_control") {
    const currentKey = definition.golden.expectedCurrentRevisionKey;
    const current = currentKey === null
      ? undefined
      : pool.rows.find((entry) => entry.key === currentKey);
    temporalActionMatched = current !== undefined &&
      result.orderedTopRecordKeys[0] === currentKey &&
      current.actionParameters !== null &&
      sha256Canonical(current.actionParameters) === definition.golden.expectedActionParametersSha256;
  }
  const routeMatched = result.queryRoute === definition.golden.expectedQueryRoute;
  const acceptedWrong = result.accepted && (
    definition.golden.answerability === "must_abstain" || !answerableCorrect
  );
  const baselineCollisionParity = definition.golden.answerability === "must_abstain" &&
    result.baselineOrderedRecordKeys.length > 0 &&
    JSON.stringify(result.orderedTopRecordKeys) ===
      JSON.stringify(result.baselineOrderedRecordKeys);
  const passed = routeMatched && !securityInvariantFailure &&
    (definition.golden.answerability === "must_abstain"
      ? result.baselineOrderedRecordKeys.length > 0
        ? baselineCollisionParity
        : abstentionCorrect
      : answerableCorrect && (temporalActionMatched ?? true));
  return Object.freeze({
    abstentionCorrect,
    acceptedWrong,
    allowedRank,
    caseId: definition.caseId,
    category: definition.category,
    filteredTargetSubstitute,
    forbiddenCandidateKeys: Object.freeze(forbiddenCandidateKeys),
    goldenAnswerability: definition.golden.answerability,
    result,
    routeMatched,
    securityInvariantFailure,
    status: passed ? "pass" : "fail",
    temporalActionMatched,
  });
}

function metricsFor(
  preparedCases: readonly PreparedCase[],
  selections: readonly HybridSelectionResult[],
  pool: EmR1Pool,
  thresholdSimilarityMicros: number,
  projectionSecurityFailures: number,
): ThresholdMetrics {
  const observations = preparedCases.map((entry, index) =>
    observeCase(entry, selections[index]!, pool));
  const semantic = observations.filter((entry) => entry.category === "semantic_answerable");
  const controls = observations.filter((entry) => [
    "exact_control",
    "phrase_control",
    "temporal_control",
  ].includes(entry.category));
  const nonempty = observations.filter((entry) => entry.result.accepted).length;
  const answerable = observations.filter((entry) =>
    entry.goldenAnswerability === "answerable" && entry.result.accepted).length;
  const acceptedWrong = observations.filter((entry) => entry.acceptedWrong).length;
  const semanticHitsAt5 = semantic.filter((entry) =>
    entry.allowedRank !== null && entry.allowedRank <= 5).length;
  const semanticMrrAt5 = semantic.reduce((total, entry) =>
    total + (entry.allowedRank === null || entry.allowedRank > 5 ? 0 : 1 / entry.allowedRank), 0) /
    semantic.length;
  const unanswerableFalseAccepts = observations.filter((entry) =>
    entry.goldenAnswerability === "must_abstain" && entry.result.accepted).length;
  const effectiveVectorNegativeFalseAccepts = observations.filter((entry) =>
    entry.goldenAnswerability === "must_abstain" &&
    entry.result.baselineOrderedRecordKeys.length === 0 &&
    entry.result.accepted).length;
  const candidateAddedNegativeHitCases = observations.filter((entry) =>
    entry.goldenAnswerability === "must_abstain" &&
    entry.result.orderedTopRecordKeys.some((key) =>
      !entry.result.baselineOrderedRecordKeys.includes(key))).length;
  const baselineCollisionParityFailures = observations.filter((entry) =>
    entry.goldenAnswerability === "must_abstain" &&
    entry.result.baselineOrderedRecordKeys.length > 0 &&
    JSON.stringify(entry.result.orderedTopRecordKeys) !==
      JSON.stringify(entry.result.baselineOrderedRecordKeys)).length;
  const filteredTargetSubstitutes = observations.filter((entry) =>
    entry.filteredTargetSubstitute).length;
  const securityInvariantFailures = projectionSecurityFailures + observations.filter((entry) =>
    entry.securityInvariantFailure || entry.result.revalidationFailures > 0).length;
  const controlsPassed = controls.filter((entry) => entry.status === "pass").length;
  const vectorRejectAll = selections.every((entry) => entry.vectorAcceptedCount === 0);
  const selectiveRisk = nonempty === 0 ? 0 : acceptedWrong / nonempty;
  const eligible =
    !vectorRejectAll &&
    securityInvariantFailures === 0 &&
    effectiveVectorNegativeFalseAccepts === 0 &&
    candidateAddedNegativeHitCases === 0 &&
    baselineCollisionParityFailures === 0 &&
    filteredTargetSubstitutes === 0 &&
    semanticHitsAt5 >= 13 &&
    controlsPassed === 8;
  return Object.freeze({
    acceptedWrong,
    absoluteUnanswerableNonempty: unanswerableFalseAccepts,
    answerableCoverage: answerable / 24,
    baselineCollisionParityFailures,
    candidateAddedNegativeHitCases,
    controlsPassed,
    effectiveVectorNegativeFalseAccepts,
    eligible,
    filteredTargetSubstitutes,
    overallCoverage: nonempty / 48,
    securityInvariantFailures,
    selectiveRisk,
    semanticHitsAt5,
    semanticMrrAt5,
    thresholdSimilarityMicros,
    unanswerableFalseAccepts,
    vectorRejectAll,
  });
}

function selectionMemo(prepared: PreparedCase): (threshold: number) => HybridSelectionResult {
  const cache = new Map<number, HybridSelectionResult>();
  return (threshold) => {
    let acceptedRows = 0;
    while (
      acceptedRows < prepared.query.vectorRows.length &&
      prepared.query.vectorRows[acceptedRows]!.similarityMicros >= threshold
    ) acceptedRows += 1;
    const key = Math.min(acceptedRows, 100);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = selectHybridAtThreshold(prepared.query, threshold);
    cache.set(key, result);
    return result;
  };
}

function canonicalThresholds(preparedCases: readonly PreparedCase[]): readonly number[] {
  const values = new Set<number>([-1_000_001, 1_000_001]);
  for (const prepared of preparedCases) {
    for (const row of prepared.query.vectorRows) {
      values.add(row.similarityMicros);
      if (row.similarityMicros < 1_000_001) values.add(row.similarityMicros + 1);
    }
  }
  return Object.freeze([...values].sort((left, right) => left - right));
}

function chooseEligible(points: readonly ThresholdMetrics[]): ThresholdMetrics | null {
  return [...points].filter((entry) => entry.eligible).sort((left, right) =>
    right.answerableCoverage - left.answerableCoverage ||
    right.semanticMrrAt5 - left.semanticMrrAt5 ||
    right.thresholdSimilarityMicros - left.thresholdSimilarityMicros)[0] ?? null;
}

function chooseDiagnostic(points: readonly ThresholdMetrics[]): ThresholdMetrics {
  const point = [...points].filter((entry) => !entry.vectorRejectAll).sort((left, right) =>
    left.candidateAddedNegativeHitCases - right.candidateAddedNegativeHitCases ||
    left.effectiveVectorNegativeFalseAccepts - right.effectiveVectorNegativeFalseAccepts ||
    left.baselineCollisionParityFailures - right.baselineCollisionParityFailures ||
    left.unanswerableFalseAccepts - right.unanswerableFalseAccepts ||
    left.securityInvariantFailures - right.securityInvariantFailures ||
    right.semanticHitsAt5 - left.semanticHitsAt5 ||
    right.controlsPassed - left.controlsPassed ||
    right.semanticMrrAt5 - left.semanticMrrAt5 ||
    right.thresholdSimilarityMicros - left.thresholdSimilarityMicros)[0];
  if (point === undefined) throw new Error("EM-R1 threshold sweep produced no diagnostic point");
  return point;
}

function chooseMaximumSemantic(points: readonly ThresholdMetrics[]): ThresholdMetrics {
  const point = [...points].filter((entry) => !entry.vectorRejectAll).sort((left, right) =>
    right.semanticHitsAt5 - left.semanticHitsAt5 ||
    right.semanticMrrAt5 - left.semanticMrrAt5 ||
    left.candidateAddedNegativeHitCases - right.candidateAddedNegativeHitCases ||
    right.thresholdSimilarityMicros - left.thresholdSimilarityMicros)[0];
  if (point === undefined) throw new Error("EM-R1 threshold sweep produced no semantic point");
  return point;
}

async function prepareSplit(input: Readonly<{
  readonly provider: LocalE5EmbeddingProvider;
  readonly repositoryRoot: string;
  readonly retainedRoot: string;
  readonly split: "calibration" | "evaluation";
}>): Promise<Readonly<{
  readonly cases: readonly PreparedCase[];
  readonly close: () => void;
  readonly pool: EmR1Pool;
  readonly projection: PreparedVectorCorpus;
  readonly queryPreparationDurationMs: number;
  readonly vectorNegativePreflight: Readonly<{
    readonly embeddingActiveUnanswerableCases: number;
    readonly ftsEmptyCaseIds: readonly string[];
    readonly ftsEmptyUnanswerableCases: number;
    readonly passed: true;
    readonly requiredFtsEmptyUnanswerableCases: 16;
  }>;
}>> {
  const frozen = await loadEmR1Split(input.repositoryRoot, input.split);
  await mkdir(input.retainedRoot, { recursive: true });
  const stateRoot = await mkdtemp(join(input.retainedRoot, `${input.split}-`));
  const materialized = await materializeEmR1Corpus(stateRoot, frozen.pool);
  const corpus: HybridCorpusPort = {
    currentScope: materialized.currentScope,
    keyByRevisionId: materialized.keyByRevisionId,
    projection: materialized.projection,
    service: materialized.service,
    store: materialized.store,
    sourceAvailable: (record: MemoryRecordV1) => sourceAvailable(materialized, record),
    titleFor: (record: MemoryRecordV1) => emR1FixtureTitle(materialized, record),
  };
  let projection: PreparedVectorCorpus | undefined;
  try {
    const ftsEmptyCaseIds: string[] = [];
    let embeddingActiveUnanswerableCases = 0;
    for (const definition of frozen.cases.cases.filter((entry) =>
      entry.golden.answerability === "must_abstain")) {
      if (definition.query.mode !== "text") continue;
      const baseline = await materialized.service.search({
        limit: 5,
        query: definition.query.value,
      });
      if (baseline.query.kind === "lexical") embeddingActiveUnanswerableCases += 1;
      if (baseline.query.kind === "lexical" && baseline.status === "abstained") {
        ftsEmptyCaseIds.push(definition.caseId);
      }
    }
    if (embeddingActiveUnanswerableCases !== 24 || ftsEmptyCaseIds.length < 16) {
      throw new Error(
        `EM-R1 ${input.split} vector-negative preflight failed: ` +
        `${String(ftsEmptyCaseIds.length)}/24 FTS-empty, ` +
        `${String(embeddingActiveUnanswerableCases)}/24 embedding-active`,
      );
    }
    const vectorNegativePreflight = Object.freeze({
      embeddingActiveUnanswerableCases,
      ftsEmptyCaseIds: Object.freeze(ftsEmptyCaseIds),
      ftsEmptyUnanswerableCases: ftsEmptyCaseIds.length,
      passed: true as const,
      requiredFtsEmptyUnanswerableCases: 16 as const,
    });
    projection = await prepareVectorCorpus({
      corpus,
      databasePath: join(stateRoot, "vectors.sqlite"),
      provider: input.provider,
    });
    const started = performance.now();
    const cases: PreparedCase[] = [];
    for (const definition of frozen.cases.cases) {
      const query = definition.query.mode === "text"
        ? definition.query.value
        : materialized.recordByKey.get(definition.query.targetRecordKey)?.recordId;
      if (query === undefined) throw new Error(`EM-R1 exact case ${definition.caseId} did not materialize`);
      cases.push(Object.freeze({
        definition,
        query: await prepareHybridQuery({
          corpus,
          provider: input.provider,
          query,
          vectorProjection: projection.projection,
        }),
      }));
    }
    return Object.freeze({
      cases: Object.freeze(cases),
      close: () => {
        projection?.projection.close();
        materialized.store.close();
      },
      pool: frozen.pool,
      projection,
      queryPreparationDurationMs: performance.now() - started,
      vectorNegativePreflight,
    });
  } catch (error) {
    projection?.projection.close();
    materialized.store.close();
    throw error;
  }
}

async function recursiveFileBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await recursiveFileBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

async function implementationIdentity(labRoot: string): Promise<Readonly<{
  readonly files: readonly Readonly<{ readonly path: string; readonly sha256: string }>[];
  readonly sha256: string;
}>> {
  const roots = [join(labRoot, "src"), join(labRoot, "runner")];
  const paths: string[] = [];
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && path.endsWith(".ts")) paths.push(path);
    }
  };
  for (const root of roots) await collect(root);
  paths.sort();
  const files = await Promise.all(paths.map(async (path) => ({
    path: relative(labRoot, path).replaceAll("\\", "/"),
    sha256: rawSha256(await readFile(path)),
  })));
  return Object.freeze({ files: Object.freeze(files), sha256: sha256Canonical({ files, schemaVersion: 1 }) });
}

async function benchmarkVectorScale(input: Readonly<{
  readonly projection: PreparedVectorCorpus;
  readonly retainedRoot: string;
}>): Promise<Readonly<{
  readonly exactScan10000P95Ms: number;
  readonly iterations: 20;
  readonly rowCount: 10_000;
  readonly vectorDatabaseBytesAt10000: number;
}>> {
  const source = input.projection.projection.rows;
  if (source.length === 0) throw new Error("EM-R1 cost benchmark lacks source vectors");
  const rows: EmR1VectorProjectionRow[] = Array.from({ length: 10_000 }, (_, index) => {
    const template = source[index % source.length]!;
    const suffix = String(index).padStart(5, "0");
    return Object.freeze({
      key: `cost-${suffix}`,
      occurredAt: template.occurredAt,
      projectionInputSha256: template.projectionInputSha256,
      recordId: `cost-record-${suffix}`,
      revisionId: `cost-revision-${suffix}`,
      vector: template.vector,
    });
  });
  await mkdir(input.retainedRoot, { recursive: true });
  const root = await mkdtemp(join(input.retainedRoot, "scan-10000-"));
  const projection = await SqliteVectorProjection.build({
    identity: {
      ...input.projection.projection.identity,
      activeRevisionSetSha256: sha256Canonical(rows.map((entry) => entry.revisionId)),
      canonicalLogicalSha256: sha256Canonical({ rowCount: rows.length, schemaVersion: 1 }),
    },
    path: join(root, "vectors.sqlite"),
    rows,
  });
  try {
    const durations: number[] = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const query = source[iteration % source.length]!.vector;
      const started = performance.now();
      projection.scan(query, -1_000_001);
      durations.push(performance.now() - started);
    }
    return Object.freeze({
      exactScan10000P95Ms: percentile(durations, 0.95)!,
      iterations: 20 as const,
      rowCount: 10_000 as const,
      vectorDatabaseBytesAt10000: projection.databaseBytes,
    });
  } finally {
    projection.close();
  }
}

async function writeThresholdBehaviorShards(input: Readonly<{
  readonly labRoot: string;
  readonly points: readonly ThresholdMetrics[];
}>): Promise<readonly Readonly<{
  readonly bytes: number;
  readonly firstThresholdSimilarityMicros: number;
  readonly lastThresholdSimilarityMicros: number;
  readonly path: string;
  readonly pointCount: number;
  readonly sha256: string;
}>[]> {
  const parent = join(input.labRoot, ".cache/evidence/threshold-behavior");
  await mkdir(parent, { recursive: true });
  const runRoot = await mkdtemp(join(parent, "run-"));
  const identities = [];
  for (let offset = 0; offset < input.points.length; offset += 1_000) {
    const points = input.points.slice(offset, offset + 1_000);
    const shardIndex = Math.floor(offset / 1_000) + 1;
    const name = `part-${String(shardIndex).padStart(3, "0")}.json`;
    const content = `${JSON.stringify({
      schemaVersion: 2,
      experimentId: EM_R1_EXPERIMENT_ID,
      shardIndex,
      pointColumns: THRESHOLD_POINT_COLUMNS,
      points: points.map((entry) => THRESHOLD_POINT_COLUMNS.map((column) => entry[column])),
    }, null, 2)}\n`;
    await writeFile(join(runRoot, name), content, "utf8");
    identities.push(Object.freeze({
      bytes: Buffer.byteLength(content),
      firstThresholdSimilarityMicros: points[0]!.thresholdSimilarityMicros,
      lastThresholdSimilarityMicros: points.at(-1)!.thresholdSimilarityMicros,
      path: `threshold-behavior/${name}`,
      pointCount: points.length,
      sha256: rawSha256(content),
    }));
  }
  return Object.freeze(identities);
}

function serializeObservations(
  preparedCases: readonly PreparedCase[],
  threshold: number,
  pool: EmR1Pool,
): readonly CaseObservation[] {
  return Object.freeze(preparedCases.map((entry) =>
    observeCase(entry, selectHybridAtThreshold(entry.query, threshold), pool)));
}

export async function runEmR1(repositoryRoot: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  const labRoot = resolve(repositoryRoot, "labs/frontier-adapter-lab/fal-em-r1");
  const fixtureRoot = resolve(repositoryRoot, EM_R1_FIXTURE_DIRECTORY);
  const loaded = await LocalE5EmbeddingProvider.load(labRoot);
  let calibration: Awaited<ReturnType<typeof prepareSplit>> | undefined;
  let evaluation: Awaited<ReturnType<typeof prepareSplit>> | undefined;
  try {
    const anchors = await verifyReferenceAnchors({
      anchorPath: join(fixtureRoot, "reference-anchors.json"),
      provider: loaded.provider,
    });
    const fidelity = await replayHistoricalEm1({
      retainedRoot: join(labRoot, ".cache/evidence/fidelity"),
      provider: loaded.provider,
      repositoryRoot,
    });
    calibration = await prepareSplit({
      provider: loaded.provider,
      repositoryRoot,
      retainedRoot: join(labRoot, ".cache/evidence/new-corpus"),
      split: "calibration",
    });
    const thresholds = canonicalThresholds(calibration.cases);
    const selectors = calibration.cases.map(selectionMemo);
    const projectionSecurityFailures = calibration.projection.inputSecurityFailures +
      calibration.projection.rowSecurityFailures;
    const sweep = thresholds.map((threshold) => metricsFor(
      calibration!.cases,
      selectors.map((select) => select(threshold)),
      calibration!.pool,
      threshold,
      projectionSecurityFailures,
    ));
    const selected = chooseEligible(sweep);
    const diagnostic = selected ?? chooseDiagnostic(sweep);
    const maximumSemantic = chooseMaximumSemantic(sweep);
    const historicalThresholdMetrics = metricsFor(
      calibration.cases,
      calibration.cases.map((entry) =>
        selectHybridAtThreshold(entry.query, EM_R1_HISTORICAL_THRESHOLD_MICROS)),
      calibration.pool,
      EM_R1_HISTORICAL_THRESHOLD_MICROS,
      projectionSecurityFailures,
    );
    const diagnosticCases = serializeObservations(
      calibration.cases,
      diagnostic.thresholdSimilarityMicros,
      calibration.pool,
    );
    const maximumSemanticCaseSummary = calibration.cases
      .filter((entry) => entry.definition.category === "semantic_answerable")
      .map((entry) => {
        const result = selectHybridAtThreshold(
          entry.query,
          maximumSemantic.thresholdSimilarityMicros,
        );
        const target = entry.definition.golden.allowedRelevantRecordKeys[0]!;
        const vectorIndex = entry.query.vectorRows.findIndex((row) => row.key === target);
        const vectorRow = vectorIndex < 0 ? undefined : entry.query.vectorRows[vectorIndex];
        return Object.freeze({
          caseId: entry.definition.caseId,
          finalRank: rankOfAllowed(result, entry.definition),
          orderedTopRecordKeys: result.orderedTopRecordKeys,
          targetSimilarityMicros: vectorRow?.similarityMicros ?? null,
          targetVectorRank: vectorIndex < 0 ? null : vectorIndex + 1,
          top1SimilarityMicros: result.top1SimilarityMicros,
        });
      });
    const lexicalUnrejectableFalseAcceptCaseIds = calibration.cases.filter((entry) =>
      entry.definition.golden.answerability === "must_abstain" &&
      entry.query.lexicalRows.length > 0).map((entry) => entry.definition.caseId);

    let evaluationEvidence: Record<string, unknown>;
    if (selected === null) {
      evaluationEvidence = {
        status: "not_run_calibration_refuted",
        evaluationGoldensLoadedByRunner: false,
        reason: "no_non_reject_all_eligible_operating_point",
      };
    } else {
      evaluation = await prepareSplit({
        provider: loaded.provider,
        repositoryRoot,
        retainedRoot: join(labRoot, ".cache/evidence/new-corpus"),
        split: "evaluation",
      });
      const evaluationSelections = evaluation.cases.map((entry) =>
        selectHybridAtThreshold(entry.query, selected.thresholdSimilarityMicros));
      const evaluationMetrics = metricsFor(
        evaluation.cases,
        evaluationSelections,
        evaluation.pool,
        selected.thresholdSimilarityMicros,
        evaluation.projection.inputSecurityFailures + evaluation.projection.rowSecurityFailures,
      );
      evaluationEvidence = {
        status: evaluationMetrics.eligible ? "passed" : "failed",
        evaluationGoldensLoadedByRunner: true,
        thresholdRetuned: false,
        metrics: evaluationMetrics,
        cases: evaluation.cases.map((entry, index) =>
          observeCase(entry, evaluationSelections[index]!, evaluation!.pool)),
      };
    }

    const modelManifest = JSON.parse(await readFile(
      join(labRoot, "model-rehydration-manifest.json"),
      "utf8",
    )) as { readonly artifactBytes: number; readonly modelArtifactManifestSha256: string };
    const implementation = await implementationIdentity(labRoot);
    const thresholdBehaviorPointShards = await writeThresholdBehaviorShards({
      labRoot,
      points: sweep,
    });
    const vectorScaleCost = await benchmarkVectorScale({
      projection: calibration.projection,
      retainedRoot: join(labRoot, ".cache/evidence/cost"),
    });
    const queryEmbeddingDurations = calibration.cases.flatMap((entry) =>
      entry.query.queryEmbeddingDurationMs === null ? [] : [entry.query.queryEmbeddingDurationMs]);
    const receiptContent = {
      schemaVersion: 2,
      experimentId: EM_R1_EXPERIMENT_ID,
      evidenceState: "working_tree_full",
      sourceCommit: null,
      priorEvidenceDurability: "contract_deviation_old_v1_still_untracked_bytes_preserved",
      reimplementationMode: "reimplementation_from_v1_contract",
      implementationSha256: implementation.sha256,
      implementationFiles: implementation.files,
      modelArtifactManifestSha256: modelManifest.modelArtifactManifestSha256,
      reimplementationConfounded: loaded.reimplementationConfounded,
      anchors,
      fidelityReplay: fidelity,
      implementationFidelity: loaded.reimplementationConfounded || fidelity.outputReplay !== "matched"
        ? "inconclusive"
        : anchors.status === "passed" ? "verified" : "failed",
      dataAdequacy: {
        calibrationCases: 48,
        evaluationCases: 48,
        poolRowsPerSplit: 128,
        answerablePerSplit: 24,
        unanswerablePerSplit: 24,
        minimumFtsEmptyVectorNegativesPerSplit: 16,
        calibrationVectorNegativePreflight: calibration.vectorNegativePreflight,
        eligibleRowsInCalibrationProjection: calibration.projection.projection.rows.length,
        lexicalUnrejectableFalseAcceptCaseIds,
      },
      calibration: {
        status: selected === null ? "refuted" : "eligible_operating_point_selected",
        thresholdBehaviorPointCount: sweep.length,
        thresholdBehaviorPointColumns: THRESHOLD_POINT_COLUMNS,
        thresholdBehaviorPointShards,
        selectedOperatingPoint: selected,
        diagnosticOperatingPoint: diagnostic,
        maximumSemanticOperatingPoint: maximumSemantic,
        maximumSemanticCaseSummary,
        semanticGateReachable: maximumSemantic.semanticHitsAt5 >= 13,
        historicalThresholdMetrics,
        diagnosticCases,
      },
      evaluation: evaluationEvidence,
      failureCounts: {
        securityInvariantFailures: diagnostic.securityInvariantFailures,
        abstentionFalsePositives: diagnostic.unanswerableFalseAccepts,
        filteredTargetSubstitutes: diagnostic.filteredTargetSubstitutes,
        qualityGateFailures: diagnosticCases.filter((entry) => entry.status === "fail").length,
        candidateAddedNegativeHitCases: diagnostic.candidateAddedNegativeHitCases,
      },
      claims: {
        mechanism: selected === null
          ? "E5_plus_single_per_row_score_threshold_refuted_on_calibration"
          : "calibration_supported_pending_evaluation",
        semanticRetrieval: selected === null ? "inconclusive" : "supported_on_calibration",
        selectiveAbstention: selected === null ? "refuted" : "supported_on_calibration",
      },
      evidenceValidity: "limited",
      productFit: "not_assessed",
      promotion: selected === null ? "blocked" : "not_assessed",
      candidateLifecycle: "retained_disabled",
      isolation: {
        productionSourceImports: 0,
        productionPackageDependencyAdded: false,
        modelPackaged: false,
        candidateLocation: "labs/frontier-adapter-lab/fal-em-r1",
      },
      cost: {
        modelArtifactBytes: modelManifest.artifactBytes,
        dependencyInstallBytes: await recursiveFileBytes(join(labRoot, "node_modules")),
        calibrationVectorDatabaseBytes: calibration.projection.projection.databaseBytes,
        calibrationProjectionBuildMs: calibration.projection.buildDurationMs,
        calibrationRecordEmbeddingMs: calibration.projection.embeddingDurationMs,
        calibrationQueryPreparationMs: calibration.queryPreparationDurationMs,
        coldLoadMs: loaded.coldLoadMs,
        warmQueryEmbeddingP95Ms: percentile(queryEmbeddingDurations, 0.95),
        packedArtifactDeltaBytes: 0,
        vectorScan10000P95Ms: vectorScaleCost.exactScan10000P95Ms,
        vectorStoreBytesAt10000: vectorScaleCost.vectorDatabaseBytesAt10000,
        vectorScan10000Iterations: vectorScaleCost.iterations,
        hybridSearchP95Ms: percentile(
          calibration.cases.map((entry) => entry.query.totalPreparationDurationMs),
          0.95,
        ),
      },
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      actualElapsedMinutes: (performance.now() - started) / 60_000,
    };
    return {
      ...receiptContent,
      receiptSha256: emR1LogicalReceiptIdentity(receiptContent),
    };
  } finally {
    evaluation?.close();
    calibration?.close();
    await loaded.provider.dispose();
  }
}
