import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PatchPlan } from "../changes/patch-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
  type Phase16RunBinding,
} from "../events/phase16-run-event-extension.js";
import {
  reconstructArtifactSessionLedger,
  type ArtifactStoredReferenceFact,
} from "../artifacts/artifact-session-ledger.js";
import {
  goalChangeRecordedDataSchema,
  goalExecutionBaselineCapturedDataSchema,
  type GoalChangeRecordedData,
  type GoalExecutionBaselineCapturedData,
} from "./goal-change-event-schema.js";

export const MAX_GOAL_CHANGE_RECORDS = 512;
export const MAX_GOAL_CHANGE_PATHS = 256;
export const MAX_GOAL_CHANGE_SOURCE_RUNS = 256;

export type GoalChangeLedgerErrorCode =
  | "goal_change_artifact_mismatch"
  | "goal_change_baseline_invalid"
  | "goal_change_binding_mismatch"
  | "goal_change_budget_exceeded"
  | "goal_change_chain_mismatch"
  | "goal_change_duplicate_source"
  | "goal_change_event_mismatch"
  | "goal_change_ledger_hash_mismatch"
  | "goal_change_record_invalid";

export class GoalChangeLedgerError extends Error {
  override readonly name = "GoalChangeLedgerError";

  constructor(
    readonly code: GoalChangeLedgerErrorCode,
    message: string,
    readonly sessionSeq?: number,
  ) {
    super(
      sessionSeq === undefined ? message : `${message} at session_seq ${sessionSeq}`,
    );
  }
}

export interface GoalExecutionBaselineProjection {
  readonly data: GoalExecutionBaselineCapturedData;
  readonly eventId: string;
  readonly runId: string;
  readonly sessionSeq: number;
}

export interface GoalChangeRecordProjection {
  readonly data: GoalChangeRecordedData;
  readonly eventId: string;
  readonly runId: string;
  readonly sessionSeq: number;
  readonly sourceRunId: string;
  readonly timestamp: string;
}

export interface GoalChangeLedgerProjection {
  readonly baseline: GoalExecutionBaselineProjection;
  readonly baselineEventId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly ledgerSha256: string;
  readonly netChangedPaths: readonly string[];
  readonly records: readonly GoalChangeRecordProjection[];
  readonly sourceRunIds: readonly string[];
}

export interface GoalChangeLedgerCandidate {
  readonly baseline: Omit<GoalExecutionBaselineProjection, "sessionSeq"> & {
    readonly sessionSeq?: number;
  };
  readonly goalId: string;
  readonly goalRevision: number;
  readonly records: readonly GoalChangeRecordProjection[];
}

function fail(
  code: GoalChangeLedgerErrorCode,
  message: string,
  event?: Pick<DecodedStoredEvent, "sessionSeq">,
): never {
  throw new GoalChangeLedgerError(code, message, event?.sessionSeq);
}

function recordSourceRunId(data: GoalChangeRecordedData): string {
  return data.source.kind === "patch_completed"
    ? data.source.run_id
    : data.source.source_run_id;
}

function canonicalLedgerPayload(input: GoalChangeLedgerCandidate): unknown {
  return {
    baseline: {
      data: input.baseline.data,
      event_id: input.baseline.eventId,
      run_id: input.baseline.runId,
    },
    goal_id: input.goalId,
    goal_revision: input.goalRevision,
    records: input.records.map((record) => ({
      data: record.data,
      event_id: record.eventId,
      run_id: record.runId,
    })),
    schema_version: 1,
  };
}

export function goalChangeLedgerSha256(
  input: GoalChangeLedgerCandidate,
): string {
  return sha256Canonical(canonicalLedgerPayload(input));
}

function pickRunBinding(data: unknown): Phase16RunBinding | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const source = data as Readonly<Record<string, unknown>>;
  const candidate: Record<string, unknown> = {};
  for (const key of PHASE16_RUN_BINDING_KEYS) {
    if (Object.hasOwn(source, key)) candidate[key] = source[key];
  }
  if (Object.keys(candidate).length === 0) return null;
  const parsed = phase16RunBindingSchema.safeParse(candidate);
  if (!parsed.success) {
    fail("goal_change_binding_mismatch", "Phase 16 run binding is invalid");
  }
  return parsed.data;
}

function buildRunBindings(
  events: readonly DecodedStoredEvent[],
): ReadonlyMap<string, Phase16RunBinding> {
  const result = new Map<string, Phase16RunBinding>();
  for (const event of events) {
    if (event.scope !== "run" || event.type !== "run.started") continue;
    const binding = pickRunBinding(event.data);
    if (binding !== null) result.set(event.runId, binding);
  }
  return result;
}

