import { describe, expect, it, vi } from "vitest";

import type { Phase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { ProcessLocalApplicationHostRegistry } from "../../src/control-plane/local-application-host.js";

describe("AS2.1 LocalApplicationHost lifecycle", () => {
  it("creates one Host per process state root and shares it across adapters", async () => {
    const registry = new ProcessLocalApplicationHostRegistry();
    const createPlane = vi.fn(async () => Object.freeze({}) as Phase21ALocalControlPlane);
    const stateRoot = "D:/state/application-control";

    const [first, second] = await Promise.all([
      registry.getOrCreate({ createPlane, stateRoot }),
      registry.getOrCreate({ createPlane, stateRoot }),
    ]);

    expect(first).toBe(second);
    expect(registry.peek(stateRoot)).toBe(first);
    expect(registry.size).toBe(1);
    expect(createPlane).toHaveBeenCalledTimes(1);
  });

  it("records exact owner routes and disposes every ephemeral owner once", async () => {
    const registry = new ProcessLocalApplicationHostRegistry();
    const stateRoot = "D:/state/application-control-dispose";
    const host = await registry.getOrCreate({
      createPlane: async () => Object.freeze({}) as Phase21ALocalControlPlane,
      stateRoot,
    });
    const sessionId = "10000000-0000-4000-8000-000000000002";
    const releaseGraph = host.activeOwners.foregroundGraphs.register(sessionId, Object.freeze({
      graphRevision: 1,
      graphSha256: "a".repeat(64),
      ownerApplicationOperationId: "20000000-0000-4000-8000-000000000002",
      ownerPreparedActionSha256: "b".repeat(64),
      requestCancel: async () => undefined,
      requestHostEmergencyStop: () => undefined,
    }));
    const releaseBroker = host.broker.register(sessionId, Object.freeze({
      readStableSnapshot: async () => {
        throw new Error("not read by lifecycle test");
      },
    }));
    const releaseChat = host.registerChatExecution("c".repeat(64), Object.freeze({
      execute: async () => Object.freeze({ exitCode: 0 }),
    }));
    const releaseResume = host.registerSessionResumeOwner(sessionId, Object.freeze({
      execute: async () => {
        throw new Error("not executed by lifecycle test");
      },
    }));

    expect(host.activeOwners.list()).toEqual([{
      ownerKind: "foreground_graph",
      parentOperationId: "20000000-0000-4000-8000-000000000002",
      sessionId,
      stateRoot,
    }]);
    expect(host.activeOwners.activeRouteCount).toBe(1);
    expect(host.broker.activeOwnerCount).toBe(1);
    expect(host.ephemeralOwnerCount).toBe(2);

    await registry.dispose(stateRoot);
    await registry.dispose(stateRoot);
    releaseGraph();
    releaseBroker();
    releaseChat();
    releaseResume();

    expect(registry.size).toBe(0);
    expect(registry.peek(stateRoot)).toBeNull();
    expect(host.disposeCount).toBe(1);
    expect(host.activeOwners.activeRouteCount).toBe(0);
    expect(host.broker.activeOwnerCount).toBe(0);
    expect(host.delivery.trackedClientCount).toBe(0);
    expect(host.ephemeralOwnerCount).toBe(0);
  });
});
