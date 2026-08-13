import { describe, expect, it, vi } from "vitest";

import type { CliIO, CliRuntime } from "../../src/cli/types.js";
import type { TaskApplicationActionResultV1 } from "../../src/control-plane/adapters/task-cli-adapter.js";

const executeTaskAction = vi.hoisted(() => vi.fn());

vi.mock("../../src/control-plane/adapters/task-cli-adapter.js", () => ({
  executeTaskActionThroughApplicationService: executeTaskAction,
}));

import {
  executeTuiDelegationApplicationAction,
  executeTuiGraphApplicationAction,
} from "../../src/tui/tui-application-action-port.js";

const io: CliIO = Object.freeze({
  stderr: Object.freeze({ write: () => undefined }),
  stdout: Object.freeze({ write: () => undefined }),
});
const runtime = Object.freeze({}) as CliRuntime;

function applicationResult(input: Readonly<{
  readonly error?: Readonly<{ readonly code: string; readonly message: string }>;
  readonly exitCode?: 0 | 1 | 2 | 8;
  readonly sequence?: number;
}> = {}): TaskApplicationActionResultV1<unknown> {
  return {
    envelope: {
      error: input.error ?? null,
      ledgerHead: input.sequence === undefined
        ? null
        : { eventId: crypto.randomUUID(), integrityToken: "t".repeat(64), sequence: input.sequence, sessionId: crypto.randomUUID() },
    },
    exitCode: input.exitCode ?? 0,
  } as unknown as TaskApplicationActionResultV1<unknown>;
}

describe("Phase 21A typed TUI application action port", () => {
  it("maps an exact Graph projection binding directly to graph.run", async () => {
    executeTaskAction.mockReset().mockResolvedValueOnce(applicationResult({ sequence: 18 }));
    const sessionId = crypto.randomUUID();
    const result = await executeTuiGraphApplicationAction({
      background: true,
      expectedSessionSeq: 17,
      revision: 3,
      sessionId,
      sha256: "a".repeat(64),
      type: "run",
    }, runtime, io);

    expect(result).toEqual({ diagnostic: null, exitCode: 0 });
    expect(executeTaskAction).toHaveBeenCalledOnce();
    expect(executeTaskAction).toHaveBeenCalledWith({
      actionKind: "graph.run",
      expectedSessionSeq: 17,
      io,
      payload: { execution: "background", revision: 3, sha256: "a".repeat(64) },
      runtime,
      sessionId,
      surface: "tui",
    });
  });

  it("keeps delegation approve and enqueue as two exact application operations", async () => {
    executeTaskAction.mockReset()
      .mockResolvedValueOnce(applicationResult({ sequence: 22 }))
      .mockResolvedValueOnce(applicationResult({ sequence: 23 }));
    const sessionId = crypto.randomUUID();
    const delegationId = crypto.randomUUID();
    const result = await executeTuiDelegationApplicationAction({
      action: "approve",
      delegationId,
      expectedSessionSeq: 21,
      reason: null,
      revision: 2,
      sessionId,
      sha256: "b".repeat(64),
    }, runtime, io);

    expect(result).toEqual({ diagnostic: null, exitCode: 0 });
    expect(executeTaskAction).toHaveBeenNthCalledWith(1, {
      actionKind: "delegation.decide",
      expectedSessionSeq: 21,
      io,
      payload: { decision: "approve", delegationId, revision: 2, sha256: "b".repeat(64) },
      runtime,
      sessionId,
      surface: "tui",
    });
    expect(executeTaskAction).toHaveBeenNthCalledWith(2, {
      actionKind: "delegation.enqueue",
      expectedSessionSeq: 22,
      io,
      payload: { delegationId },
      runtime,
      sessionId,
      surface: "tui",
    });
  });

  it("uses the composite resume action and preserves typed failures", async () => {
    executeTaskAction.mockReset().mockResolvedValueOnce(applicationResult({
      error: { code: "control_operation_busy", message: "owner is reconciling" },
      exitCode: 8,
      sequence: 31,
    }));
    const sessionId = crypto.randomUUID();
    const delegationId = crypto.randomUUID();
    const result = await executeTuiDelegationApplicationAction({
      action: "start_or_resume",
      delegationId,
      expectedSessionSeq: 30,
      reason: null,
      revision: 4,
      sessionId,
      sha256: "c".repeat(64),
    }, runtime, io);

    expect(executeTaskAction).toHaveBeenCalledWith(expect.objectContaining({
      actionKind: "delegation.resume",
      expectedSessionSeq: 30,
      payload: { delegationId },
      surface: "tui",
    }));
    expect(result).toEqual({
      diagnostic: "control_operation_busy: owner is reconciling",
      exitCode: 8,
    });
  });
});
