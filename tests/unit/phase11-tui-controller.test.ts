import { describe, expect, it, vi } from "vitest";

import { ApprovalController } from "../../src/tui/approval-controller.js";
import { PersistedEventSource } from "../../src/tui/persisted-event-source.js";
import type { PiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import {
  TuiController,
  type TuiCorePort,
  type TuiCoreRunResult,
} from "../../src/tui/tui-controller.js";
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
  readonly initialSnapshot?: readonly TuiPersistedEvent[];
  readonly loadSession?: TuiCorePort["loadSession"];
  readonly rendererUpdate?: () => void;
  readonly startTask?: () => Promise<TuiCoreRunResult>;
  readonly watchSession?: NonNullable<TuiCorePort["watchSession"]>;
} = {}) {
  const approvalDecisions: unknown[] = [];
  const cancelActiveRun = vi.fn();
  const startTask = vi.fn(
    input.startTask ??
      (async () => ({ diagnostic: null, exitCode: 0 } as const)),
  );
  const core: TuiCorePort = {
    cancelActiveRun,
    loadSession: input.loadSession ?? (async () => []),
    resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
    startTask,
    ...(input.watchSession === undefined
      ? {}
      : { watchSession: input.watchSession }),
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
  controller.start(input.initialSnapshot ?? []);
  return {
    approvalDecisions,
    cancelActiveRun,
    controller,
    renderer,
    startTask,
  };
}

describe("Phase 11 TUI controller", () => {
  it("decodes Kitty printable press/repeat input and ignores release events", () => {
    const test = fixture();

    expect(test.controller.handleRawInput("\u001b[97;1:1u")).toEqual({
      consume: true,
    });
    expect(test.controller.handleRawInput("\u001b[98;1:2u")).toEqual({
      consume: true,
    });
    expect(test.controller.handleRawInput("\u001b[97:65;2:1u")).toEqual({
      consume: true,
    });
    expect(test.controller.handleRawInput("\u001b[99;1:3u")).toEqual({
      consume: true,
    });

    expect(test.controller.ephemeral.draftInput).toBe("abA");
  });

  it("does not turn a Kitty Ctrl+C release into a second cancellation", async () => {
    let finishRun!: (result: TuiCoreRunResult) => void;
    const run = new Promise<TuiCoreRunResult>((resolve) => {
      finishRun = resolve;
    });
    const test = fixture({ startTask: () => run });

    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();
    test.controller.acceptPersistedEvent(started());

    test.controller.handleRawInput("\u001b[99;5:1u");
    test.controller.handleRawInput("\u001b[99;5:3u");
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();

    test.controller.acceptPersistedEvent(event("run.cancelled", {}, 2));
    finishRun({ diagnostic: "Cancelled", exitCode: 130 });
    await flush();
  });

  it("shows a pre-session core diagnostic instead of failing silently", async () => {
    const test = fixture({
      startTask: async () => ({
        diagnostic:
          "usage/config error: restart with --task-profile read-only for local chat",
        exitCode: 2,
      }),
    });

    test.controller.handleRawInput("hi");
    test.controller.handleRawInput("\r");
    await flush();

    expect(test.controller.view.session.id).toBeNull();
    expect(test.controller.ephemeral.coreDiagnostic).toContain(
      "--task-profile read-only",
    );
    expect(test.controller.ephemeral.draftInput).toBe("hi");

    test.controller.handleRawInput("x");
    expect(test.controller.ephemeral.coreDiagnostic).toBeNull();
    expect(test.controller.ephemeral.draftInput).toBe("hix");
  });

  it("cancels an active run on Ctrl+C but exits 0 only after returning idle", async () => {
    let finishRun!: (result: TuiCoreRunResult) => void;
    const run = new Promise<TuiCoreRunResult>((resolve) => {
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
    finishRun({ diagnostic: "Cancelled", exitCode: 130 });
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

  it("refreshes an idle selected session after an external file notice", async () => {
    let onChange: ((kind: "lock" | "session") => void) | null = null;
    const stopWatch = vi.fn();
    const loadSession = vi.fn(async () => [
      started(),
      event("run.cancelled", {}, 2),
    ]);
    const test = fixture({
      initialSnapshot: [started()],
      loadSession,
      watchSession: async (_sessionId, change) => {
        onChange = change;
        return stopWatch;
      },
    });
    await vi.waitFor(() => expect(onChange).not.toBeNull());

    (onChange as ((kind: "lock" | "session") => void) | null)?.("session");

    await vi.waitFor(() => {
      expect(test.controller.view.session.lastSessionSeq).toBe(2);
    });
    expect(loadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(test.controller.view.run?.status).toBe("cancelled");
    expect(test.controller.ephemeral.sessionBusy).toBe(false);

    test.controller.stop();
    expect(stopWatch).toHaveBeenCalledOnce();
  });

  it("keeps the last complete snapshot and blocks actions while an external writer is active", async () => {
    let onChange: ((kind: "lock" | "session") => void) | null = null;
    let readAttempt = 0;
    const loadSession = vi.fn(async () => {
      readAttempt += 1;
      if (readAttempt === 1) {
        throw Object.assign(new Error("writer active"), {
          code: "active_session_writer",
        });
      }
      return [started(), event("run.cancelled", {}, 2)];
    });
    const test = fixture({
      initialSnapshot: [started()],
      loadSession,
      watchSession: async (_sessionId, change) => {
        onChange = change;
        return () => undefined;
      },
    });
    await vi.waitFor(() => expect(onChange).not.toBeNull());

    (onChange as ((kind: "lock" | "session") => void) | null)?.("session");
    await vi.waitFor(() => {
      expect(test.controller.ephemeral.sessionBusy).toBe(true);
    });
    expect(test.controller.view.session.lastSessionSeq).toBe(1);

    test.controller.handleRawInput("/mode build");
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.controller.ephemeral.selectedAgentMode).toBe("build");
    expect(test.controller.ephemeral.sessionBusy).toBe(true);

    test.controller.handleRawInput("draft while busy");
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.startTask).not.toHaveBeenCalled();
    expect(test.controller.ephemeral.draftInput).toBe("draft while busy");

    (onChange as ((kind: "lock" | "session") => void) | null)?.("lock");
    await vi.waitFor(() => {
      expect(test.controller.ephemeral.sessionBusy).toBe(false);
      expect(test.controller.view.session.lastSessionSeq).toBe(2);
    });
    expect(test.controller.ephemeral.draftInput).toBe("draft while busy");
    test.controller.stop();
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
