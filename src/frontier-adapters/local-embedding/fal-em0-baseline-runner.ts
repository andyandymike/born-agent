import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  createMl1EpisodeRecordV1,
  type Ml1EpisodeRecordV1,
  type Ml1MemoryScopeV1,
} from "../../memory/core/ml1-episode-record.js";
import {
  createExplicitMemoryRecordV1,
  memoryRecordRevisionId,
  sameMemoryScope,
  type ExplicitMemoryRecordV1,
  type MemoryRecordV1,
} from "../../memory/core/memory-record-v1.js";
import { Fts5EpisodeProjection } from "../../memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../memory/retrieval/lexical-memory-search-service.js";
import {
  ML2_RETRIEVER_ID,
  ML2_RETRIEVER_VERSION,
  ML2_SEARCH_MAX_ESTIMATED_TOKENS,
  ML2_SEARCH_MAX_TEXT_BYTES,
  parseMl2SearchQuery,
} from "../../memory/retrieval/ml2-search-contract.js";
import { SqliteEpisodeStore } from "../../memory/store/sqlite-episode-store.js";
import {
  loadFalEm0Corpus,
  type FalEm0CaseV1,
} from "./fal-em0-manifest.js";
import {
  createFalEm0Receipt,
  type FalEm0CaseResultV1,
  type FalEm0ReceiptV1,
} from "./fal-em0-receipt.js";

const BASELINE_IMPLEMENTATION_FILES = Object.freeze([
  "src/memory/core/memory-record-v1.ts",
  "src/memory/store/sqlite-episode-store.ts",
  "src/memory/retrieval/ml2-search-contract.ts",
  "src/memory/retrieval/fts5-episode-projection.ts",
  "src/memory/retrieval/lexical-memory-search-service.ts",
]);

export interface FalEm0MaterializedCase {
  readonly currentScope: Ml1MemoryScopeV1;
  readonly fixtureByRevisionId: ReadonlyMap<string, FalEm0CaseV1["records"][number]>;
  readonly keyByRevisionId: ReadonlyMap<string, string>;
  readonly recordByKey: ReadonlyMap<string, MemoryRecordV1>;
}

interface CaseObservation {
  readonly entryGateEligible: boolean;
  readonly gapExplained: boolean;
  readonly result: FalEm0CaseResultV1;
}

export interface RunFalEm0BaselineOptions {
  readonly actualFocusedMinutes?: number;
  readonly repositoryRoot: string;
}

export interface FalEm0BaselineRunV1 {
  readonly candidatePermitted: boolean;
  readonly receipt: FalEm0ReceiptV1;
}

export function falEm0CaseQuery(
  testCase: FalEm0CaseV1,
  materialized: FalEm0MaterializedCase,
): string {
  const query = testCase.query.mode === "text"
    ? testCase.query.value
    : materialized.recordByKey.get(testCase.query.targetRecordKey)?.recordId;
  if (query === undefined) throw new Error("FAL-EM0 exact query target did not materialize");
  return query;
}

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function falEm0ScopeFor(
  testCase: FalEm0CaseV1,
  kind: "current" | "foreign_repository" | "foreign_principal",
): Ml1MemoryScopeV1 {
  const current = Object.freeze({
    ownerPrincipalId: "fal-em0-local-user",
    applicationRepositoryId: `fal-em0:${testCase.caseId}`,
    canonicalRootIdentitySha256: rawSha256(`fal-em0-root:${testCase.caseId}`),
  });
  if (kind === "current") return current;
  if (kind === "foreign_repository") {
    return Object.freeze({
      ...current,
      applicationRepositoryId: `${current.applicationRepositoryId}:foreign`,
      canonicalRootIdentitySha256: rawSha256(`fal-em0-foreign-root:${testCase.caseId}`),
    });
  }
  return Object.freeze({
    ...current,
    ownerPrincipalId: "fal-em0-foreign-user",
  });
}