function requireBuildBinding(
  bindings: ReadonlyMap<string, Phase16RunBinding>,
  runId: string,
  goalId: string,
  goalRevision: number,
  event: DecodedStoredEvent,
): Phase16RunBinding {
  const binding = bindings.get(runId);
  if (
    binding === undefined ||
    binding.agent_mode !== "build" ||
    binding.goal_id !== goalId ||
    binding.goal_revision !== goalRevision
  ) {
    fail(
      "goal_change_binding_mismatch",
      "Goal change fact does not match an exact Phase 16 Build binding",
      event,
    );
  }
  return binding;
}

function exactArtifact(
  artifacts: ReadonlyMap<string, ArtifactStoredReferenceFact>,
  image: GoalChangeRecordedData["files"][number]["postimage"],
  patchPlanEventId: string,
  sourceRunId: string,
  event: DecodedStoredEvent,
): ArtifactStoredReferenceFact {
  const fact = artifacts.get(image.event_id);
  if (
    fact === undefined ||
    fact.authorityState !== "authorized" ||
    fact.captureStatus !== "complete" ||
    fact.captureTruncated ||
    fact.mediaType !== "text/plain; charset=utf-8" ||
    fact.originEventId !== patchPlanEventId ||
    fact.runId !== sourceRunId ||
    fact.artifactId !== image.artifact_id ||
    fact.bytes !== image.bytes ||
    fact.objectRef !== image.object_ref ||
    fact.sha256 !== image.sha256 ||
    fact.sessionSeq >= event.sessionSeq
  ) {
    fail(
      "goal_change_artifact_mismatch",
      "Goal change image does not match one complete authorized text artifact",
      event,
    );
  }
  return fact;
}

function exactFiles(
  left: readonly {
    readonly kind: string;
    readonly path: string;
    readonly post_sha256?: string | undefined;
    readonly pre_sha256: string | null;
  }[],
  record: GoalChangeRecordedData,
): boolean {
  return (
    left.length === record.files.length &&
    left.every((file, index) => {
      const target = record.files[index];
      return (
        target !== undefined &&
        target.kind === file.kind &&
        target.path === file.path &&
        file.post_sha256 !== undefined &&
        target.postimage.sha256 === file.post_sha256 &&
        (target.preimage?.sha256 ?? null) === file.pre_sha256
      );
    })
  );
}

function validateBaselinePosition(
  baselineEvent: DecodedStoredEvent & { readonly scope: "run" },
  events: readonly DecodedStoredEvent[],
): void {
  const prior = events.filter(
    (event) =>
      event.scope === "run" &&
      event.runId === baselineEvent.runId &&
      event.sessionSeq < baselineEvent.sessionSeq,
  );
  const backend = prior.filter((event) => event.type === "backend.selected");
  const providerOrEffectBoundary = prior.find((event) =>
    [
      "agent.step.started",
      "command.execution.requested",
      "command.started",
      "completion.candidate",
      "model.request.encoded",
      "patch.apply.completed",
      "patch.apply.started",
      "patch.plan.created",
      "tool.call.requested",
      "verification.started",
    ].includes(event.type),
  );
  if (backend.length !== 1 || providerOrEffectBoundary !== undefined) {
    fail(
      "goal_change_baseline_invalid",
      "Goal execution baseline must follow backend selection and precede provider/tool/effect activity",
      baselineEvent,
    );
  }
}

