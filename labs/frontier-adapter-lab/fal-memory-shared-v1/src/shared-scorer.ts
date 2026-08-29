import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

import {
  loadSharedScoringSplit,
  type BenchmarkSplit,
  type SharedGoldenPack,
} from "./benchmark-schema.js";
import {
  retrievalObservationPackSchema,
  type RetrievalObservationPack,
} from "./observation-schema.js";
import { sharedMemoryProtocol } from "./protocol.js";

type GoldenTimeline = SharedGoldenPack["timelines"][number];
type GoldenProbe = GoldenTimeline["probes"][number];
type ObservationTimeline = RetrievalObservationPack["timelines"][number];
type ObservationProbe = ObservationTimeline["probes"][number];
type ThresholdBehavior = ObservationProbe["thresholdBehaviors"][number];

interface RankedProbe {
  readonly golden: GoldenProbe;
  readonly top5: readonly string[];
  readonly top10: readonly string[];
}

interface ThresholdScore {
  readonly thresholdSimilarityMicros: number;
  readonly eligible: boolean;
  readonly macroSupportRecallAt5Micros: number;
  readonly macroSupportRecallAt5DeltaMicros: number;
  readonly macroAllSupportFoundAt10Micros: number;
  readonly macroAllSupportFoundAt10DeltaMicros: number;
  readonly answerableTop5EmptyCases: number;
  readonly mustAbstainTop5NonemptyCases: number;
  readonly candidateAddedMustAbstainTop5Cases: number;
  readonly forbiddenTop5Cases: number;
  readonly forbiddenTop5Hits: number;
  readonly candidateAddedForbiddenTop5Cases: number;
  readonly candidateAddedForbiddenTop5Hits: number;
  readonly coverageMicros: number;
  readonly selectiveRiskMicros: number;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, entry) => sum + entry, 0) / values.length;
}

function toMicros(value: number): number {
  return Math.round(value * 1_000_000);
}

function recordKey(value: string): string | null {
  return value.startsWith("record:") ? value.slice("record:".length) : null;
}

function requiredRecordGroups(golden: GoldenProbe): readonly (readonly string[])[] {
  return Object.freeze(golden.requiredEvidenceGroups
    .map((group) => Object.freeze(group
      .map(recordKey)
      .filter((entry): entry is string => entry !== null)))
    .filter((group) => group.length > 0));
}

