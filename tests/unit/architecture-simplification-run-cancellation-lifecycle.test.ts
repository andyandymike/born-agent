import { describe, expect, it } from "vitest";

import { RunCancellationLifecycle } from "../../src/control-plane/run-cancellation-lifecycle.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";

function head(sessionId: string) {
  return Object.freeze({
    eventId: "10000000-0000-4000-8000-000000000032",
    eventIntegrityToken: `slh_v1_${"a".repeat(43)}`,
    schemaVersion: 1 as const,
    sequence: 1,
    sessionId,
  });
}

describe("AS3.2 RunCancellationLifecycle", () => {
  it("gives message and resume one register observe poll and close trace", async () => {
    const traces: readonly (readonly string[])[] = await Promise.all(["message", "resume"].map(async () => {
      const trace: string[] = [];
      const sessionId = "20000000-0000-4000-8000-000000000032";
      const runId = "30000000-0000-4000-8000-000000000032";
      let tick: (() => Promise<void>) | null = null;
      const broker = new SessionOwnerBroker();
      const lifecycle = new RunCancellationLifecycle({
        acceptsObservedHead: () => true,
        activeRead: {
          readStableSnapshot: async () => ({ events: [], head: { publicHead: head(sessionId) }, projection: {} }) as never,
        },
        broker,
        ownerApplicationOperationId: "40000000-0000-4000-8000-000000000032",
        ownerRegistryOperationId: runId,
        recurringTasks: {
          startRecurringTask: (_interval, task) => {
            trace.push("poll.register");
            tick = task;
            return async () => { trace.push("poll.close"); };
          },
        },
        repositoryId: "b".repeat(64),
        runId,
        sessionId,
        sessions: {
          bindRunCancelRequest: async () => { trace.push("cancel.bind"); return {} as never; },
          closeRunCancelBarrier: async () => { trace.push("cancel.close"); return {} as never; },
          observeRunOwner: async (input) => {
            trace.push(`observe.${input.observationKind}`);
            return { request: null } as never;
          },
          readRunCancelBarrier: async () => ({
            binding: null,
            observations: [{ observationKind: "started" }],
            owner: { fact: { ownerGenerationSha256: "c".repeat(64) } },
            request: null,
            terminal: null,
          }) as never,
          registerRunOwner: async () => { trace.push("owner.register"); return {} as never; },
          requestRunCancel: async () => ({} as never),
        },
        writer: {
          events: [],
          lockNonceSha256: "c".repeat(64),
        } as never,
      });
      await lifecycle.activate(head(sessionId));
      await lifecycle.observeStarted();
      const runTick = tick as (() => Promise<void>) | null;
      if (runTick !== null) await runTick();
      await lifecycle.finish();
      await lifecycle.finish();
      expect(broker.activeOwnerCount).toBe(0);
      return trace;
    }));
    expect(traces[0]).toEqual(traces[1]);
    expect(traces[0]).toEqual([
      "owner.register",
      "poll.register",
      "observe.started",
      "observe.progress",
      "poll.close",
    ]);
  });

  it("makes finish and Host emergency signal idempotent", async () => {
    const broker = new SessionOwnerBroker();
    const sessionId = "50000000-0000-4000-8000-000000000032";
    let stopCount = 0;
    const lifecycle = new RunCancellationLifecycle({
      acceptsObservedHead: () => true,
      activeRead: { readStableSnapshot: async () => { throw new Error("not read"); } },
      broker,
      ownerApplicationOperationId: "60000000-0000-4000-8000-000000000032",
      ownerRegistryOperationId: "70000000-0000-4000-8000-000000000032",
      recurringTasks: {
        startRecurringTask: () => async () => { stopCount += 1; },
      },
      repositoryId: "d".repeat(64),
      runId: "70000000-0000-4000-8000-000000000032",
      sessionId,
      sessions: {
        bindRunCancelRequest: async () => ({} as never),
        closeRunCancelBarrier: async () => ({} as never),
        observeRunOwner: async () => ({ request: null } as never),
        readRunCancelBarrier: async () => ({} as never),
        registerRunOwner: async () => ({} as never),
        requestRunCancel: async () => ({} as never),
      },
      writer: { events: [], lockNonceSha256: "e".repeat(64) } as never,
    });
    await lifecycle.activate(head(sessionId));
    broker.requestHostEmergencyStop(sessionId, { reason: "tui_surface_fatal" });
    broker.requestHostEmergencyStop(sessionId, { reason: "tui_surface_fatal" });
    expect(lifecycle.applicationCancellation.signal.aborted).toBe(true);
    expect(lifecycle.applicationCancellation.hostEmergencyReason()).toBe("tui_surface_fatal");
    await lifecycle.finish();
    await lifecycle.finish();
    expect(stopCount).toBe(1);
  });
});
