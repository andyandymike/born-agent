import { describe, expect, it, vi } from "vitest";

import type { TaskPreparedActionReviewV1 } from "../../src/control-plane/adapters/task-cli-adapter.js";
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
  SESSION,
  userOrigin,
} from "./phase16a-test-fixtures.js";

const REPOSITORY_ID = "00000000-0000-4000-8000-000000021001";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function taskBuilder(): Phase16EventBuilder {
  const builder = new Phase16EventBuilder();
  builder.session("goal.created", {
    goal_id: GOAL,
    objective: "Review the exact Host action",
    origin: { ...userOrigin, input_surface: "tui" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  return builder;
}

function review(
  sequence: number,
  overrides: Partial<TaskPreparedActionReviewV1> = {},
): TaskPreparedActionReviewV1 {
  return {
    actionKind: "goal.decide",
    displaySha256: "b".repeat(64),
    expiresAt: "2026-08-12T00:05:00.000Z",
    preparedActionId: "00000000-0000-4000-8000-000000021101",
    preparedActionSha256: "a".repeat(64),
    summary: "Abandon Goal 1 after exact review.",
    target: {
      expectedVersion: {
        head: {
          eventId: "00000000-0000-4000-8000-000000017001",
          eventIntegrityToken: "slh_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          schemaVersion: 1,
          sequence,
          sessionId: SESSION,
        },
        kind: "session_ledger_head",
      },
      kind: "existing_resource",
      resourceScope: {
        kind: "session",
        repositoryId: REPOSITORY_ID,
        sessionId: SESSION,
        teamId: null,
      },
    },
    warnings: ["This action changes durable Goal state."],
    ...overrides,
  };
}

function fixture(
  now = new Date("2026-08-12T00:00:00.000Z"),
  initialEvents?: readonly TuiPersistedEvent[],
) {
  const builder = taskBuilder();
  const initial = initialEvents ?? builder.decode() as readonly TuiPersistedEvent[];
  const controllerRef: { current?: TuiController } = {};
  const renderer: PiTuiRenderer = {
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
  };
  const core: TuiCorePort = {
    abortActiveOwnerRun: vi.fn(),
    cancelActiveRun: vi.fn(),
    loadSession: async () => builder.decode() as readonly TuiPersistedEvent[],
    resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
    startTask: async () => ({ diagnostic: null, exitCode: 0 }),
  };
  const source = new PersistedEventSource({
    onEvent: (event) => controllerRef.current?.acceptPersistedEvent(event),
    onFatal: () => controllerRef.current?.handleSourceFatal(),
  });
  const controller = new TuiController({
    approvalController: new ApprovalController(
      () => controllerRef.current!.view,
      { decideApproval: async () => undefined },
    ),
    core,
    now: () => now,
    renderer,
    source,
  });
  controllerRef.current = controller;
  controller.start(initial);
  return { builder, controller, renderer };
}

describe("Phase 21A TUI prepared-action confirmation", () => {
  it("allows the Host-created zero-head session handoff while the fresh TUI is still empty", async () => {
    const test = fixture(new Date("2026-08-12T00:00:00.000Z"), []);
    const firstMessage = review(0, {
      actionKind: "session.message.submit",
    });
    const decision = test.controller.reviewPreparedAction(firstMessage);
    await flush();
    const lines = new BornAgentViewComponent(
      test.controller.view,
      test.controller.ephemeral,
    ).render(240).join("\n");
    expect(lines).toContain("HOST PREPARED ACTION | session.message.submit");
    expect(lines).not.toContain("| STALE");
    test.controller.handleRawInput("\t");
    test.controller.handleRawInput("\r");
    await expect(decision).resolves.toBe("confirmed");
    test.controller.stop();
  });

  it("renders the Host display before releasing the exact prepared commit", async () => {
    const test = fixture();
    let committed = 0;
    const decision = test.controller.reviewPreparedAction(review(1)).then((value) => {
      if (value === "confirmed") committed += 1;
      return value;
    });

    await flush();
    expect(committed).toBe(0);
    expect(test.renderer.update).toHaveBeenCalled();
    const lines = new BornAgentViewComponent(
      test.controller.view,
      test.controller.ephemeral,
    ).render(240).join("\n");
    expect(lines).toContain("HOST PREPARED ACTION | goal.decide");
    expect(lines).toContain("Abandon Goal 1 after exact review.");
    expect(lines).toContain("prepared=00000000-0000-4000-8000-000000021101");
    expect(lines).toContain(`sha256=${"a".repeat(64)}`);
    expect(lines).toContain("WARNING | This action changes durable Goal state.");

    test.controller.handleRawInput("\t");
    test.controller.handleRawInput("\r");
    await expect(decision).resolves.toBe("confirmed");
    expect(committed).toBe(1);
    expect(test.controller.ephemeral.preparedActionDialog).toBeNull();
  });

  it("keeps cancel and a late Enter fail-closed with zero commit release", async () => {
    const test = fixture();
    let committed = 0;
    const first = test.controller.reviewPreparedAction(review(1)).then((value) => {
      if (value === "confirmed") committed += 1;
      return value;
    });
    await flush();
    test.controller.handleRawInput("\u001b");
    await expect(first).resolves.toBe("cancelled");

    const second = test.controller.reviewPreparedAction(review(1, {
      preparedActionId: "00000000-0000-4000-8000-000000021102",
      preparedActionSha256: "c".repeat(64),
    })).then((value) => {
      if (value === "confirmed") committed += 1;
      return value;
    });
    // A delayed Enter from the closed dialog hits the fresh default-cancel
    // focus; it cannot authorize the new prepared id/hash.
    test.controller.handleRawInput("\r");
    await expect(second).resolves.toBe("cancelled");
    expect(committed).toBe(0);
  });

  it("rejects stale and expired prepared identities without commit release", async () => {
    const test = fixture();
    let committed = 0;
    const stale = test.controller.reviewPreparedAction(review(1)).then((value) => {
      if (value === "confirmed") committed += 1;
      return value;
    });
    await flush();
    test.builder.session("goal.revised", {
      base_revision: 1,
      goal_id: GOAL,
      objective: "Projection advanced while the dialog was open",
      origin: { ...userOrigin, input_surface: "cli" },
      revision: 2,
    });
    test.controller.acceptPersistedEvent(
      test.builder.decode().at(-1)! as TuiPersistedEvent,
    );
    test.controller.handleRawInput("\t");
    test.controller.handleRawInput("\r");
    await expect(stale).resolves.toBe("stale");

    const expired = test.controller.reviewPreparedAction(review(2, {
      expiresAt: "2026-08-12T00:00:00.000Z",
      preparedActionId: "00000000-0000-4000-8000-000000021103",
      preparedActionSha256: "d".repeat(64),
    })).then((value) => {
      if (value === "confirmed") committed += 1;
      return value;
    });
    await flush();
    test.controller.handleRawInput("\t");
    test.controller.handleRawInput("\r");
    await expect(expired).resolves.toBe("expired");
    expect(committed).toBe(0);
  });
});
