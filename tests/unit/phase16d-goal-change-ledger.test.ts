import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  goalChangeLedgerSha256,
  projectGoalChangeLedger,
  type GoalChangeLedgerError,
} from "../../src/coordination/goal-change-ledger.js";
import {
  createGoalChangeRecordedData,
  createGoalExecutionBaselineData,
} from "../../src/coordination/goal-change-event-schema.js";
import {
  GOAL,
  Phase16EventBuilder,
  RUN,
  backendSelectedData,
  chatStartData,
  eventIdOf,
  uuid,
} from "./phase16a-test-fixtures.js";

const QUALIFICATION = "e".repeat(64);
const PLAN_ID = "7".repeat(64);
const PATCH_SHA = "8".repeat(64);
const PRE = Buffer.from("old\n", "utf8");
const POST = Buffer.from("new\n", "utf8");
const PRE_SHA = createHash("sha256").update(PRE).digest("hex");
const POST_SHA = createHash("sha256").update(POST).digest("hex");

function artifactData(
  sha256: string,
  bytes: number,
  originEventId: string,
) {
  return {
    artifact_id: `sha256:${sha256}`,
    bytes,
    capture_status: "complete" as const,
    capture_truncated: false,
    media_type: "text/plain; charset=utf-8" as const,
    object_ref: `artifacts/00000000-0000-4000-8000-000000016001/objects/${sha256}`,
    origin_event_id: originEventId,
    sha256,
  };
}

function buildLedgerFixture() {
  const builder = new Phase16EventBuilder();
  const baseline = createGoalExecutionBaselineData({
    git_head_sha256: "1".repeat(64),
    git_index_sha256: "2".repeat(64),
    goal_id: GOAL,
    goal_revision: 1,
    pre_existing_dirty_paths: ["user-note.txt"],
    source_state_sha256: "3".repeat(64),
  });
  const baselineEventId = uuid(17_003);
  const ledgerHash = goalChangeLedgerSha256({
    baseline: { data: baseline, eventId: baselineEventId, runId: RUN },
    goalId: GOAL,
    goalRevision: 1,
    records: [],
  });
  builder.run(
    "run.started",
    chatStartData({
      agent_mode: "build",
      agent_mode_source: "explicit_cli",
      goal_change_ledger_sha256: ledgerHash,
      goal_id: GOAL,
      goal_revision: 1,
      model_qualification_sha256: QUALIFICATION,
      plan_id: null,
      plan_revision: null,
      plan_sha256: null,
    }),
  );
  builder.run("backend.selected", backendSelectedData());
  const baselineEvent = builder.run(
    "goal.execution.baseline.captured",
    baseline,
  );
  const patchPlan = builder.run("patch.plan.created", {
    added_lines: 1,
    call_id: "call-1",
    patch_sha256: PATCH_SHA,
    paths: [{ kind: "modify", path: "src/a.ts" }],
    plan_id: PLAN_ID,
    preview: "preview",
    removed_lines: 1,
    step: 1,
    truncated: false,
  });
  const preArtifact = builder.run(
    "artifact.stored",
    artifactData(PRE_SHA, PRE.byteLength, eventIdOf(patchPlan)),
  );
  const postArtifact = builder.run(
    "artifact.stored",
    artifactData(POST_SHA, POST.byteLength, eventIdOf(patchPlan)),
  );
  builder.run("patch.apply.started", {
    approval_request_id: uuid(16_700),
    call_id: "call-1",
    files: [
      {
        kind: "modify",
        path: "src/a.ts",
        post_sha256: POST_SHA,
        pre_sha256: PRE_SHA,
      },
    ],
    plan_id: PLAN_ID,
    step: 1,
  });
  const completed = builder.run("patch.apply.completed", {
    added_lines: 1,
    approval_request_id: uuid(16_700),
    call_id: "call-1",
    duration_ms: 1,
    files: [
      {
        kind: "modify",
        path: "src/a.ts",
        post_sha256: POST_SHA,
        pre_sha256: PRE_SHA,
      },
    ],
    journal_sha256: "9".repeat(64),
    plan_id: PLAN_ID,
    removed_lines: 1,
    step: 1,
  });
  const record = createGoalChangeRecordedData({
    call_id: "call-1",
    files: [
      {
        kind: "modify",
        path: "src/a.ts",
        postimage: {
          artifact_id: `sha256:${POST_SHA}`,
          bytes: POST.byteLength,
          event_id: eventIdOf(postArtifact),
          object_ref: artifactData(POST_SHA, POST.byteLength, eventIdOf(patchPlan)).object_ref,
          sha256: POST_SHA,
        },
        preimage: {
          artifact_id: `sha256:${PRE_SHA}`,
          bytes: PRE.byteLength,
          event_id: eventIdOf(preArtifact),
          object_ref: artifactData(PRE_SHA, PRE.byteLength, eventIdOf(patchPlan)).object_ref,
          sha256: PRE_SHA,
        },
      },
    ],
    goal_id: GOAL,
    goal_revision: 1,
    patch_plan_event_id: eventIdOf(patchPlan),
    source: {
      event_id: eventIdOf(completed),
      kind: "patch_completed",
      run_id: RUN,
    },
  });
  const change = builder.run("goal.change.recorded", record);
  return { baselineEvent, builder, change, record };
}

describe("Phase 16D GoalChangeLedger", () => {
  it("projects one artifact-backed change with an exact baseline and live hash", () => {
    const fixture = buildLedgerFixture();
    const projection = projectGoalChangeLedger(
      fixture.builder.decode(),
      GOAL,
      1,
    );

    expect(projection).toMatchObject({
      baselineEventId: eventIdOf(fixture.baselineEvent),
      goalId: GOAL,
      goalRevision: 1,
      netChangedPaths: ["src/a.ts"],
      sourceRunIds: [RUN],
    });
    expect(projection?.records.map((record) => record.eventId)).toEqual([
      eventIdOf(fixture.change),
    ]);
    expect(projection?.ledgerSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a second record that claims the same completed patch effect", () => {
    const fixture = buildLedgerFixture();
    fixture.builder.run("goal.change.recorded", fixture.record);

    expect(() => fixture.builder.decode()).not.toThrow();
    expect(() =>
      projectGoalChangeLedger(fixture.builder.decode(), GOAL, 1),
    ).toThrowError(
      expect.objectContaining<Partial<GoalChangeLedgerError>>({
        code: "goal_change_duplicate_source",
      }),
    );
  });

  it("rejects a record whose artifact event identity is swapped", () => {
    const fixture = buildLedgerFixture();
    const changed = structuredClone(fixture.record);
    changed.files[0]!.postimage.event_id = changed.files[0]!.preimage!.event_id;
    const repaired = createGoalChangeRecordedData({
      call_id: changed.call_id,
      files: changed.files,
      goal_id: changed.goal_id,
      goal_revision: changed.goal_revision,
      patch_plan_event_id: changed.patch_plan_event_id,
      source: changed.source,
    });
    const raw = fixture.builder.values.at(-1)!;
    raw.data = repaired;

    expect(() =>
      projectGoalChangeLedger(fixture.builder.decode(), GOAL, 1),
    ).toThrowError(
      expect.objectContaining<Partial<GoalChangeLedgerError>>({
        code: "goal_change_artifact_mismatch",
      }),
    );
  });
});
