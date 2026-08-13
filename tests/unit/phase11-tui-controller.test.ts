import { describe, expect, it, vi } from "vitest";

import { ApprovalController } from "../../src/tui/approval-controller.js";
import { PersistedEventSource } from "../../src/tui/persisted-event-source.js";
import type { PiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import {
  TuiController,
  type TuiCorePort,
  type TuiCoreRunResult,
  type TuiSessionSnapshot,
} from "../../src/tui/tui-controller.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";
import type { TuiSessionProjectionSnapshotV1 } from "../../src/tui/tui-session-projection-port.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";

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

function typedSnapshot(events: readonly TuiPersistedEvent[]): TuiSessionProjectionSnapshotV1 {
  const initial = createInitialTuiViewState();
  const sequence = events.at(-1)?.sessionSeq ?? 0;
  const eventId = sequence === 0 ? null : "33333333-3333-4333-8333-333333333333";
  const token = sequence === 0 ? null : `slh_v1_${"A".repeat(43)}`;
  const head = Object.freeze({
    eventId,
    eventIntegrityToken: token,
    schemaVersion: 1 as const,
    sequence,
    sessionId: SESSION_ID,
  });
  return Object.freeze({
    deliveryCursor: Object.freeze({
      afterEventId: eventId,
      afterEventIntegrityToken: token,
      afterSequence: sequence,
      deliveryGeneration: "typed-test-generation",
      schemaVersion: 1 as const,
      sessionId: SESSION_ID,
    }),
    events,
    ledgerHead: head,
    projection: Object.freeze({
      background: initial.background,
      blockers: Object.freeze([]),
      delegations: initial.delegations,
      graphs: Object.freeze([]),
      goals: initial.taskState.goals,
      outcome: sequence === 1 ? "running" as const : "cancelled" as const,
      plans: initial.taskState.plans,
      receipts: Object.freeze([]),
      repositoryId: "44444444-4444-4444-8444-444444444444",
      runs: Object.freeze([]),
      schemaVersion: 1 as const,
      sessionId: SESSION_ID,
      taskExecution: initial.taskExecution,
      taskGraph: initial.taskGraph,
      taskMutationBlocker: null,
      taskState: initial.taskState,
      worktrees: initial.worktrees,
    }),
    projectionIdentity: Object.freeze({
      disclosureProfileSha256: HASH,
      ledgerHead: head,
      projectionSha256: HASH,
      projectorId: "typed-test",
      projectorVersion: 1,
      schemaVersion: 1 as const,
      sessionId: SESSION_ID,
    }),
    resourceVersion: Object.freeze({ head, kind: "session_ledger_head" as const }),
    schemaVersion: 1 as const,
  });
}

function activeDelegationSnapshot(): TuiSessionProjectionSnapshotV1 {
  const snapshot = typedSnapshot([started()]);
  return Object.freeze({
    ...snapshot,
    projection: Object.freeze({
      ...snapshot.projection,
      delegations: Object.freeze({
        activeActorSlots: Object.freeze([]),
        activeConflictClaims: Object.freeze([]),
        barriers: Object.freeze([]),
        budget: Object.freeze({ held: {}, released: {}, reserved: {}, used: {} }),
        lastSessionSeq: 1,
        maximumObservedActiveChildren: 1,
        revisions: Object.freeze([Object.freeze({
          attempts: Object.freeze([]),
          content: Object.freeze({ objective: "Cancel exact child", sequence: 1, title: "Active child" }),
          delegationId: "55555555-5555-4555-8555-555555555555",
          delegationRevision: 1,
          delegationSha256: HASH,
          status: "active",
        })]),
        takeoverCount: 0,
        trackingMode: "phase20",
        waitingApprovals: Object.freeze([]),
        workspaceConflictDeferrals: 0,
      }) as never,
    }),
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture(input: {
  readonly activeDelegationOwner?: () => boolean;
  readonly activeOwnerComposite?: () => boolean;
  readonly delegationCommand?: NonNullable<TuiCorePort["delegationCommand"]>;
  readonly initialSnapshot?: TuiSessionSnapshot;
  readonly loadSession?: TuiCorePort["loadSession"];
  readonly rendererUpdate?: () => void;
  readonly startTask?: () => Promise<TuiCoreRunResult>;
  readonly typedSessionQueries?: boolean;
  readonly watchSession?: NonNullable<TuiCorePort["watchSession"]>;
} = {}) {
  const approvalDecisions: unknown[] = [];
  const cancelActiveRun = vi.fn();
  const startTask = vi.fn(
    input.startTask ??
      (async () => ({ diagnostic: null, exitCode: 0 } as const)),
  );
  const core: TuiCorePort = {
    ...(input.activeDelegationOwner === undefined ? {} : { activeDelegationOwner: input.activeDelegationOwner }),
    ...(input.activeOwnerComposite === undefined ? {} : { activeOwnerComposite: input.activeOwnerComposite }),
    abortActiveOwnerRun: cancelActiveRun,
    cancelActiveRun,
    ...(input.delegationCommand === undefined ? {} : { delegationCommand: input.delegationCommand }),
    loadSession: input.loadSession ?? (async () => []),
    resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
    startTask,
    ...(input.typedSessionQueries === true ? { typedSessionQueries: true } : {}),
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
    source,
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

  it("routes an explicit active Delegation dialog through the typed command without raw owner abort", async () => {
    let finishRun!: (result: TuiCoreRunResult) => void;
    const run = new Promise<TuiCoreRunResult>((resolve) => { finishRun = resolve; });
    const delegationCommand = vi.fn<NonNullable<TuiCorePort["delegationCommand"]>>(async () => ({
      diagnostic: null,
      exitCode: 0,
    }));
    const test = fixture({
      delegationCommand,
      initialSnapshot: activeDelegationSnapshot(),
      startTask: () => run,
    });

    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();
    test.controller.handleRawInput("d");
    test.controller.handleRawInput("c");
    expect(test.controller.ephemeral.delegationDecisionDialog).toMatchObject({
      action: "cancel",
      delegationId: "55555555-5555-4555-8555-555555555555",
      expectedSessionSeq: 1,
      sha256: HASH,
    });
    test.controller.handleRawInput("\t");
    test.controller.handleRawInput("\r");
    await flush();

    expect(delegationCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "cancel",
      delegationId: "55555555-5555-4555-8555-555555555555",
      expectedSessionSeq: 1,
    }));
    expect(test.cancelActiveRun).not.toHaveBeenCalled();
    finishRun({ diagnostic: "Cancelled", exitCode: 130 });
    await flush();
  });

  it("routes Ctrl+C to an exact owner-internal composite instead of treating it as idle", async () => {
    let finishRun!: (result: TuiCoreRunResult) => void;
    const run = new Promise<TuiCoreRunResult>((resolve) => { finishRun = resolve; });
    const test = fixture({
      activeOwnerComposite: () => true,
      startTask: () => run,
    });
    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();

    test.controller.handleRawInput("\u0003");
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();
    finishRun({ diagnostic: "Cancelled before effect admission", exitCode: 2 });
    await flush();
  });

  it("routes Ctrl+C to an exact pre-admission Delegation owner instead of waiting forever", async () => {
    let finishRun!: (result: TuiCoreRunResult) => void;
    const run = new Promise<TuiCoreRunResult>((resolve) => { finishRun = resolve; });
    const test = fixture({
      activeDelegationOwner: () => true,
      startTask: () => run,
    });
    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();

    test.controller.handleRawInput("\u0003");
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();
    finishRun({ diagnostic: "Delegation cancelled before admission", exitCode: 130 });
    await flush();
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

  it("refreshes an idle selected session from a typed projection after invalidation", async () => {
    let onChange: ((kind: "lock" | "session") => void) | null = null;
    const loadSession = vi.fn(async () => typedSnapshot([started(), event("run.cancelled", {}, 2)]));
    const test = fixture({
      initialSnapshot: typedSnapshot([started()]),
      loadSession,
      watchSession: async (_sessionId, change) => {
        onChange = change;
        return () => undefined;
      },
    });
    await vi.waitFor(() => expect(onChange).not.toBeNull());

    (onChange as ((kind: "lock" | "session") => void) | null)?.("session");

    await vi.waitFor(() => expect(test.controller.view.session.lastSessionSeq).toBe(2));
    expect(loadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(test.controller.view.run?.status).toBe("cancelled");
    expect(test.controller.ephemeral.sessionBusy).toBe(false);
    test.controller.stop();
  });

  it("freezes and retries a transient typed snapshot failure after a successful mutation", async () => {
    let readAttempt = 0;
    const loadSession = vi.fn(async () => {
      readAttempt += 1;
      if (readAttempt === 1) {
        throw Object.assign(new Error("application query rejected (control_operation_busy)"), {
          code: "control_operation_busy",
        });
      }
      return typedSnapshot([started(), event("run.cancelled", {}, 2)]);
    });
    const test = fixture({
      initialSnapshot: typedSnapshot([started()]),
      loadSession,
      startTask: async () => ({ diagnostic: null, exitCode: 0 }),
      typedSessionQueries: true,
    });

    test.controller.handleRawInput("next mutation");
    test.controller.handleRawInput("\r");

    await vi.waitFor(() => {
      expect(loadSession).toHaveBeenCalledTimes(2);
      expect(test.controller.view.session.lastSessionSeq).toBe(2);
      expect(test.controller.ephemeral.sessionBusy).toBe(false);
    });
    expect(test.controller.view.run?.status).toBe("cancelled");
    expect(test.renderer.stop).not.toHaveBeenCalled();
    test.controller.stop();
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

  it("requires y plus Enter for an explicit approval", async () => {
    const test = fixture();
    test.controller.acceptPersistedEvent(started());
    test.controller.acceptPersistedEvent(
      event(
        "approval.requested",
        {
          action: "run_command",
          action_sha256: HASH,
          approval_request_id: "33333333-3333-4333-8333-333333333334",
          call_id: "command-2",
          preview: "pnpm test",
          truncated: false,
        },
        2,
      ),
    );
    test.controller.handleRawInput("y");
    expect(test.controller.ephemeral.approvalFocus).toBe("allow");
    expect(test.approvalDecisions).toEqual([]);
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.approvalDecisions).toEqual([
      expect.objectContaining({ actionSha256: HASH, decision: "approved" }),
    ]);
  });

  it("preserves the exact approval focus while replaying a typed snapshot", async () => {
    const request = event(
      "approval.requested",
      {
        action: "run_command",
        action_sha256: HASH,
        approval_request_id: "33333333-3333-4333-8333-333333333335",
        call_id: "command-3",
        preview: "pnpm test",
        truncated: false,
      },
      2,
    );
    let onChange: ((kind: "lock" | "session") => void) | null = null;
    const test = fixture({
      initialSnapshot: typedSnapshot([started(), request]),
      loadSession: async () => typedSnapshot([started(), request]),
      watchSession: async (_sessionId, change) => {
        onChange = change;
        return () => undefined;
      },
    });
    await vi.waitFor(() => expect(onChange).not.toBeNull());

    test.controller.handleRawInput("y");
    expect(test.controller.ephemeral.approvalFocus).toBe("allow");
    (onChange as ((kind: "lock" | "session") => void) | null)?.("session");
    await vi.waitFor(() => expect(test.controller.ephemeral.sessionBusy).toBe(false));

    expect(test.controller.ephemeral).toMatchObject({
      approvalFocus: "allow",
      approvalRequestId: "33333333-3333-4333-8333-333333333335",
    });
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.approvalDecisions).toEqual([
      expect.objectContaining({ actionSha256: HASH, decision: "approved" }),
    ]);
    test.controller.stop();
  });

  it("allows an exact active-owner approval while new mutations are blocked", async () => {
    const request = event(
      "mcp.approval.requested",
      {
        action_kind: "mcp.tool.call",
        action_sha256: HASH,
        approval_request_id: "33333333-3333-4333-8333-333333333337",
        preview: "Call exact MCP tool",
        server_id: "offline-docs",
        truncated: false,
      },
      2,
    );
    const snapshot = typedSnapshot([started(), request]);
    const test = fixture({
      initialSnapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          taskMutationBlocker: {
            code: "session_effect_reconciliation_required",
            details: ["mcp_call:pending"],
          },
        },
      },
    });
    expect(test.controller.view.session.actionBlocked).toBe(true);
    test.controller.handleRawInput("y");
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.approvalDecisions).toEqual([
      expect.objectContaining({ actionSha256: HASH, decision: "approved" }),
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

  it("restores the app lifecycle after a renderer fatal even when the authenticated owner never settles", async () => {
    let failRendering = false;
    const neverSettles = new Promise<TuiCoreRunResult>(() => undefined);
    const test = fixture({
      rendererUpdate: () => {
        if (failRendering) throw new Error("render failed during active owner");
      },
      startTask: () => neverSettles,
    });

    test.controller.handleRawInput("task");
    test.controller.handleRawInput("\r");
    await flush();
    expect(test.startTask).toHaveBeenCalledOnce();

    failRendering = true;
    test.controller.acceptPersistedEvent(started());
    await flush();

    await expect(test.controller.waitForExit()).resolves.toBe(1);
    expect(test.cancelActiveRun).toHaveBeenCalledOnce();
  });
});
