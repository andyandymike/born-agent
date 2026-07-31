import { describe, expect, it, vi } from "vitest";

import {
  RunCoordinator,
  RunCoordinatorPortError,
  type RunCoordinatorPort,
  type RunCoordinatorRunResult,
} from "../../src/coordination/run-coordinator.js";
import {
  parsePhase16UserIntent,
  type Phase16StartIntent,
} from "../../src/tui/phase16-user-intent.js";

const SESSION = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const INTENT = "30000000-0000-4000-8000-000000000003";
const GOAL = "40000000-0000-4000-8000-000000000004";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

function submit(seq = 7): Phase16StartIntent {
  return {
    expectedSessionSeq: seq,
    sessionId: SESSION,
    text: "Implement the next safe slice",
    type: "submit_idle_message",
  };
}

function port(overrides: Partial<RunCoordinatorPort> = {}): RunCoordinatorPort {
  return {
    mutate: vi.fn(async () => ({ sessionId: SESSION, snapshotSeq: 8 })),
    refresh: vi.fn(async (sessionId) => ({
      sessionId,
      snapshotSeq: sessionId === null ? null : 7,
    })),
    start: vi.fn(async (_intent, context) => {
      context.onStarted({ runId: RUN, sessionId: SESSION });
      return { exitCode: 0, snapshot: { sessionId: SESSION, snapshotSeq: 12 } };
    }),
    ...overrides,
  };
}

describe("Phase 16F user intent schema", () => {
  it("rejects incomplete snapshots, unknown fields, and unconfirmed Goal replacement", () => {
    expect(() =>
      parsePhase16UserIntent({
        expectedSessionSeq: null,
        sessionId: SESSION,
        text: "task",
        type: "submit_idle_message",
      }),
    ).toThrow();
    expect(() =>
      parsePhase16UserIntent({
        expectedSessionSeq: 1,
        extra: true,
        sessionId: SESSION,
        text: "task",
        type: "submit_idle_message",
      }),
    ).toThrow();
    expect(() =>
      parsePhase16UserIntent({
        confirmedAbandon: false,
        currentGoalId: GOAL,
        currentGoalRevision: 1,
        expectedSessionSeq: 1,
        sessionId: SESSION,
        text: "replacement",
        type: "start_new_goal",
      }),
    ).toThrow();
  });
});

describe("RunCoordinator", () => {
  it("allows one active run, retains active-submit input, and cancels without a queue", async () => {
    const terminal = deferred<RunCoordinatorRunResult>();
    let signal: AbortSignal | undefined;
    const start = vi.fn<RunCoordinatorPort["start"]>(async (_intent, context) => {
      signal = context.signal;
      context.onStarted({ runId: RUN, sessionId: SESSION });
      return terminal.promise;
    });
    const adapter = port({ start });
    const coordinator = new RunCoordinator({
      createIntentId: () => INTENT,
      port: adapter,
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
    });

    const active = coordinator.dispatch(submit());
    await vi.waitFor(() => expect(coordinator.state.kind).toBe("running"));
    await expect(coordinator.dispatch(submit())).resolves.toEqual({
      draftRetained: true,
      status: "busy",
    });
    expect(start).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.dispatch({ type: "cancel_active_run" }),
    ).resolves.toEqual({ status: "cancel_requested" });
    expect(signal?.aborted).toBe(true);
    expect(coordinator.state.kind).toBe("cancelling");

    terminal.resolve({
      exitCode: 130,
      snapshot: { sessionId: SESSION, snapshotSeq: 10 },
    });
    await expect(active).resolves.toEqual({
      exitCode: 130,
      snapshot: { sessionId: SESSION, snapshotSeq: 10 },
      status: "run_finished",
    });
    expect(coordinator.state).toEqual({
      kind: "idle",
      sessionId: SESSION,
      snapshotSeq: 10,
    });
  });

  it("rejects a stale local binding before calling a mutation or provider port", async () => {
    const adapter = port();
    const coordinator = new RunCoordinator({
      createIntentId: () => INTENT,
      port: adapter,
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
    });

    await expect(coordinator.dispatch(submit(6))).resolves.toEqual({
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
      status: "stale",
    });
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("adopts a lock-time stale snapshot without rebinding the original intent", async () => {
    const adapter = port({
      mutate: vi.fn(async () => {
        throw new RunCoordinatorPortError(
          "stale_snapshot",
          "external mutation won the lock",
          { sessionId: SESSION, snapshotSeq: 8 },
        );
      }),
    });
    const coordinator = new RunCoordinator({
      createIntentId: () => INTENT,
      port: adapter,
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
    });

    await expect(
      coordinator.dispatch({
        baseRevision: 1,
        expectedSessionSeq: 7,
        goalId: GOAL,
        objective: "Revised exact objective",
        sessionId: SESSION,
        type: "revise_goal",
      }),
    ).resolves.toEqual({
      snapshot: { sessionId: SESSION, snapshotSeq: 8 },
      status: "stale",
    });
    expect(coordinator.state).toEqual({
      kind: "idle",
      sessionId: SESSION,
      snapshotSeq: 8,
    });
  });

  it("returns to the exact idle snapshot when start preflight fails before run.started", async () => {
    const adapter = port({
      start: vi.fn(async () => {
        throw new RunCoordinatorPortError(
          "precondition_failed",
          "approved Plan is required",
        );
      }),
    });
    const coordinator = new RunCoordinator({
      createIntentId: () => INTENT,
      port: adapter,
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
    });

    await expect(coordinator.dispatch(submit())).resolves.toEqual({
      code: "precondition_failed",
      message: "approved Plan is required",
      status: "failed",
    });
    expect(coordinator.state).toEqual({
      kind: "idle",
      sessionId: SESSION,
      snapshotSeq: 7,
    });
  });

  it("fails closed when a started run disappears without a terminal snapshot", async () => {
    const adapter = port({
      start: vi.fn(async (_intent, context) => {
        context.onStarted({ runId: RUN, sessionId: SESSION });
        throw new Error("renderer exploded");
      }),
    });
    const coordinator = new RunCoordinator({
      createIntentId: () => INTENT,
      port: adapter,
      snapshot: { sessionId: SESSION, snapshotSeq: 7 },
    });

    await expect(coordinator.dispatch(submit())).resolves.toEqual({
      message: "a started run failed without a consistent terminal snapshot",
      status: "fatal",
    });
    expect(coordinator.state.kind).toBe("fatal");
  });
});