function recordKeys(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

function supportRecall(golden: GoldenProbe, ranked: readonly string[]): number | null {
  const groups = requiredRecordGroups(golden);
  if (groups.length === 0) return null;
  const selected = recordKeys(ranked);
  return groups.filter((group) => group.some((entry) => selected.has(entry))).length /
    groups.length;
}

function allSupportFound(golden: GoldenProbe, ranked: readonly string[]): number | null {
  const groups = requiredRecordGroups(golden);
  if (groups.length === 0) return null;
  const selected = recordKeys(ranked);
  return groups.every((group) => group.some((entry) => selected.has(entry))) ? 1 : 0;
}

function forbiddenKeys(golden: GoldenProbe): ReadonlySet<string> {
  return new Set(golden.forbiddenEvidenceRefs
    .map(recordKey)
    .filter((entry): entry is string => entry !== null));
}

function forbiddenSelected(golden: GoldenProbe, ranked: readonly string[]): readonly string[] {
  const forbidden = forbiddenKeys(golden);
  return Object.freeze(ranked.filter((entry) => forbidden.has(entry)));
}

function behaviorAtThreshold(
  probe: ObservationProbe,
  thresholdSimilarityMicros: number,
): ThresholdBehavior {
  const behavior = probe.thresholdBehaviors
    .filter((entry) => entry.thresholdSimilarityMicros >= thresholdSimilarityMicros)
    .at(-1) ?? probe.thresholdBehaviors.at(-1);
  if (behavior === undefined) throw new Error(`probe ${probe.probeId} has no threshold behavior`);
  return behavior;
}

function pairedTimelines(
  observation: RetrievalObservationPack,
  goldens: SharedGoldenPack,
): readonly Readonly<{
  readonly golden: GoldenTimeline;
  readonly observation: ObservationTimeline;
}>[] {
  if (observation.split !== goldens.split) throw new Error("observation/golden split mismatch");
  if (observation.timelines.length !== goldens.timelines.length) {
    throw new Error("observation/golden timeline count mismatch");
  }
  return Object.freeze(observation.timelines.map((timeline, index) => {
    const golden = goldens.timelines[index];
    if (golden === undefined || golden.timelineId !== timeline.timelineId) {
      throw new Error("observation/golden timeline order mismatch");
    }
    if (timeline.probes.some((probe, probeIndex) =>
      golden.probes[probeIndex]?.probeId !== probe.probeId)) {
      throw new Error(`${timeline.timelineId} observation/golden probe order mismatch`);
    }
    return Object.freeze({ golden, observation: timeline });
  }));
}

function macroRetrieval(
  timelines: readonly Readonly<{
    readonly golden: GoldenTimeline;
    readonly probes: readonly RankedProbe[];
  }>[],
): Readonly<{
  readonly allSupportFoundAt10Micros: number;
  readonly supportRecallAt5Micros: number;
}> {
  const timelineRecall = timelines.map((timeline) => mean(timeline.probes
    .map((probe) => supportRecall(probe.golden, probe.top5))
    .filter((entry): entry is number => entry !== null)));
  const timelineAllSupport = timelines.map((timeline) => mean(timeline.probes
    .map((probe) => allSupportFound(probe.golden, probe.top10))
    .filter((entry): entry is number => entry !== null)));
  return Object.freeze({
    allSupportFoundAt10Micros: toMicros(mean(timelineAllSupport)),
    supportRecallAt5Micros: toMicros(mean(timelineRecall)),
  });
}

function baselineRanked(
  timelines: ReturnType<typeof pairedTimelines>,
): readonly Readonly<{ readonly golden: GoldenTimeline; readonly probes: readonly RankedProbe[] }>[] {
  return Object.freeze(timelines.map(({ golden, observation }) => Object.freeze({
    golden,
    probes: Object.freeze(observation.probes.map((probe, index) => Object.freeze({
      golden: golden.probes[index]!,
      top5: probe.baselineTop5RecordKeys,
      top10: probe.baselineTop10RecordKeys,
    }))),
  })));
}

function thresholdRanked(
  timelines: ReturnType<typeof pairedTimelines>,
  thresholdSimilarityMicros: number,
): readonly Readonly<{ readonly golden: GoldenTimeline; readonly probes: readonly RankedProbe[] }>[] {
  return Object.freeze(timelines.map(({ golden, observation }) => Object.freeze({
    golden,
    probes: Object.freeze(observation.probes.map((probe, index) => {
      const behavior = behaviorAtThreshold(probe, thresholdSimilarityMicros);
      return Object.freeze({
        golden: golden.probes[index]!,
        top5: behavior.orderedTop5RecordKeys,
        top10: behavior.orderedTop10RecordKeys,
      });
    })),
  })));
}

function flattened(
  ranked: readonly Readonly<{ readonly probes: readonly RankedProbe[] }>[],
): readonly RankedProbe[] {
  return Object.freeze(ranked.flatMap((timeline) => timeline.probes));
}

function absoluteCounts(ranked: readonly RankedProbe[]): Readonly<{
  readonly answerableTop5EmptyCases: number;
  readonly forbiddenTop5Cases: number;
  readonly forbiddenTop5Hits: number;
  readonly mustAbstainTop5NonemptyCases: number;
}> {
  const answerable = ranked.filter((entry) => entry.golden.judgment === "must_answer");
  const abstain = ranked.filter((entry) => entry.golden.judgment === "must_abstain");
  const forbidden = ranked.map((entry) => forbiddenSelected(entry.golden, entry.top5));
  return Object.freeze({
    answerableTop5EmptyCases: answerable.filter((entry) => entry.top5.length === 0).length,
    forbiddenTop5Cases: forbidden.filter((entry) => entry.length > 0).length,
    forbiddenTop5Hits: forbidden.reduce((sum, entry) => sum + entry.length, 0),
    mustAbstainTop5NonemptyCases: abstain.filter((entry) => entry.top5.length > 0).length,
  });
}

function candidateAddedCounts(
  baseline: readonly RankedProbe[],
  candidate: readonly RankedProbe[],
): Readonly<{
  readonly forbiddenCases: number;
  readonly forbiddenHits: number;
  readonly mustAbstainCases: number;
}> {
  let forbiddenCases = 0;
  let forbiddenHits = 0;
  let mustAbstainCases = 0;
  for (const [index, entry] of candidate.entries()) {
    const baselineEntry = baseline[index];
    if (baselineEntry === undefined || baselineEntry.golden.probeId !== entry.golden.probeId) {
      throw new Error("baseline/candidate probe order mismatch");
    }
    if (
      entry.golden.judgment === "must_abstain" &&
      baselineEntry.top5.length === 0 &&
      entry.top5.length > 0
    ) mustAbstainCases += 1;
    const baselineForbidden = new Set(forbiddenSelected(entry.golden, baselineEntry.top5));
    const added = forbiddenSelected(entry.golden, entry.top5)
      .filter((recordId) => !baselineForbidden.has(recordId));
    if (added.length > 0) forbiddenCases += 1;
    forbiddenHits += added.length;
  }
  return Object.freeze({ forbiddenCases, forbiddenHits, mustAbstainCases });
}

function selectiveMetrics(ranked: readonly RankedProbe[]): Readonly<{
  readonly coverageMicros: number;
  readonly riskMicros: number;
}> {
  const admitted = ranked.filter((entry) => entry.top5.length > 0);
  const failures = admitted.filter((entry) => {
    if (entry.golden.judgment === "must_abstain") return true;
    return allSupportFound(entry.golden, entry.top5) !== 1;
  }).length;
  return Object.freeze({
    coverageMicros: toMicros(admitted.length / ranked.length),
    riskMicros: admitted.length === 0 ? 0 : toMicros(failures / admitted.length),
  });
}

function aurcMicros(points: readonly ThresholdScore[]): number {
  const byCoverage = new Map<number, number>();
  for (const point of points) {
    const prior = byCoverage.get(point.coverageMicros);
    if (prior === undefined || point.selectiveRiskMicros < prior) {
      byCoverage.set(point.coverageMicros, point.selectiveRiskMicros);
    }
  }
  const ordered = [
    { coverageMicros: 0, riskMicros: 0 },
    ...[...byCoverage.entries()]
      .sort(([left], [right]) => left - right)
      .map(([coverageMicros, riskMicros]) => ({ coverageMicros, riskMicros })),
  ];
  let area = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1]!;
    const right = ordered[index]!;
    area += ((right.coverageMicros - left.coverageMicros) / 1_000_000) *
      ((left.riskMicros + right.riskMicros) / 2);
  }
  return Math.round(area);
}

