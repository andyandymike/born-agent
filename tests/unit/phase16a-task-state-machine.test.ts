import { describe, expect, it } from "vitest";

import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import type { TaskStateProjectionError } from "../../src/coordination/task-state-error.js";
import type { PlanRevisionContent } from "../../src/plans/plan-schema.js";
import {
  GOAL,
  GOAL_2,
  PLAN,
  PLAN_2,
  RUN,
  SESSION,
  Phase16EventBuilder,
  acceptedCompletionData,
  agentOrigin,
  backendSelectedData,
  chatStartData,
  eventIdOf,
  hostOrigin,
  planContent,
  planIdentity,
  toolCompletedData,
  toolRequestData,
  userOrigin,
  uuid,
} from "./phase16a-test-fixtures.js";

function appendGoal(builder: Phase16EventBuilder, objective = "Implement 16A") {
  return builder.session("goal.created", {
    goal_id: GOAL,
    objective,
    origin: userOrigin,
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
}

function appendPlan(
  builder: Phase16EventBuilder,
  content: PlanRevisionContent = planContent(),
) {
  const sha256 = planIdentity(content).sha256;
  builder.session("plan.proposed", {
    content,
    origin: userOrigin,
    plan_sha256: sha256,
  });
  builder.session("plan.approved", {
    goal_id: content.goalId,
    goal_revision: content.goalRevision,
    origin: userOrigin,
    plan_id: content.planId,
    plan_sha256: sha256,
    revision: content.revision,
  });
  return sha256;
}

function startRun(builder: Phase16EventBuilder): void {
  builder.run("run.started", chatStartData());
  builder.run("backend.selected", backendSelectedData());
}

function appendProgress(
  builder: Phase16EventBuilder,
  input: {
    readonly evidence?: readonly string[];
    readonly from: string;
    readonly itemId?: string;
    readonly note?: string;
    readonly planSha256: string;
    readonly to: string;
  },
): void {
  const callId = `update-${builder.values.length + 1}`;
  builder.run("tool.call.requested", toolRequestData(callId, "update_plan"));
  builder.session("plan.item.status_changed", {
    evidence_event_ids: input.evidence ?? [],
    from: input.from,
    goal_id: GOAL,
    goal_revision: 1,
    item_id: input.itemId ?? "implement",
    note: input.note ?? "",
    origin: agentOrigin(callId),
    plan_id: PLAN,
    plan_sha256: input.planSha256,
    revision: 1,
    to: input.to,
  });
  builder.run(
    "tool.call.completed",
    toolCompletedData(callId, "update_plan"),
  );
}

function expectTaskError(
  operation: () => unknown,
  code: TaskStateProjectionError["code"],
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("Phase 16A TaskStateMachine", () => {
  it("projects propose -> approve -> progress -> ready -> Plan/Goal completion", () => {
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    const planSha256 = appendPlan(builder);
    startRun(builder);
    const readRequest = builder.run(
      "tool.call.requested",
      toolRequestData("read-1", "read_file"),
    );
    const readCompleted = builder.run(
      "tool.call.completed",
      toolCompletedData("read-1", "read_file"),
    );
    expect(eventIdOf(readRequest)).not.toBe(eventIdOf(readCompleted));
    appendProgress(builder, {
      from: "pending",
      planSha256,
      to: "in_progress",
    });
    appendProgress(builder, {
      evidence: [eventIdOf(readCompleted)],
      from: "in_progress",
      note: "Implementation verified by the read result.",
      planSha256,
      to: "completed",
    });
    const completion = builder.run(
      "completion.evaluated",
      acceptedCompletionData("finish-1"),
    );
    builder.session("plan.completed", {
      completion_evaluated_event_id: eventIdOf(completion),
      finish_task_call_id: "finish-1",
      goal_id: GOAL,
      goal_revision: 1,
      origin: hostOrigin,
      plan_id: PLAN,
      plan_sha256: planSha256,
      revision: 1,
    });

    const beforeGoalTerminal = TaskStateMachine.project(builder.decode());
    expect(beforeGoalTerminal).toMatchObject({
      activeGoalId: GOAL,
      currentApprovedPlan: { planId: PLAN, revision: 1 },
      readyForCompletion: true,
      trackingMode: "phase16",
    });
    expect(beforeGoalTerminal.plans[0]).toMatchObject({
      itemStatuses: { implement: "completed" },
      status: "completed",
      statusTransitions: [
        { from: "draft", to: "active" },
        { from: "active", to: "completed" },
      ],
    });
    expect(Object.isFrozen(beforeGoalTerminal)).toBe(true);
    expect(Object.isFrozen(beforeGoalTerminal.plans[0]?.items)).toBe(true);

    builder.session("goal.status.changed", {
      completion_evaluated_event_id: eventIdOf(completion),
      finish_task_call_id: "finish-1",
      from: "active",
      goal_id: GOAL,
      origin: hostOrigin,
      revision: 1,
      to: "completed",
    });
    const terminal = TaskStateMachine.project(builder.decode());
    expect(terminal).toMatchObject({
      activeGoalId: null,
      currentApprovedPlan: null,
      readyForCompletion: false,
    });
    expect(terminal.goals[0]?.status).toBe("completed");
    expect(terminal.plans[0]?.status).toBe("completed");
  });

  it("handles exact composite Goal replacement and rejects stale/invalid parent lineage", () => {
    const valid = new Phase16EventBuilder();
    appendGoal(valid, "First Goal");
    valid.session("goal.created", {
      goal_id: GOAL_2,
      objective: "Replacement Goal",
      origin: userOrigin,
      parent_goal_id: GOAL,
      replaces_active_goal: {
        disposition: "abandoned",
        goal_id: GOAL,
        revision: 1,
      },
      revision: 1,
    });
    expect(TaskStateMachine.project(valid.decode())).toMatchObject({
      activeGoalId: GOAL_2,
      goals: [{ status: "abandoned" }, { status: "active" }],
    });

    const stale = new Phase16EventBuilder();
    appendGoal(stale);
    stale.session("goal.created", {
      goal_id: GOAL_2,
      objective: "Replacement Goal",
      origin: userOrigin,
      parent_goal_id: GOAL,
      replaces_active_goal: {
        disposition: "abandoned",
        goal_id: GOAL,
        revision: 2,
      },
      revision: 1,
    });
    expectTaskError(
      () => TaskStateMachine.project(stale.decode()),
      "active_goal_conflict",
    );

    const futureParent = new Phase16EventBuilder();
    futureParent.session("goal.created", {
      goal_id: GOAL,
      objective: "Invalid lineage",
      origin: userOrigin,
      parent_goal_id: GOAL_2,
      replaces_active_goal: null,
      revision: 1,
    });
    expectTaskError(
      () => TaskStateMachine.project(futureParent.decode()),
      "goal_binding_mismatch",
    );

    const terminalRevision = new Phase16EventBuilder();
    appendGoal(terminalRevision);
    terminalRevision.session("goal.status.changed", {
      from: "active",
      goal_id: GOAL,
      origin: userOrigin,
      reason: "stop this Goal",
      revision: 1,
      to: "abandoned",
    });
    terminalRevision.session("goal.revised", {
      base_revision: 1,
      goal_id: GOAL,
      objective: "illegal reopen",
      origin: userOrigin,
      revision: 2,
    });
    expectTaskError(
      () => TaskStateMachine.project(terminalRevision.decode()),
      "goal_terminal_mutation",
    );
  });

  it("invalidates old Goal-revision Plans and permits a new Plan id at revision 1", () => {
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    appendPlan(builder);
    builder.session("goal.revised", {
      base_revision: 1,
      goal_id: GOAL,
      objective: "Implement 16A with replay",
      origin: userOrigin,
      revision: 2,
    });
    const next = planContent({
      goalRevision: 2,
      planId: PLAN_2,
      revision: 1,
      title: "Replanned Phase 16A",
    });
    builder.session("plan.proposed", {
      content: next,
      origin: userOrigin,
      plan_sha256: planIdentity(next).sha256,
    });

    const state = TaskStateMachine.project(builder.decode());
    expect(state.goals[0]?.content.revision).toBe(2);
    expect(state.plans.map((plan) => plan.status)).toEqual([
      "superseded",
      "draft",
    ]);
    expect(state.currentApprovedPlan).toBeNull();
    expect(state.pendingDraft).toMatchObject({ planId: PLAN_2, revision: 1 });
  });

  it("requires an earlier open update_plan request for every AgentOrigin mutation", () => {
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    startRun(builder);
    const content = planContent();
    builder.session("plan.proposed", {
      content,
      origin: agentOrigin("missing-request"),
      plan_sha256: planIdentity(content).sha256,
    });
    expectTaskError(
      () => TaskStateMachine.project(builder.decode()),
      "origin_invalid",
    );
  });

  it("fails closed on Plan hash mismatch and stale approval identity", () => {
    const badHash = new Phase16EventBuilder();
    appendGoal(badHash);
    badHash.session("plan.proposed", {
      content: planContent(),
      origin: userOrigin,
      plan_sha256: "f".repeat(64),
    });
    expectTaskError(
      () => TaskStateMachine.project(badHash.decode()),
      "plan_hash_mismatch",
    );

    const staleApproval = new Phase16EventBuilder();
    appendGoal(staleApproval);
    const sha256 = planIdentity().sha256;
    staleApproval.session("plan.proposed", {
      content: planContent(),
      origin: userOrigin,
      plan_sha256: sha256,
    });
    staleApproval.session("plan.approved", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: PLAN,
      plan_sha256: "e".repeat(64),
      revision: 1,
    });
    expectTaskError(
      () => TaskStateMachine.project(staleApproval.decode()),
      "plan_decision_stale",
    );
  });

  it("inherits only byte-identical completed/skipped items into an approved revision", () => {
    const first = planContent({
      items: [
        planContent().items[0]!,
        {
          acceptance: "Documented",
          id: "docs",
          required: false,
          title: "Document the kernel",
        },
      ],
    });
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    const firstHash = appendPlan(builder, first);
    startRun(builder);
    appendProgress(builder, {
      from: "pending",
      itemId: "docs",
      planSha256: firstHash,
      to: "in_progress",
    });
    appendProgress(builder, {
      from: "in_progress",
      itemId: "docs",
      note: "Not needed for this revision.",
      planSha256: firstHash,
      to: "skipped",
    });

    const second = planContent({
      items: [
        { ...first.items[0]!, acceptance: "Changed acceptance" },
        first.items[1]!,
      ],
      revision: 2,
    });
    const secondHash = planIdentity(second).sha256;
    builder.session("plan.revised", {
      base_revision: 1,
      base_sha256: firstHash,
      content: second,
      origin: userOrigin,
      plan_sha256: secondHash,
    });
    builder.session("plan.approved", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: PLAN,
      plan_sha256: secondHash,
      revision: 2,
    });

    const state = TaskStateMachine.project(builder.decode());
    expect(state.plans[0]?.status).toBe("superseded");
    expect(state.plans[1]?.items).toMatchObject([
      { carriedFromRevision: null, status: "pending" },
      { carriedFromRevision: 1, status: "skipped" },
    ]);
  });

  it("enforces transition, one-in-progress, required-skip, and evidence rules", () => {
    const directComplete = new Phase16EventBuilder();
    appendGoal(directComplete);
    const hash = appendPlan(directComplete);
    startRun(directComplete);
    appendProgress(directComplete, {
      evidence: [uuid(16_777)],
      from: "pending",
      note: "invalid direct completion",
      planSha256: hash,
      to: "completed",
    });
    expectTaskError(
      () => TaskStateMachine.project(directComplete.decode()),
      "plan_item_transition_invalid",
    );

    const requiredSkip = new Phase16EventBuilder();
    appendGoal(requiredSkip);
    const requiredHash = appendPlan(requiredSkip);
    startRun(requiredSkip);
    appendProgress(requiredSkip, {
      from: "pending",
      note: "skip",
      planSha256: requiredHash,
      to: "skipped",
    });
    expectTaskError(
      () => TaskStateMachine.project(requiredSkip.decode()),
      "plan_required_item_skipped",
    );

    const multiple = new Phase16EventBuilder();
    appendGoal(multiple);
    const multipleContent = planContent({
      items: [
        planContent().items[0]!,
        {
          acceptance: "Second item is done",
          id: "second",
          required: true,
          title: "Second item",
        },
      ],
    });
    const multipleHash = appendPlan(multiple, multipleContent);
    startRun(multiple);
    appendProgress(multiple, {
      from: "pending",
      planSha256: multipleHash,
      to: "in_progress",
    });
    appendProgress(multiple, {
      from: "pending",
      itemId: "second",
      planSha256: multipleHash,
      to: "in_progress",
    });
    expectTaskError(
      () => TaskStateMachine.project(multiple.decode()),
      "plan_multiple_in_progress",
    );

    const textEvidence = new Phase16EventBuilder();
    appendGoal(textEvidence);
    const textHash = appendPlan(textEvidence);
    startRun(textEvidence);
    appendProgress(textEvidence, {
      from: "pending",
      planSha256: textHash,
      to: "in_progress",
    });
    const text = textEvidence.run("text.delta", { delta: "not evidence" });
    appendProgress(textEvidence, {
      evidence: [eventIdOf(text)],
      from: "in_progress",
      note: "invalid evidence",
      planSha256: textHash,
      to: "completed",
    });
    expectTaskError(
      () => TaskStateMachine.project(textEvidence.decode()),
      "evidence_reference_invalid",
    );
  });

  it("rejects otherwise valid read evidence from a legacy-unbound run", () => {
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    const planSha256 = appendPlan(builder);
    startRun(builder);
    builder.run("tool.call.requested", toolRequestData("legacy-read", "read_file"));
    const legacyEvidence = builder.run(
      "tool.call.completed",
      toolCompletedData("legacy-read", "read_file"),
    );
    builder.run("run.completed", { duration_ms: 1, output_chars: 0 });
    builder.run(
      "run.started",
      chatStartData({ resume_mode: "exact", resume_of_run_id: RUN }),
      "00000000-0000-4000-8000-000000016109",
    );
    builder.run(
      "backend.selected",
      backendSelectedData(),
      "00000000-0000-4000-8000-000000016109",
    );
    const secondRun = "00000000-0000-4000-8000-000000016109";
    const callId = "second-run-progress";
    builder.run(
      "tool.call.requested",
      toolRequestData(callId, "update_plan"),
      secondRun,
    );
    builder.session("plan.item.status_changed", {
      evidence_event_ids: [],
      from: "pending",
      goal_id: GOAL,
      goal_revision: 1,
      item_id: "implement",
      note: "",
      origin: agentOrigin(callId, secondRun),
      plan_id: PLAN,
      plan_sha256: planSha256,
      revision: 1,
      to: "in_progress",
    });
    builder.run(
      "tool.call.completed",
      toolCompletedData(callId, "update_plan"),
      secondRun,
    );
    const completeCall = "second-run-complete";
    builder.run(
      "tool.call.requested",
      toolRequestData(completeCall, "update_plan"),
      secondRun,
    );
    builder.session("plan.item.status_changed", {
      evidence_event_ids: [eventIdOf(legacyEvidence)],
      from: "in_progress",
      goal_id: GOAL,
      goal_revision: 1,
      item_id: "implement",
      note: "legacy evidence must not count",
      origin: agentOrigin(completeCall, secondRun),
      plan_id: PLAN,
      plan_sha256: planSha256,
      revision: 1,
      to: "completed",
    });
    expectTaskError(
      () => TaskStateMachine.project(builder.decode()),
      "evidence_reference_invalid",
    );
  });

  it.each([
    "read_tool",
    "patch",
    "command",
    "verification",
    "artifact",
    "mcp",
    "reconciled",
  ])("accepts eligible %s completion evidence", (kind) => {
    const builder = new Phase16EventBuilder();
    appendGoal(builder);
    const planSha256 = appendPlan(builder);
    startRun(builder);
    appendProgress(builder, {
      from: "pending",
      planSha256,
      to: "in_progress",
    });

    let evidence: Record<string, unknown>;
    switch (kind) {
      case "read_tool": {
        builder.run("tool.call.requested", toolRequestData("read-e", "read_file"));
        evidence = builder.run(
          "tool.call.completed",
          toolCompletedData("read-e", "read_file"),
        );
        break;
      }
      case "patch":
        evidence = builder.run("patch.apply.completed", {
          added_lines: 1,
          approval_request_id: uuid(16_701),
          call_id: "patch-e",
          duration_ms: 1,
          files: [
            {
              kind: "modify",
              path: "src/a.ts",
              post_sha256: "1".repeat(64),
              pre_sha256: "2".repeat(64),
            },
          ],
          journal_sha256: "3".repeat(64),
          plan_id: "4".repeat(64),
          removed_lines: 0,
          step: 1,
        });
        break;
      case "command":
        evidence = builder.run("command.completed", {
          action_sha256: "1".repeat(64),
          call_id: "command-e",
          cleanup_verified: true,
          duration_ms: 1,
          execution_id: uuid(16_702),
          executor: "local",
          exit_code: 0,
          signal: null,
          stderr_bytes: 0,
          stdout_bytes: 0,
          step: 1,
          termination: "exit",
          total_bytes: 0,
          truncated: false,
        });
        break;
      case "verification":
        evidence = builder.run("verification.completed", {
          action_sha256: "1".repeat(64),
          after_snapshot_sha256: "2".repeat(64),
          before_snapshot_sha256: "2".repeat(64),
          call_id: "verify-e",
          command_execution_id: uuid(16_703),
          completed_generation: 0,
          duration_ms: 1,
          exit_code: 0,
          stale: false,
          stale_reasons: [],
          started_generation: 0,
          status: "passed",
          step: 1,
          verification_id: uuid(16_704),
        });
        break;
      case "artifact": {
        const origin = builder.run(
          "tool.call.requested",
          toolRequestData("artifact-e", "search"),
        );
        const hash = "5".repeat(64);
        evidence = builder.run("artifact.stored", {
          artifact_id: `sha256:${hash}`,
          bytes: 1,
          capture_status: "complete",
          capture_truncated: false,
          media_type: "text/plain; charset=utf-8",
          object_ref: `artifacts/${SESSION}/objects/${hash}`,
          origin_event_id: eventIdOf(origin),
          sha256: hash,
        });
        break;
      }
      case "mcp":
        evidence = builder.run("mcp.tool.call.completed", {
          action_sha256: "1".repeat(64),
          approval_request_id: uuid(16_705),
          arguments_sha256: "2".repeat(64),
          bytes: 2,
          call_id: "mcp-e",
          catalog_sha256: "3".repeat(64),
          config_sha256: "4".repeat(64),
          duration_ms: 1,
          mapper_version: "mcp-text-result-v1",
          model_tool_name: "lookup",
          observation: "ok",
          observation_sha256: "5".repeat(64),
          process_identity_sha256: "6".repeat(64),
          raw_tool_name: "lookup",
          schema_sha256: "7".repeat(64),
          server_id: "fixture",
          status: "success",
          step: 1,
          timeout_ms: 1_000,
          truncated: false,
        });
        break;
      case "reconciled":
        evidence = builder.session("side_effect.reconciled", {
          effect_id: "patch-e",
          effect_kind: "patch",
          evidence_sha256: "8".repeat(64),
          observed: "applied",
          source_run_id: RUN,
        });
        break;
      default:
        throw new Error(`unknown fixture ${kind}`);
    }

    appendProgress(builder, {
      evidence: [eventIdOf(evidence)],
      from: "in_progress",
      note: `${kind} produced durable evidence`,
      planSha256,
      to: "completed",
    });
    expect(TaskStateMachine.project(builder.decode())).toMatchObject({
      readyForCompletion: true,
    });
  });

  it("allows failed allowed evidence for blocked but not completed", () => {
    const blocked = new Phase16EventBuilder();
    appendGoal(blocked);
    const planSha256 = appendPlan(blocked);
    startRun(blocked);
    appendProgress(blocked, {
      from: "pending",
      planSha256,
      to: "in_progress",
    });
    blocked.run("tool.call.requested", toolRequestData("read-fail", "read_file"));
    const failure = blocked.run(
      "tool.call.completed",
      toolCompletedData("read-fail", "read_file", "error"),
    );
    appendProgress(blocked, {
      evidence: [eventIdOf(failure)],
      from: "in_progress",
      note: "The required file could not be read.",
      planSha256,
      to: "blocked",
    });
    const state = TaskStateMachine.project(blocked.decode());
    expect(state.blockers).toMatchObject([
      { itemId: "implement", note: "The required file could not be read." },
    ]);
    expect(state.readyForCompletion).toBe(false);
  });
});