function episodeRecord(
  testCase: FalEm0CaseV1,
  fixture: FalEm0CaseV1["records"][number],
): Ml1EpisodeRecordV1 {
  const scope = falEm0ScopeFor(testCase, fixture.scope);
  const sourceIdentity = `${testCase.caseId}:${fixture.key}`;
  const source = Object.freeze({
    endEventId: `end-${sourceIdentity}`,
    endRawSha256: rawSha256(`end:${sourceIdentity}`),
    endSequence: 2,
    kind: "session_run_range" as const,
    rangeSha256: rawSha256(`range:${sourceIdentity}`),
    runId: `run-${sourceIdentity}`,
    sessionId: `session-${sourceIdentity}`,
    startEventId: `start-${sourceIdentity}`,
    startRawSha256: rawSha256(`start:${sourceIdentity}`),
    startSequence: 1,
  });
  return createMl1EpisodeRecordV1({
    completion: {
      evidenceSha256: null,
      mode: "model_final",
      reportSha256: null,
      steps: 1,
      toolCalls: 0,
    },
    kind: "episode",
    occurredAt: fixture.occurredAt,
    origin: "deterministic_episode",
    recordId: `episode_${sha256Canonical({ schema_version: 1, scope, source })}`,
    schemaVersion: 1,
    scope,
    source,
    taskInputSha256: rawSha256(fixture.text),
    taskPreview: fixture.text,
    text: [
      `Task: ${fixture.text}`,
      "Outcome: completed",
      "Completion mode: model_final",
      "Steps: 1",
      "Tool calls: 0",
      "Evidence: none",
    ].join("\n"),
  });
}

function explicitRecord(
  testCase: FalEm0CaseV1,
  fixture: FalEm0CaseV1["records"][number],
  input: Readonly<{
    readonly recordId?: string;
    readonly revision: number;
    readonly supersedesRevisionId: string | null;
  }>,
): ExplicitMemoryRecordV1 {
  return createExplicitMemoryRecordV1({
    commandId: `fal-em0:${testCase.caseId}:${fixture.key}`,
    kind: "decision",
    occurredAt: fixture.occurredAt,
    ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
    revision: input.revision,
    scope: falEm0ScopeFor(testCase, "current"),
    supersedesRevisionId: input.supersedesRevisionId,
    text: fixture.text,
  });
}

export async function materializeFalEm0Case(
  store: SqliteEpisodeStore,
  testCase: FalEm0CaseV1,
): Promise<FalEm0MaterializedCase> {
  const recordByKey = new Map<string, MemoryRecordV1>();
  const keyByRevisionId = new Map<string, string>();
  const fixtureByRevisionId = new Map<string, FalEm0CaseV1["records"][number]>();

  const remember = (
    fixture: FalEm0CaseV1["records"][number],
    record: MemoryRecordV1,
  ): void => {
    const revisionId = memoryRecordRevisionId(record);
    recordByKey.set(fixture.key, record);
    keyByRevisionId.set(revisionId, fixture.key);
    fixtureByRevisionId.set(revisionId, fixture);
  };

  for (const fixture of testCase.records) {
    if (fixture.lifecycle !== "episode_active") continue;
    const record = episodeRecord(testCase, fixture);
    await store.ingestEpisode(record);
    remember(fixture, record);
  }

  for (const fixture of testCase.records) {
    if (fixture.lifecycle === "explicit_active") {
      const record = explicitRecord(testCase, fixture, {
        revision: 1,
        supersedesRevisionId: null,
      });
      await store.addExplicitRecord(record);
      remember(fixture, record);
    }
    if (fixture.lifecycle === "explicit_retracted") {
      const record = explicitRecord(testCase, fixture, {
        revision: 1,
        supersedesRevisionId: null,
      });
      await store.addExplicitRecord(record);
      await store.retractRecord({
        commandId: `fal-em0-retract:${testCase.caseId}:${fixture.key}`,
        occurredAt: new Date(Date.parse(fixture.occurredAt) + 1).toISOString(),
        recordId: record.recordId,
        scope: record.scope,
      });
      remember(fixture, record);
    }
  }

  const groups = new Map<string, FalEm0CaseV1["records"][number][]>();
  for (const fixture of testCase.records) {
    if (fixture.revisionGroup === null) continue;
    groups.set(fixture.revisionGroup, [
      ...(groups.get(fixture.revisionGroup) ?? []),
      fixture,
    ]);
  }
  for (const entries of groups.values()) {
    const previousFixture = entries[0]!;
    const currentFixture = entries[1]!;
    const previous = explicitRecord(testCase, previousFixture, {
      revision: 1,
      supersedesRevisionId: null,
    });
    await store.addExplicitRecord(previous);
    remember(previousFixture, previous);
    const current = explicitRecord(testCase, currentFixture, {
      recordId: previous.recordId,
      revision: 2,
      supersedesRevisionId: previous.revisionId,
    });
    await store.supersedeExplicitRecord(current);
    remember(currentFixture, current);
  }

  return Object.freeze({
    currentScope: falEm0ScopeFor(testCase, "current"),
    fixtureByRevisionId,
    keyByRevisionId,
    recordByKey,
  });
}