function validateRecordAuthority(input: {
  readonly artifacts: ReadonlyMap<string, ArtifactStoredReferenceFact>;
  readonly bindings: ReadonlyMap<string, Phase16RunBinding>;
  readonly event: DecodedStoredEvent & { readonly scope: "run" };
  readonly eventsById: ReadonlyMap<string, DecodedStoredEvent>;
  readonly record: GoalChangeRecordedData;
}): string {
  const { artifacts, bindings, event, eventsById, record } = input;
  const sourceRunId = recordSourceRunId(record);
  requireBuildBinding(
    bindings,
    event.runId,
    record.goal_id,
    record.goal_revision,
    event,
  );
  requireBuildBinding(
    bindings,
    sourceRunId,
    record.goal_id,
    record.goal_revision,
    event,
  );

  const plan = eventsById.get(record.patch_plan_event_id);
  if (
    plan === undefined ||
    plan.scope !== "run" ||
    plan.type !== "patch.plan.created" ||
    plan.runId !== sourceRunId ||
    plan.sessionSeq >= event.sessionSeq ||
    plan.data.call_id !== record.call_id ||
    plan.data.paths.length !== record.files.length ||
    !plan.data.paths.every((path, index) => {
      const file = record.files[index];
      return file !== undefined && file.kind === path.kind && file.path === path.path;
    })
  ) {
    fail(
      "goal_change_event_mismatch",
      "Goal change record does not match its trusted patch plan",
      event,
    );
  }

  const artifactFacts = record.files.flatMap((file) => [
    ...(file.preimage === null
      ? []
      : [
          exactArtifact(
            artifacts,
            file.preimage,
            record.patch_plan_event_id,
            sourceRunId,
            event,
          ),
        ]),
    exactArtifact(
      artifacts,
      file.postimage,
      record.patch_plan_event_id,
      sourceRunId,
      event,
    ),
  ]);

  const started = [...eventsById.values()].find(
    (candidate) =>
      candidate.scope === "run" &&
      candidate.runId === sourceRunId &&
      candidate.type === "patch.apply.started" &&
      candidate.data.plan_id === plan.data.plan_id &&
      candidate.data.call_id === record.call_id,
  );
  if (
    started === undefined ||
    started.scope !== "run" ||
    started.type !== "patch.apply.started" ||
    started.sessionSeq >= event.sessionSeq ||
    !exactFiles(started.data.files, record) ||
    artifactFacts.some((fact) => fact.sessionSeq >= started.sessionSeq)
  ) {
    fail(
      "goal_change_event_mismatch",
      "Goal change record does not match a patch boundary after its artifacts",
      event,
    );
  }

  const source = eventsById.get(record.source.event_id);
  if (record.source.kind === "patch_completed") {
    if (
      source === undefined ||
      source.scope !== "run" ||
      source.type !== "patch.apply.completed" ||
      source.runId !== sourceRunId ||
      source.sessionSeq <= started.sessionSeq ||
      source.sessionSeq >= event.sessionSeq ||
      source.data.call_id !== record.call_id ||
      source.data.plan_id !== plan.data.plan_id ||
      !exactFiles(source.data.files, record)
    ) {
      fail(
        "goal_change_event_mismatch",
        "Goal change source does not match the completed patch effect",
        event,
      );
    }
  } else if (
    source === undefined ||
    source.scope !== "session" ||
    source.type !== "side_effect.reconciled" ||
    source.sessionSeq >= event.sessionSeq ||
    source.data.effect_kind !== "patch" ||
    source.data.effect_id !== plan.data.plan_id ||
    source.data.observed !== "applied" ||
    source.data.source_run_id !== sourceRunId
  ) {
    fail(
      "goal_change_event_mismatch",
      "Goal change source does not match an applied patch reconciliation",
      event,
    );
  }
  return sourceRunId;
}

function projectionFromParts(input: GoalChangeLedgerCandidate): GoalChangeLedgerProjection {
  const latest = new Map<
    string,
    { readonly firstKind: "create" | "modify"; readonly firstPre: string | null; latestPost: string }
  >();
  const sourceRunIds: string[] = [];
  const seenRuns = new Set<string>();
  for (const record of input.records) {
    if (!seenRuns.has(record.sourceRunId)) {
      seenRuns.add(record.sourceRunId);
      sourceRunIds.push(record.sourceRunId);
    }
    for (const file of record.data.files) {
      const previous = latest.get(file.path);
      if (previous === undefined) {
        latest.set(file.path, {
          firstKind: file.kind,
          firstPre: file.preimage?.sha256 ?? null,
          latestPost: file.postimage.sha256,
        });
      } else {
        previous.latestPost = file.postimage.sha256;
      }
    }
  }
  const netChangedPaths = [...latest.entries()]
    .filter(([, value]) => value.firstKind === "create" || value.firstPre !== value.latestPost)
    .map(([path]) => path)
    .sort((left, right) => left.localeCompare(right));
  const baseline: GoalExecutionBaselineProjection = Object.freeze({
    data: input.baseline.data,
    eventId: input.baseline.eventId,
    runId: input.baseline.runId,
    sessionSeq: input.baseline.sessionSeq ?? 0,
  });
  return Object.freeze({
    baseline,
    baselineEventId: baseline.eventId,
    goalId: input.goalId,
    goalRevision: input.goalRevision,
    ledgerSha256: goalChangeLedgerSha256(input),
    netChangedPaths: Object.freeze(netChangedPaths),
    records: Object.freeze([...input.records]),
    sourceRunIds: Object.freeze(sourceRunIds),
  });
}