function projectionSecurityFailures(
  timelines: ReturnType<typeof pairedTimelines>,
): Readonly<{
  readonly count: number;
  readonly leakedRecordKeys: readonly string[];
}> {
  const leaked = new Set<string>();
  let explicitFailures = 0;
  for (const { golden, observation } of timelines) {
    explicitFailures += observation.projection.inputSecurityFailures;
    explicitFailures += observation.projection.rowSecurityFailures;
    const ineligible = new Set(golden.probes
      .filter((probe) => probe.probeType === "filtered_scope_or_lifecycle" ||
        probe.probeType === "knowledge_update")
      .flatMap((probe) => probe.forbiddenEvidenceRefs)
      .map(recordKey)
      .filter((entry): entry is string => entry !== null));
    for (const key of observation.projection.eligibleVectorRecordKeys) {
      if (ineligible.has(key)) leaked.add(key);
    }
  }
  return Object.freeze({
    count: explicitFailures + leaked.size,
    leakedRecordKeys: Object.freeze([...leaked].sort()),
  });
}

function selectEligible(points: readonly ThresholdScore[]): ThresholdScore | null {
  return [...points].filter((entry) => entry.eligible).sort((left, right) =>
    right.macroSupportRecallAt5Micros - left.macroSupportRecallAt5Micros ||
    right.macroAllSupportFoundAt10Micros - left.macroAllSupportFoundAt10Micros ||
    right.thresholdSimilarityMicros - left.thresholdSimilarityMicros)[0] ?? null;
}