function recallAt(
  orderedKeys: readonly string[],
  relevantKeys: readonly string[],
  limit: number,
): number | null {
  if (relevantKeys.length === 0) return null;
  const selected = new Set(orderedKeys.slice(0, limit));
  return relevantKeys.filter((key) => selected.has(key)).length / relevantKeys.length;
}

function reciprocalRank(
  orderedKeys: readonly string[],
  relevantKeys: readonly string[],
): number | null {
  if (relevantKeys.length === 0) return null;
  const index = orderedKeys.findIndex((key) => relevantKeys.includes(key));
  return index < 0 ? 0 : 1 / (index + 1);
}

function literalTermOverlap(
  testCase: FalEm0CaseV1,
  materialized: FalEm0MaterializedCase,
  query: string,
): boolean {
  const terms = parseMl2SearchQuery(query).terms;
  return testCase.expected.relevantRecordKeys.some((key) => {
    const record = materialized.recordByKey.get(key);
    if (record === undefined) return false;
    const normalized = record.text.normalize("NFC").toLocaleLowerCase("en-US");
    return terms.some((term) => normalized.includes(term));
  });
}

async function evaluateCase(
  testCase: FalEm0CaseV1,
  caseRoot: string,
): Promise<CaseObservation> {
  await mkdir(caseRoot, { recursive: false });
  const store = await SqliteEpisodeStore.create({ stateRoot: caseRoot });
  try {
    const materialized = await materializeFalEm0Case(store, testCase);
    const projection = await Fts5EpisodeProjection.create({
      scope: materialized.currentScope,
      stateRoot: caseRoot,
    });
    const service = new LexicalMemorySearchService({
      inspectSource: async (record) => {
        const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record));
        if (fixture === undefined) throw new Error("FAL-EM0 source fixture is missing");
        return Object.freeze({ sourceStatus: fixture.sourceStatus });
      },
      projection,
      scope: materialized.currentScope,
      store,
    });
    const query = falEm0CaseQuery(testCase, materialized);

    const started = performance.now();
    const searched = await service.search({ limit: 5, query });
    const totalSearchDurationMs = performance.now() - started;
    const orderedKeys = searched.hits.map((hit) => {
      const key = materialized.keyByRevisionId.get(memoryRecordRevisionId(hit.record));
      if (key === undefined) throw new Error("FAL-EM0 hit does not map to a fixture key");
      return key;
    });
    const relevantKeys = testCase.expected.relevantRecordKeys;
    const forbiddenTop5Count = orderedKeys.filter((key) =>
      testCase.expected.forbiddenRecordKeys.includes(key)).length;
    const requiredTop1 = relevantKeys.length === 0
      ? true
      : orderedKeys[0] !== undefined && relevantKeys.includes(orderedKeys[0]);
    const requiredTop5 = relevantKeys.length === 0
      ? true
      : relevantKeys.every((key) => orderedKeys.includes(key));
    const abstained = searched.status === "abstained";
    const abstentionCorrect = abstained === testCase.expected.expectedAbstention;
    const sourceFresh = searched.hits.every((hit) => {
      const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(hit.record));
      return fixture?.sourceStatus === "available" && hit.sourceStatus === "available";
    });
    const scopeExact = searched.hits.every((hit) =>
      sameMemoryScope(hit.record.scope, materialized.currentScope));
    const actionParameterSupported = testCase.expected.actionParameter === null
      ? null
      : searched.hits.some((hit) =>
        hit.record.text.includes(testCase.expected.actionParameter!.expected)) &&
        searched.hits.every((hit) =>
          !hit.record.text.includes(testCase.expected.actionParameter!.forbidden));
    const queryKindExact = searched.query.kind === testCase.expected.expectedQueryKind;
    const budgetBounded =
      searched.hits.length <= 5 &&
      searched.budget.textBytesUsed <= ML2_SEARCH_MAX_TEXT_BYTES &&
      searched.budget.estimatedTokensUsed <= ML2_SEARCH_MAX_ESTIMATED_TOKENS;
    const baselineRequirementPassed =
      testCase.expected.baselineRequirement === "observe_quality"
        ? true
        : testCase.expected.baselineRequirement === "must_abstain"
          ? abstentionCorrect && forbiddenTop5Count === 0
          : requiredTop5 &&
            (!testCase.expected.requireTop1 || requiredTop1) &&
            forbiddenTop5Count === 0 &&
            abstentionCorrect &&
            (actionParameterSupported ?? true);
    const passed =
      queryKindExact &&
      budgetBounded &&
      sourceFresh &&
      scopeExact &&
      baselineRequirementPassed;
    const gapExplained =
      testCase.expected.lexicalGapReason === null ||
      (
        !literalTermOverlap(testCase, materialized, query) &&
        (
          testCase.expected.lexicalGapReason !== "lexical_collision" ||
          forbiddenTop5Count > 0
        )
      );

    return Object.freeze({
      entryGateEligible: testCase.expected.entryGateEligible,
      gapExplained,
      result: Object.freeze({
        caseId: testCase.caseId,
        split: testCase.split,
        class: testCase.class,
        baseline: Object.freeze({
          queryKind: searched.query.kind,
          orderedTopRecordKeys: [...orderedKeys],
          recallAt1: recallAt(orderedKeys, relevantKeys, 1),
          recallAt5: recallAt(orderedKeys, relevantKeys, 5),
          reciprocalRank: reciprocalRank(orderedKeys, relevantKeys),
          abstained,
          abstentionReason: searched.abstentionReason,
          candidatesMatched: searched.candidates.matched,
          candidatesAvailable: searched.candidates.available,
          candidatesTruncated: searched.candidates.truncated,
          textBytesUsed: searched.budget.textBytesUsed,
          estimatedTokensUsed: searched.budget.estimatedTokensUsed,
          resultSha256: sha256Canonical(searched),
        }),
        candidate: null,
        correctness: Object.freeze({
          requiredTop1,
          requiredTop5,
          forbiddenTop5Count,
          abstentionCorrect,
          sourceFresh,
          scopeExact,
          actionParameterSupported,
        }),
        cost: Object.freeze({
          localQueryEmbeddingCalls: 0,
          localRecordEmbeddingCalls: 0,
          remoteModelCalls: 0,
          toolCalls: 0,
          networkCallsDuringSearch: 0,
          queryEmbeddingDurationMs: null,
          vectorScanDurationMs: null,
          totalSearchDurationMs,
        }),
        status: passed ? "pass" : "fail",
      }),
    });
  } finally {
    store.close();
  }
}

