import { describe, expect, it, vi } from "vitest";

import { ApprovalController } from "../../src/tui/approval-controller.js";
import { BornAgentViewComponent } from "../../src/tui/components/bornagent-view.js";
import { PersistedEventSource } from "../../src/tui/persisted-event-source.js";
import type { PiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import {
  TuiController,
  type TuiCorePort,
} from "../../src/tui/tui-controller.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";
import {
  GOAL,
  Phase16EventBuilder,
  planContent,
  planIdentity,
  userOrigin,
} from "./phase16a-test-fixtures.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function taskBuilder(): Phase16EventBuilder {
  const builder = new Phase16EventBuilder();
  const content = planContent();
  builder.session("goal.created", {
    goal_id: GOAL,
    objective: "Deliver the exact approved implementation",
    origin: { ...userOrigin, input_surface: "tui" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  builder.session("plan.proposed", {
    content,
    origin: { ...userOrigin, input_surface: "tui" },
    plan_sha256: planIdentity(content).sha256,
  });
  return builder;
}

function fixture() {
  const builder = taskBuilder();
  const controllerRef: { current?: TuiController } = {};
  const mutateIntent = vi.fn<NonNullable<TuiCorePort["mutateIntent"]>>(
    async (intent) => {
      if (intent.type !== "approve_plan") {
        return { diagnostic: "unexpected mutation", exitCode: 2 };
      }
      builder.session("plan.approved", {
        goal_id: intent.goalId,
        goal_revision: intent.goalRevision,
        origin: { ...userOrigin, input_surface: "tui" },
        plan_id: intent.planId,
        plan_sha256: intent.sha256,
        revision: intent.revision,
      });
      controllerRef.current!.acceptPersistedEvent(
        builder.decode().at(-1)! as TuiPersistedEvent,
      );
      return { diagnostic: null, exitCode: 0 };
    },
  );
  const core: TuiCorePort = {
    abortActiveOwnerRun: vi.fn(),
    cancelActiveRun: vi.fn(),
    loadSession: async () => builder.decode() as readonly TuiPersistedEvent[],
    mutateIntent,
    resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
    startIntent: async () => ({ diagnostic: "not used", exitCode: 2 }),
    startTask: async () => ({ diagnostic: null, exitCode: 0 }),
  };
  const renderer: PiTuiRenderer = {
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
  };
  const source = new PersistedEventSource({
    onEvent: (event) => controllerRef.current?.acceptPersistedEvent(event),
    onFatal: () => controllerRef.current?.handleSourceFatal(),
  });
  const approvals = new ApprovalController(() => controllerRef.current!.view, {
    decideApproval: async () => undefined,
  });
  const controller = new TuiController({
    approvalController: approvals,
    core,
    createIntentId: () => "00000000-0000-4000-8000-000000016999",
    renderer,
    source,
  });
  controllerRef.current = controller;
  controller.start(builder.decode() as readonly TuiPersistedEvent[]);
  return { builder, controller, mutateIntent };
}

function enter(controller: TuiController, text: string): void {
  controller.handleRawInput(text);
  controller.handleRawInput("\r");
}

describe("Phase 16F Plan decision dialog", () => {
  it("shows the exact identity and defaults Enter to cancel", async () => {
    const test = fixture();

    enter(test.controller, "/plan approve");
    await flush();

    const dialog = test.controller.ephemeral.planDecisionDialog;
    expect(dialog).toMatchObject({
      action: "approve",
      expectedSessionSeq: 2,
      goalId: GOAL,
      planSha256: planIdentity().sha256,
      revision: 1,
    });
    const rendered = new BornAgentViewComponent(
      test.controller.view,
      test.controller.ephemeral,
    )
      .render(240)
      .join("\n");
    expect(rendered).toContain(`sha256=${planIdentity().sha256}`);
    expect(rendered).toContain("Plan approval does not approve patches");
    expect(rendered).toContain("[CANCEL]  confirm (default cancel)");

    test.controller.handleRawInput("\r");
    await flush();
    expect(test.mutateIntent).not.toHaveBeenCalled();
    expect(test.controller.ephemeral.planDecisionDialog).toBeNull();
  });

  it("commits only after explicit focus and rejects a stale open dialog", async () => {
    const approved = fixture();
    enter(approved.controller, "/plan approve");
    await flush();
    approved.controller.handleRawInput("\t");
    approved.controller.handleRawInput("\r");
    await flush();

    expect(approved.mutateIntent).toHaveBeenCalledOnce();
    expect(approved.controller.view.taskState.currentApprovedPlan).toMatchObject({
      planSha256: planIdentity().sha256,
      revision: 1,
    });

    const stale = fixture();
    enter(stale.controller, "/plan approve");
    await flush();
    const content = planContent();
    stale.builder.session("plan.rejected", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: { ...userOrigin, input_surface: "cli" },
      plan_id: content.planId,
      plan_sha256: planIdentity(content).sha256,
      reason: "External decision won the race",
      revision: 1,
    });
    stale.controller.acceptPersistedEvent(
      stale.builder.decode().at(-1)! as TuiPersistedEvent,
    );
    stale.controller.handleRawInput("\t");
    stale.controller.handleRawInput("\r");
    await flush();

    expect(stale.mutateIntent).not.toHaveBeenCalled();
    expect(stale.controller.ephemeral.coreDiagnostic).toContain("became stale");
  });
});