function validateRunStartHashes(
  events: readonly DecodedStoredEvent[],
  bindings: ReadonlyMap<string, Phase16RunBinding>,
  projections: readonly GoalChangeLedgerProjection[],
): void {
  const projectionByGoal = new Map(
    projections.map((projection) => [
      `${projection.goalId}:${projection.goalRevision}`,
      projection,
    ]),
  );
  for (const start of events) {
    if (start.scope !== "run" || start.type !== "run.started") continue;
    const binding = bindings.get(start.runId);
    if (binding?.agent_mode !== "build") continue;
    const projection = projectionByGoal.get(
      `${binding.goal_id}:${binding.goal_revision}`,
    );
    if (projection === undefined) {
      const laterActivity = events.find(
        (event) =>
          event.scope === "run" &&
          event.runId === start.runId &&
          event.sessionSeq > start.sessionSeq &&
          event.type !== "backend.selected",
      );
      if (laterActivity !== undefined) {
        fail(
          "goal_change_baseline_invalid",
          "Phase 16 Build activity requires a durable Goal execution baseline",
          laterActivity,
        );
      }
      continue;
    }
    const baselineInThisRun = projection.baseline.runId === start.runId;
    const priorRecords = projection.records.filter(
      (record) => record.sessionSeq < start.sessionSeq,
    );
    const expected = goalChangeLedgerSha256({
      baseline: projection.baseline,
      goalId: projection.goalId,
      goalRevision: projection.goalRevision,
      records: priorRecords,
    });
    if (
      (!baselineInThisRun && projection.baseline.sessionSeq > start.sessionSeq) ||
      binding.goal_change_ledger_sha256 !== expected
    ) {
      fail(
        "goal_change_ledger_hash_mismatch",
        "Build run binding does not match the exact pre-run Goal change ledger",
        start,
      );
    }
  }
}

export function projectGoalChangeLedgers(
  events: readonly DecodedStoredEvent[],
): readonly GoalChangeLedgerProjection[] {
  const goalEvents = events.filter(
    (event) =>
      event.type === "goal.execution.baseline.captured" ||
      event.type === "goal.change.recorded",
  );
  if (goalEvents.length === 0) return Object.freeze([]);
  const sessionId = events[0]?.sessionId;
  if (sessionId === undefined) return Object.freeze([]);
  const bindings = buildRunBindings(events);
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const artifactLedger = reconstructArtifactSessionLedger(events, sessionId);
  const artifacts = new Map(
    artifactLedger.storedReferences.map((reference) => [reference.eventId, reference]),
  );
  const baselines = new Map<string, GoalExecutionBaselineProjection>();
  const records = new Map<string, GoalChangeRecordProjection[]>();
  const sourceKeys = new Set<string>();
  const latestPostimages = new Map<string, string>();
  const uniquePaths = new Map<string, Set<string>>();
  const sourceRuns = new Map<string, Set<string>>();

  for (const event of goalEvents) {
    if (event.scope !== "run") {
      fail("goal_change_event_mismatch", "Goal change facts must be run-scoped", event);
    }
    if (event.type === "goal.execution.baseline.captured") {
      const data = goalExecutionBaselineCapturedDataSchema.parse(event.data);
      const key = `${data.goal_id}:${data.goal_revision}`;
      if (baselines.has(key)) {
        fail(
          "goal_change_baseline_invalid",
          "a Goal revision can have only one execution baseline",
          event,
        );
      }
      requireBuildBinding(
        bindings,
        event.runId,
        data.goal_id,
        data.goal_revision,
        event,
      );
      validateBaselinePosition(event, events);
      baselines.set(
        key,
        Object.freeze({
          data,
          eventId: event.eventId,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
        }),
      );
      continue;
    }

    const data = goalChangeRecordedDataSchema.parse(event.data);
    const key = `${data.goal_id}:${data.goal_revision}`;
    const baseline = baselines.get(key);
    if (baseline === undefined || baseline.sessionSeq >= event.sessionSeq) {
      fail(
        "goal_change_baseline_invalid",
        "Goal change record requires an earlier exact execution baseline",
        event,
      );
    }
    const sourceRunId = validateRecordAuthority({
      artifacts,
      bindings,
      event,
      eventsById,
      record: data,
    });
    const sourceKey = `${data.source.kind}:${data.source.event_id}`;
    if (sourceKeys.has(sourceKey)) {
      fail(
        "goal_change_duplicate_source",
        "one patch effect cannot commit more than one Goal change record",
        event,
      );
    }
    sourceKeys.add(sourceKey);
    const goalRecords = records.get(key) ?? [];
    if (goalRecords.length >= MAX_GOAL_CHANGE_RECORDS) {
      fail("goal_change_budget_exceeded", "Goal change record budget exceeded", event);
    }
    const paths = uniquePaths.get(key) ?? new Set<string>();
    const runs = sourceRuns.get(key) ?? new Set<string>();
    runs.add(sourceRunId);
    if (runs.size > MAX_GOAL_CHANGE_SOURCE_RUNS) {
      fail("goal_change_budget_exceeded", "Goal change source-run budget exceeded", event);
    }
    for (const file of data.files) {
      const chainKey = `${key}:${file.path}`;
      const expectedPreimage = latestPostimages.get(chainKey);
      if (
        expectedPreimage !== undefined &&
        file.preimage?.sha256 !== expectedPreimage
      ) {
        fail(
          "goal_change_chain_mismatch",
          `Goal change image chain is broken for ${file.path}`,
          event,
        );
      }
      latestPostimages.set(chainKey, file.postimage.sha256);
      paths.add(file.path);
    }
    if (paths.size > MAX_GOAL_CHANGE_PATHS) {
      fail("goal_change_budget_exceeded", "Goal change path budget exceeded", event);
    }
    goalRecords.push(
      Object.freeze({
        data,
        eventId: event.eventId,
        runId: event.runId,
        sessionSeq: event.sessionSeq,
        sourceRunId,
        timestamp: event.timestamp,
      }),
    );
    records.set(key, goalRecords);
    uniquePaths.set(key, paths);
    sourceRuns.set(key, runs);
  }

  const projections = [...baselines.entries()].map(([key, baseline]) => {
    const separator = key.lastIndexOf(":");
    const goalId = key.slice(0, separator);
    const goalRevision = Number(key.slice(separator + 1));
    return projectionFromParts({
      baseline,
      goalId,
      goalRevision,
      records: records.get(key) ?? [],
    });
  });
  validateRunStartHashes(events, bindings, projections);
  return Object.freeze(projections);
}