async function implementationIdentity(repositoryRoot: string): Promise<string> {
  const files = await Promise.all(BASELINE_IMPLEMENTATION_FILES.map(async (path) => ({
    path,
    sha256: rawSha256(await readFile(join(repositoryRoot, path))),
  })));
  return sha256Canonical({ files, schema_version: 1 });
}

function exactSourceCommit(): string | null {
  const candidate = process.env.GITHUB_SHA?.toLowerCase();
  return candidate !== undefined && /^[a-f0-9]{40,64}$/u.test(candidate)
    ? candidate
    : null;
}

export async function runFalEm0Baseline(
  options: RunFalEm0BaselineOptions,
): Promise<FalEm0BaselineRunV1> {
  const corpus = await loadFalEm0Corpus(options.repositoryRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-fal-em0-"));
  try {
    const observations: CaseObservation[] = [];
    for (const [index, testCase] of corpus.casePack.cases.entries()) {
      observations.push(await evaluateCase(
        testCase,
        join(temporaryRoot, `case-${String(index + 1).padStart(2, "0")}`),
      ));
    }
    const results = Object.freeze(observations.map((entry) => entry.result));
    const hardGateFailures = results.filter((entry) => entry.status === "fail").length;
    const entryCases = observations.filter((entry) => entry.entryGateEligible);
    if (entryCases.length !== 12) {
      throw new Error("FAL-EM0 runner did not receive 12 entry-gate cases");
    }
    const recallValues = entryCases.map((entry) => entry.result.baseline.recallAt5 ?? 0);
    const reciprocalRanks = entryCases.map((entry) =>
      entry.result.baseline.reciprocalRank ?? 0);
    const semanticRecallAt5 = recallValues.reduce((total, value) => total + value, 0) /
      entryCases.length;
    const semanticMrrAt5 = reciprocalRanks.reduce((total, value) => total + value, 0) /
      entryCases.length;
    const misses = entryCases.filter((entry) =>
      (entry.result.baseline.recallAt5 ?? 0) < 1);
    const gapExplained = misses.every((entry) => entry.gapExplained);
    const recallGap = semanticRecallAt5 < 0.75;
    const countGap = misses.length >= 5;
    const candidatePermitted =
      hardGateFailures === 0 &&
      (recallGap || countGap) &&
      gapExplained;
    const entryGateReasons: Array<
      FalEm0ReceiptV1["baseline"]["entryGateReasons"][number]
    > = [];
    if (hardGateFailures > 0) entryGateReasons.push("hard_gate_failure");
    if (recallGap) entryGateReasons.push("semantic_recall_below_75_percent");
    if (countGap) entryGateReasons.push("at_least_five_semantic_top5_misses");
    if (gapExplained && misses.length > 0) {
      entryGateReasons.push("misses_have_no_literal_term_overlap");
    }
    if (!recallGap && !countGap) entryGateReasons.push("semantic_gap_not_observed");
    if (!gapExplained) entryGateReasons.push("unexplained_baseline_miss");
    const securityLeaks = results.filter((entry) =>
      entry.class === "security" &&
      (
        !entry.correctness.scopeExact ||
        !entry.correctness.sourceFresh ||
        entry.correctness.forbiddenTop5Count > 0
      )).length;
    const receipt = createFalEm0Receipt({
      schemaVersion: 1,
      experimentId: corpus.manifest.experimentId,
      sourceCommit: exactSourceCommit(),
      manifestSha256: corpus.manifest.manifestSha256,
      baseline: {
        retrieverId: ML2_RETRIEVER_ID,
        retrieverVersion: ML2_RETRIEVER_VERSION,
        implementationSha256: await implementationIdentity(options.repositoryRoot),
        semanticRecallAt5,
        semanticMrrAt5,
        candidatePermitted,
        entryGateReasons,
      },
      candidate: null,
      cases: results,
      aggregate: {
        calibrationCases: 8,
        evaluationCases: 28,
        hardGateFailures,
        securityLeaks,
        vectorAddedForbiddenHits: 0,
        fallbackMismatches: 0,
      },
      cost: {
        modelArtifactBytes: null,
        dependencyInstallDeltaBytes: null,
        packedArtifactDeltaBytes: null,
        vectorStoreBytesAt10000: null,
        coldLoadP95Ms: null,
        warmQueryEmbeddingP95Ms: null,
        vectorScan10000P95Ms: null,
        hybridSearchP95Ms: null,
      },
      platformEvidence: {
        windows: process.platform === "win32"
          ? hardGateFailures === 0 && securityLeaks === 0 ? "passed" : "failed"
          : "not_run",
        linux: process.platform === "linux"
          ? hardGateFailures === 0 && securityLeaks === 0 ? "passed" : "failed"
          : "not_run",
        packed: "not_run",
      },
      outcome: hardGateFailures > 0 || securityLeaks > 0
        ? "rejected"
        : candidatePermitted
          ? "inconclusive"
          : "baseline_sufficient",
      actualFocusedMinutes: options.actualFocusedMinutes ?? 0,
    });
    return Object.freeze({ candidatePermitted, receipt });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
