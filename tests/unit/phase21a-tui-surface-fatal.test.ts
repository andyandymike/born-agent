import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  brokerForStateRoot,
  disposeApplicationHostForStateRoot,
  planeForRuntime,
  requestTuiSurfaceFatalForRuntime,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const root of temporary.splice(0)) {
    await disposeApplicationHostForStateRoot(root);
    await rm(root, { force: true, recursive: true });
  }
});

describe("Phase 21A TUI surface fatal owner routing", () => {
  it("signals only the exact registered run owner and never creates a human cancel", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "tui-surface-fatal-"));
    temporary.push(stateRoot);
    const runtime = createRuntime({ controlPlaneStateRoot: stateRoot });
    await planeForRuntime(runtime, createMemoryIO().io);
    const sessionId = crypto.randomUUID();
    const requestCancel = vi.fn();
    const requestHostEmergencyStop = vi.fn();
    const release = brokerForStateRoot(stateRoot).register(sessionId, {
      readStableSnapshot: async () => {
        throw new Error("not reached by emergency routing");
      },
      runControl: {
        acceptsObservedHead: () => true,
        ownerApplicationOperationId: "operation-exact-owner",
        ownerGenerationSha256: "a".repeat(64),
        requestCancel,
        requestHostEmergencyStop,
        runId: "run-exact-owner",
      },
    });

    try {
      const outcome = requestTuiSurfaceFatalForRuntime(
        runtime,
        sessionId,
      );

      expect(outcome).toEqual({
        kind: "signalled_exact_owner",
        ownerApplicationOperationId: "operation-exact-owner",
        ownerKind: "run",
      });
      expect(requestHostEmergencyStop).toHaveBeenCalledExactlyOnceWith({
        reason: "tui_surface_fatal",
      });
      expect(requestCancel).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("fails closed when the current session has no exact active owner", () => {
    expect(requestTuiSurfaceFatalForRuntime(
      createRuntime({ controlPlaneStateRoot: `tui-surface-fatal-${crypto.randomUUID()}` }),
      crypto.randomUUID(),
    )).toEqual({ kind: "unknown_owner" });
  });
});
