import { describe, expect, it, vi } from "vitest";

import type { CliRuntime } from "../../src/cli/types.js";
import {
  brokerForStateRoot,
  requestTuiSurfaceFatalForRuntime,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";

describe("Phase 21A TUI surface fatal owner routing", () => {
  it("signals only the exact registered run owner and never creates a human cancel", () => {
    const stateRoot = `tui-surface-fatal-${crypto.randomUUID()}`;
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
        { controlPlaneStateRoot: stateRoot } as CliRuntime,
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
      { controlPlaneStateRoot: `tui-surface-fatal-${crypto.randomUUID()}` } as CliRuntime,
      crypto.randomUUID(),
    )).toEqual({ kind: "unknown_owner" });
  });
});