export function projectGoalChangeLedger(
  events: readonly DecodedStoredEvent[],
  goalId: string,
  goalRevision: number,
): GoalChangeLedgerProjection | null {
  return (
    projectGoalChangeLedgers(events).find(
      (projection) =>
        projection.goalId === goalId && projection.goalRevision === goalRevision,
    ) ?? null
  );
}

export function assertGoalChangeLedgerSemantics(
  events: readonly DecodedStoredEvent[],
): void {
  projectGoalChangeLedgers(events);
}

export function assertGoalChangePlanPreflight(
  projection: GoalChangeLedgerProjection,
  plan: PatchPlan,
  sourceRunId: string,
): void {
  if (projection.records.length >= MAX_GOAL_CHANGE_RECORDS) {
    throw new GoalChangeLedgerError(
      "goal_change_budget_exceeded",
      "Goal change record budget would be exceeded",
    );
  }
  const paths = new Set(projection.records.flatMap((record) => record.data.files.map((file) => file.path)));
  const runs = new Set(projection.sourceRunIds);
  runs.add(sourceRunId);
  for (const file of plan.files) paths.add(file.relativePath);
  if (paths.size > MAX_GOAL_CHANGE_PATHS || runs.size > MAX_GOAL_CHANGE_SOURCE_RUNS) {
    throw new GoalChangeLedgerError(
      "goal_change_budget_exceeded",
      "Goal change path or source-run budget would be exceeded",
    );
  }
  const latest = new Map<string, string>();
  for (const record of projection.records) {
    for (const file of record.data.files) latest.set(file.path, file.postimage.sha256);
  }
  for (const file of plan.files) {
    const expected = latest.get(file.relativePath);
    if (expected !== undefined && expected !== file.preimageSha256) {
      throw new GoalChangeLedgerError(
        "goal_change_chain_mismatch",
        `workspace preimage no longer matches the Goal change chain for ${file.relativePath}`,
      );
    }
  }
}

export async function assertGoalChangeWorkspaceMatches(
  projection: GoalChangeLedgerProjection,
  workspace: string,
): Promise<void> {
  const latest = new Map<string, string>();
  for (const record of projection.records) {
    for (const file of record.data.files) latest.set(file.path, file.postimage.sha256);
  }
  for (const [path, expected] of latest) {
    try {
      const bytes = await readFile(resolve(workspace, ...path.split("/")));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) {
        throw new Error("postimage hash mismatch");
      }
    } catch {
      throw new GoalChangeLedgerError(
        "goal_change_chain_mismatch",
        `workspace no longer matches the latest Goal-attributed postimage for ${path}`,
      );
    }
  }
}
