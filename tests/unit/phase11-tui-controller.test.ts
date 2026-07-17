import { describe, expect, it, vi } from "vitest";

import { ApprovalController } from "../../src/tui/approval-controller.js";
import { PersistedEventSource } from "../../src/tui/persisted-event-source.js";
import type { PiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import { TuiController, type TuiCorePort } from "../../src/tui/tui-controller.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

function event(type: string, data: unknown, sessionSeq: number): TuiPersistedEvent {
  return {
    data,
    eventId: `event-${sessionSeq}`,
    runId: RUN_ID,
    runSeq: sessionSeq,
    scope: "run",
    sessionId: SESSION_ID,
    sessionSeq,
    sourceSchemaVersion: 2,
    timestamp: "2026-07-17T00:00:00.000Z",
    type,
  } as unknown as TuiPersistedEvent;
}

function started(): TuiPersistedEvent {
  return event(
    "run.started",
    {
      command: "agent",
      input: { role: "user", text: "task" },
      model: "fake-model",
      provider: "fake",
      task_profile: "read-only",
      workspace: "fixture",
    },
    1,
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture(input: {
  readonly rendererUpdate?: () => void;
  readonly startTask?: () => Promise<number>;
} = {}) {
  const approvalDecisions: unknown[] = [];
  const cancelActiveRun = vi.fn();
  const startTask = vi.fn(input.startTask ?? (async () => 0));
  const core: TuiCorePort = {
    cancelActiveRun,
    loadSession: async () => [],
    resumeSession: async () => 0,
    startTask,
  };
  const renderer: PiTuiRenderer = {
    start: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(input.rendererUpdate ?? (() => undefined)),
  };
  const controllerRef: { current?: TuiController } = {};
  const source = new PersistedEventSource({
    onEvent: (persisted) => controllerRef.current?.acceptPersistedEvent(persisted),
    onFatal: () => controllerRef.current?.handleSourceFatal(),
  });
  const approvals = new ApprovalController(
    () => controllerRef.current!.view,
    {
      decideApproval: async (decision) => {
        approvalDecisions.push(decision);
      },
    },
  );
  const controller = new TuiController({
    approvalController: approvals,
    core,
    renderer,
    source,
  });
  controllerRef.current = controller;
  controller.start();
  return {
    approvalDecisions,
    cancelActiveRun,
    controller,
    renderer,
    startTask,
  };
}

describe("Phase 11 TUI controller", () => {
  it("cancels an active run on Ctrl+C but exits 0 only after returning idle", async () => {
    let finishRun!: (code: number) => void;
    const run = new Promise<number>((resolve) => {
      finishRun = resolve;
    });
    const test = fixture({ startTask: () => run });

    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.startTask).toHaveBeenCalledOnce();
    test.controller.acceptPersistedEvent(started());
    test.controller.handleRawInput("\u0003");
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();

    test.controller.acceptPersistedEvent(event("run.cancelled", {}, 2));
    finishRun(130);
    await flush();
    test.controller.handleRawInput("\u0003");
    await expect(test.controller.waitForExit()).resolves.toBe(0);
  });

  it("clears a non-empty idle draft before a second Ctrl+C exits", async () => {
    const test = fixture();
    test.controller.handleRawInput("draft");
    test.controller.handleRawInput("\u0003");
    expect(test.controller.ephemeral.draftInput).toBe("");
    expect(test.cancelActiveRun).not.toHaveBeenCalled();
    test.controller.handleRawInput("\u0003");
    await expect(test.controller.waitForExit()).resolves.toBe(0);
  });

  it("keeps approval Enter on deny until focus explicitly moves", async () => {
    const test = fixture();
    test.controller.acceptPersistedEvent(started());
    test.controller.acceptPersistedEvent(
      event(
        "approval.requested",
        {
          action: "run_command",
          action_sha256: HASH,
          approval_request_id: "33333333-3333-4333-8333-333333333333",
          call_id: "command-1",
          preview: "pnpm test",
          truncated: false,
        },
        2,
      ),
    );
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.approvalDecisions).toEqual([
      expect.objectContaining({ actionSha256: HASH, decision: "denied" }),
    ]);
  });

  it("turns renderer exceptions into app fatal 1 after requesting cleanup", async () => {
    const test = fixture({
      rendererUpdate: () => {
        throw new Error("render failed");
      },
    });
    test.controller.acceptPersistedEvent(started());
    await flush();
    await expect(test.controller.waitForExit()).resolves.toBe(1);
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();
  });
});