function selectDiagnostic(points: readonly ThresholdScore[]): ThresholdScore {
  const selected = [...points].sort((left, right) =>
    left.candidateAddedMustAbstainTop5Cases - right.candidateAddedMustAbstainTop5Cases ||
    left.candidateAddedForbiddenTop5Cases - right.candidateAddedForbiddenTop5Cases ||
    right.macroSupportRecallAt5Micros - left.macroSupportRecallAt5Micros ||
    right.macroAllSupportFoundAt10Micros - left.macroAllSupportFoundAt10Micros ||
    right.thresholdSimilarityMicros - left.thresholdSimilarityMicros)[0];
  if (selected === undefined) throw new Error("shared scorer found no diagnostic point");
  return selected;
}

export async function scoreSharedRetrieval(input: Readonly<{
  readonly observationInput: unknown;
  readonly repositoryRoot: string;
  readonly scoredAt: string;
  readonly split: BenchmarkSplit;
}>): Promise<Readonly<Record<string, unknown>>> {
  const observation = retrievalObservationPackSchema.parse(input.observationInput);
  if (observation.split !== input.split) throw new Error("requested scoring split mismatch");
  const goldens = await loadSharedScoringSplit(input.repositoryRoot, input.split);
  const timelines = pairedTimelines(observation, goldens);
  const baseline = baselineRanked(timelines);
  const baselineFlat = flattened(baseline);
  const baselineMacro = macroRetrieval(baseline);
  const baselineAbsolute = absoluteCounts(baselineFlat);
  const projection = projectionSecurityFailures(timelines);
  const thresholds = Object.freeze([...new Set(observation.timelines
    .flatMap((timeline) => timeline.probes)
    .flatMap((probe) => probe.thresholdBehaviors)
    .map((behavior) => behavior.thresholdSimilarityMicros))]
    .sort((left, right) => right - left));
  const contract = sharedMemoryProtocol.operatingPointContract;
  const points: ThresholdScore[] = thresholds.map((thresholdSimilarityMicros) => {
    const candidate = thresholdRanked(timelines, thresholdSimilarityMicros);
    const candidateFlat = flattened(candidate);
    const macro = macroRetrieval(candidate);
    const absolute = absoluteCounts(candidateFlat);
    const added = candidateAddedCounts(baselineFlat, candidateFlat);
    const selective = selectiveMetrics(candidateFlat);
    const supportDelta = macro.supportRecallAt5Micros - baselineMacro.supportRecallAt5Micros;
    const allSupportDelta = macro.allSupportFoundAt10Micros -
      baselineMacro.allSupportFoundAt10Micros;
    const eligible = supportDelta >= contract.minimumMacroSupportRecallAt5DeltaMicros &&
      allSupportDelta >= contract.minimumMacroAllSupportFoundAt10DeltaMicros &&
      added.mustAbstainCases <= contract.maximumCandidateAddedMustAbstainTop5Cases &&
      added.forbiddenCases <= contract.maximumCandidateAddedForbiddenTop5Cases &&
      projection.count <= contract.maximumProjectionSecurityFailures;
    return Object.freeze({
      thresholdSimilarityMicros,
      eligible,
      macroSupportRecallAt5Micros: macro.supportRecallAt5Micros,
      macroSupportRecallAt5DeltaMicros: supportDelta,
      macroAllSupportFoundAt10Micros: macro.allSupportFoundAt10Micros,
      macroAllSupportFoundAt10DeltaMicros: allSupportDelta,
      answerableTop5EmptyCases: absolute.answerableTop5EmptyCases,
      mustAbstainTop5NonemptyCases: absolute.mustAbstainTop5NonemptyCases,
      candidateAddedMustAbstainTop5Cases: added.mustAbstainCases,
      forbiddenTop5Cases: absolute.forbiddenTop5Cases,
      forbiddenTop5Hits: absolute.forbiddenTop5Hits,
      candidateAddedForbiddenTop5Cases: added.forbiddenCases,
      candidateAddedForbiddenTop5Hits: added.forbiddenHits,
      coverageMicros: selective.coverageMicros,
      selectiveRiskMicros: selective.riskMicros,
    });
  });
  const selected = selectEligible(points);
  const diagnostic = selectDiagnostic(points);
  const folding = observation.timelines.map((timeline) => timeline.folding);
  const selectedFolds = folding.filter((entry) => entry.selected);
  const baselineContextTokens = folding.reduce((sum, entry) => sum + entry.baselineTokens, 0);
  const selectedContextTokens = folding.reduce((sum, entry) =>
    sum + (entry.selected ? entry.candidateTokens! : entry.baselineTokens), 0);
  const content = Object.freeze({
    schemaVersion: 1,
    benchmarkId: observation.benchmarkId,
    split: observation.split,
    scoredAt: input.scoredAt,
    scoringBoundary: "retrieval_observations_plus_goldens_no_candidate_execution",
    observationSha256: observation.observationSha256,
    baseline: Object.freeze({
      macroSupportRecallAt5Micros: baselineMacro.supportRecallAt5Micros,
      macroAllSupportFoundAt10Micros: baselineMacro.allSupportFoundAt10Micros,
      ...baselineAbsolute,
    }),
    projectionSecurity: projection,
    thresholdDomainCount: points.length,
    thresholds: Object.freeze(points),
    retrievalAurcMicros: aurcMicros(points),
    selection: Object.freeze({
      eligiblePointCount: points.filter((entry) => entry.eligible).length,
      selectedOperatingPoint: selected,
      diagnosticPoint: diagnostic,
      state: selected === null
        ? "retrieval_refuted_evaluation_blocked_reader_diagnostic_allowed"
        : "retrieval_eligible_pending_reader_gate",
      evaluationAllowed: false,
    }),
    folding: Object.freeze({
      timelineCount: folding.length,
      selectedTimelineCount: selectedFolds.length,
      losslessTimelineCount: folding.filter((entry) => entry.losslessExpansion).length,
      baselineContextTokens,
      selectedContextTokens,
      tokenReductionMicros: baselineContextTokens === 0
        ? 0
        : toMicros((baselineContextTokens - selectedContextTokens) / baselineContextTokens),
      baselineContextBytes: folding.reduce((sum, entry) => sum + entry.baselineBytes, 0),
      selectedContextBytes: folding.reduce((sum, entry) =>
        sum + (entry.selected ? entry.candidateBytes! : entry.baselineBytes), 0),
      reasonCounts: Object.freeze(Object.fromEntries([...new Set(folding.map((entry) => entry.reason))]
        .sort()
        .map((reason) => [reason, folding.filter((entry) => entry.reason === reason).length]))),
      modelCalls: 0,
      toolCalls: 0,
      networkCalls: 0,
    }),
  });
  return Object.freeze({ ...content, scoreSha256: sha256Canonical(content) });
}
