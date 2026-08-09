import { ArtifactSessionRuntime } from "../artifacts/artifact-session-runtime.js";
import {
  reconstructArtifactSessionLedger,
  type ArtifactStoredReferenceFact,
} from "../artifacts/artifact-session-ledger.js";
import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
  type Phase16RunBinding,
} from "../events/phase16-run-event-extension.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import {
  createGoalChangeRecordedData,
  type GoalChangeRecordedData,
} from "./goal-change-event-schema.js";
import {
  assertGoalChangeWorkspaceMatches,
  projectGoalChangeLedger,
} from "./goal-change-ledger.js";

export type GoalChangeRecordRecoveryCode =
  | "goal_change_recovery_artifact_invalid"
  | "goal_change_recovery_binding_invalid"
  | "goal_change_recovery_source_invalid";

export class GoalChangeRecordRecoveryError extends Error {
  override readonly name = "GoalChangeRecordRecoveryError";

  constructor(
    readonly code: GoalChangeRecordRecoveryCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GoalChangeRecordRecoveryResult {
  readonly eventIds: readonly string[];
  readonly recovered: number;
  readonly sourceEventIds: readonly string[];
}

export interface GoalChangeRecordReconcilerOptions {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly randomUUID: () => string;
  readonly workspace: string;
  readonly writer: V2SessionWriter;
}

interface RecoverySource {
  readonly callId: string;
  readonly files: readonly {
    readonly kind: "create" | "modify";
    readonly path: string;
    readonly postSha256: string;
    readonly preSha256: string | null;
  }[];
  readonly patchPlanEventId: string;
  readonly planId: string;
  readonly source: GoalChangeRecordedData["source"];
  readonly sourceEventId: string;
  readonly sourceRunId: string;
  readonly sourceSessionSeq: number;
  readonly startedSessionSeq: number;
}

function fail(
  code: GoalChangeRecordRecoveryCode,
  message: string,
): never {
  throw new GoalChangeRecordRecoveryError(code, message);
}

function runBinding(event: DecodedRunEvent | undefined): Phase16RunBinding | null {
  if (event?.type !== "run.started") return null;
  const candidate = Object.fromEntries(
    PHASE16_RUN_BINDING_KEYS.flatMap((key) =>
      Object.hasOwn(event.data, key) ? [[key, event.data[key]]] : [],
    ),
  );
  if (Object.keys(candidate).length === 0) return null;
  const parsed = phase16RunBindingSchema.safeParse(candidate);
  if (!parsed.success) {
    fail(
      "goal_change_recovery_binding_invalid",
      "patch source run has an invalid Phase 16 binding",
    );
  }
  return parsed.data;
}

function exactPlanAndStart(input: {
  readonly callId: string;
  readonly events: readonly DecodedStoredEvent[];
  readonly files: RecoverySource["files"];
  readonly planId: string;
  readonly sourceRunId: string;
}): {
  readonly patchPlanEventId: string;
  readonly startedSessionSeq: number;
} {
  const plan = input.events.find(
    (event) =>
      event.scope === "run" &&
      event.runId === input.sourceRunId &&
      event.type === "patch.plan.created" &&
      event.data.plan_id === input.planId &&
      event.data.call_id === input.callId,
  );
  const started = input.events.find(
    (event) =>
      event.scope === "run" &&
      event.runId === input.sourceRunId &&
      event.type === "patch.apply.started" &&
      event.data.plan_id === input.planId &&
      event.data.call_id === input.callId,
  );
  if (
    plan?.type !== "patch.plan.created" ||
    started?.type !== "patch.apply.started" ||
    plan.sessionSeq >= started.sessionSeq ||
    plan.data.paths.length !== input.files.length ||
    !plan.data.paths.every((path, index) => {
      const file = input.files[index];
      return file?.kind === path.kind && file.path === path.path;
    }) ||
    started.data.files.length !== input.files.length ||
    !started.data.files.every((file, index) => {
      const expected = input.files[index];
      return (
        expected !== undefined &&
        file.kind === expected.kind &&
        file.path === expected.path &&
        file.pre_sha256 === expected.preSha256 &&
        file.post_sha256 === expected.postSha256
      );
    })
  ) {
    fail(
      "goal_change_recovery_source_invalid",
      "recoverable patch does not match one exact plan and started boundary",
    );
  }
  return {
    patchPlanEventId: plan.eventId,
    startedSessionSeq: started.sessionSeq,
  };
}

function collectSources(
  events: readonly DecodedStoredEvent[],
  goalId: string,
  goalRevision: number,
): readonly RecoverySource[] {
  const starts = new Map(
    events.flatMap((event) =>
      event.scope === "run" && event.type === "run.started"
        ? [[event.runId, event] as const]
        : [],
    ),
  );
  const recordedSources = new Set(
    events.flatMap((event) =>
      event.scope === "run" && event.type === "goal.change.recorded"
        ? [event.data.source.event_id]
        : [],
    ),
  );
  const sources: RecoverySource[] = [];
  const seenPatchEffects = new Set<string>();

  for (const event of events) {
    if (
      event.scope !== "run" ||
      event.type !== "patch.apply.completed" ||
      recordedSources.has(event.eventId)
    ) {
      continue;
    }
    const binding = runBinding(starts.get(event.runId)!);
    if (
      binding?.agent_mode !== "build" ||
      binding.goal_id !== goalId ||
      binding.goal_revision !== goalRevision
    ) {
      continue;
    }
    const files = event.data.files.map((file) => ({
      kind: file.kind,
      path: file.path,
      postSha256: file.post_sha256,
      preSha256: file.pre_sha256,
    }));
    const exact = exactPlanAndStart({
      callId: event.data.call_id,
      events,
      files,
      planId: event.data.plan_id,
      sourceRunId: event.runId,
    });
    sources.push({
      callId: event.data.call_id,
      files,
      patchPlanEventId: exact.patchPlanEventId,
      planId: event.data.plan_id,
      source: {
        event_id: event.eventId,
        kind: "patch_completed",
        run_id: event.runId,
      },
      sourceEventId: event.eventId,
      sourceRunId: event.runId,
      sourceSessionSeq: event.sessionSeq,
      startedSessionSeq: exact.startedSessionSeq,
    });
    seenPatchEffects.add(`${event.runId}\0${event.data.plan_id}`);
  }

  for (const event of events) {
    if (
      event.scope !== "session" ||
      event.type !== "side_effect.reconciled" ||
      event.data.effect_kind !== "patch" ||
      event.data.observed !== "applied" ||
      recordedSources.has(event.eventId) ||
      seenPatchEffects.has(`${event.data.source_run_id}\0${event.data.effect_id}`)
    ) {
      continue;
    }
    const started = events.find(
      (candidate) =>
        candidate.scope === "run" &&
        candidate.runId === event.data.source_run_id &&
        candidate.type === "patch.apply.started" &&
        candidate.data.plan_id === event.data.effect_id,
    );
    if (started?.type !== "patch.apply.started") {
      fail(
        "goal_change_recovery_source_invalid",
        "applied patch reconciliation has no exact started boundary",
      );
    }
    const binding = runBinding(starts.get(event.data.source_run_id)!);
    if (
      binding?.agent_mode !== "build" ||
      binding.goal_id !== goalId ||
      binding.goal_revision !== goalRevision
    ) {
      continue;
    }
    const files = started.data.files.map((file) => {
      if (file.post_sha256 === undefined) {
        fail(
          "goal_change_recovery_source_invalid",
          "applied patch reconciliation is missing its predicted postimage",
        );
      }
      return {
        kind: file.kind,
        path: file.path,
        postSha256: file.post_sha256,
        preSha256: file.pre_sha256,
      };
    });
    const exact = exactPlanAndStart({
      callId: started.data.call_id,
      events,
      files,
      planId: started.data.plan_id,
      sourceRunId: event.data.source_run_id,
    });
    sources.push({
      callId: started.data.call_id,
      files,
      patchPlanEventId: exact.patchPlanEventId,
      planId: started.data.plan_id,
      source: {
        event_id: event.eventId,
        kind: "reconciled_patch",
        source_run_id: event.data.source_run_id,
      },
      sourceEventId: event.eventId,
      sourceRunId: event.data.source_run_id,
      sourceSessionSeq: event.sessionSeq,
      startedSessionSeq: exact.startedSessionSeq,
    });
  }
  return Object.freeze(
    sources.sort(
      (left, right) => left.sourceSessionSeq - right.sourceSessionSeq,
    ),
  );
}

function imageRef(reference: ArtifactStoredReferenceFact) {
  return {
    artifact_id: reference.artifactId,
    bytes: reference.bytes,
    event_id: reference.eventId,
    object_ref: reference.objectRef,
    sha256: reference.sha256,
  };
}

function capturedFiles(
  source: RecoverySource,
  references: readonly ArtifactStoredReferenceFact[],
): GoalChangeRecordedData["files"] {
  const captured = references
    .filter(
      (reference) =>
        reference.runId === source.sourceRunId &&
        reference.originEventId === source.patchPlanEventId &&
        reference.sessionSeq < source.startedSessionSeq &&
        reference.authorityState === "authorized" &&
        reference.captureStatus === "complete" &&
        !reference.captureTruncated &&
        reference.mediaType === "text/plain; charset=utf-8",
    )
    .sort((left, right) => left.sessionSeq - right.sessionSeq);
  let cursor = 0;
  const take = (sha256: string): ArtifactStoredReferenceFact => {
    const reference = captured[cursor];
    if (reference?.sha256 !== sha256) {
      fail(
        "goal_change_recovery_artifact_invalid",
        "captured Goal image order or hash does not match its patch boundary",
      );
    }
    cursor += 1;
    return reference;
  };
  const files: GoalChangeRecordedData["files"][number][] = [];
  for (const file of source.files) {
    const preimage =
      file.kind === "create" ? null : imageRef(take(file.preSha256!));
    const postimage = imageRef(take(file.postSha256));
    files.push({
      kind: file.kind,
      path: file.path,
      postimage,
      preimage,
    });
  }
  if (cursor !== captured.length) {
    fail(
      "goal_change_recovery_artifact_invalid",
      "patch plan has unbound Goal image artifacts",
    );
  }
  return files;
}

export class GoalChangeRecordReconciler {
  constructor(private readonly options: GoalChangeRecordReconcilerOptions) {}

  async reconcile(): Promise<GoalChangeRecordRecoveryResult> {
    const events = this.options.writer.events;
    const sources = collectSources(
      events,
      this.options.goalId,
      this.options.goalRevision,
    );
    if (sources.length === 0) {
      return {
        eventIds: Object.freeze([]),
        recovered: 0,
        sourceEventIds: Object.freeze([]),
      };
    }
    const artifactLedger = reconstructArtifactSessionLedger(
      events,
      events[0]!.sessionId,
    );
    const runtime = await ArtifactSessionRuntime.create({
      events,
      eventAppender: {
        appendArtifactEvent: async () => {
          throw new Error("Goal change record recovery is read-only for artifacts");
        },
      },
      runId: sources[0]!.sourceRunId,
      sessionId: events[0]!.sessionId,
      workspace: this.options.workspace,
    });
    const eventIds: string[] = [];
    for (const source of sources) {
      const files = capturedFiles(source, artifactLedger.storedReferences);
      for (const file of files) {
        for (const image of [file.preimage, file.postimage]) {
          if (image === null) continue;
          const verified = await runtime.store.readVerified(image.artifact_id);
          if (
            verified.metadata.bytes !== image.bytes ||
            verified.metadata.sha256 !== image.sha256 ||
            verified.objectRef !== image.object_ref
          ) {
            fail(
              "goal_change_recovery_artifact_invalid",
              `Goal change recovery artifact is corrupt for ${file.path}`,
            );
          }
        }
      }
      const data = createGoalChangeRecordedData({
        call_id: source.callId,
        files,
        goal_id: this.options.goalId,
        goal_revision: this.options.goalRevision,
        patch_plan_event_id: source.patchPlanEventId,
        source: source.source,
      });
      const eventId = this.options.randomUUID();
      await this.options.writer.appendGoalChangeEvent(
        source.sourceRunId,
        eventId,
        "goal.change.recorded",
        data,
      );
      eventIds.push(eventId);
    }
    const projection = projectGoalChangeLedger(
      this.options.writer.events,
      this.options.goalId,
      this.options.goalRevision,
    );
    if (projection === null) {
      fail(
        "goal_change_recovery_source_invalid",
        "recovered Goal change records have no execution baseline",
      );
    }
    await assertGoalChangeWorkspaceMatches(projection, this.options.workspace);
    return {
      eventIds: Object.freeze(eventIds),
      recovered: eventIds.length,
      sourceEventIds: Object.freeze(sources.map((source) => source.sourceEventId)),
    };
  }
}
