import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  executeTaskActionThroughApplicationService,
  requestActiveDelegationCancelThroughApplicationService,
  type TaskApplicationActionResultV1,
} from "../control-plane/adapters/task-cli-adapter.js";
import { isGraphCompositePreEffectTerminalResult } from "../control-plane/use-cases/graph-composite-actions.js";

export type TuiGraphApplicationIntentV1 =
  | Readonly<{ expectedSessionSeq: number; revision: number; sessionId: string; sha256: string; type: "approve" }>
  | Readonly<{ background: boolean; expectedSessionSeq: number; revision: number; sessionId: string; sha256: string; type: "enqueue" }>
  | Readonly<{ background: boolean; expectedSessionSeq: number; revision: number; sessionId: string; sha256: string; type: "run" }>
  | Readonly<{ expectedSessionSeq: number; reason: string; revision: number; sessionId: string; sha256: string; type: "cancel" }>
  | Readonly<{ background: boolean; expectedSessionSeq: number; revision: number; sessionId: string; sha256: string; type: "resume" }>
  | Readonly<{ expectedSessionSeq: number; promotionOperation: string; revision: number; sessionId: string; sha256: string; type: "verify_origin" }>
  | Readonly<{ attemptId: string; expectedSessionSeq: number; nodeId: string; revision: number; sessionId: string; sha256: string; type: "promote" }>;

export interface TuiDelegationApplicationIntentV1 {
  readonly action: "approve" | "cancel" | "reject" | "start_or_resume";
  readonly delegationId: string;
  readonly expectedSessionSeq: number;
  readonly reason: string | null;
  readonly revision: number;
  readonly sessionId: string;
  readonly sha256: string;
}

export interface TuiApplicationActionResultV1 {
  readonly diagnostic: string | null;
  readonly exitCode: number;
}

function resultForTui(result: TaskApplicationActionResultV1<unknown>): TuiApplicationActionResultV1 {
  const error = result.envelope.error;
  const preEffectTerminal = isGraphCompositePreEffectTerminalResult(result.envelope.result)
    ? result.envelope.result
    : null;
  return Object.freeze({
    diagnostic: error !== null
      ? `${error.code}: ${error.message}`
      : preEffectTerminal === null
        ? null
        : `${preEffectTerminal.actionKind} ${preEffectTerminal.outcome} before effect admission`,
    exitCode: preEffectTerminal === null
      ? result.exitCode
      : preEffectTerminal.outcome === "cancelled" ? 130 : 2,
  });
}

async function execute(input: Readonly<{
  readonly actionKind: Parameters<typeof executeTaskActionThroughApplicationService>[0]["actionKind"];
  readonly expectedSessionSeq: number;
  readonly io: CliIO;
  readonly payload: unknown;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<TaskApplicationActionResultV1<unknown>> {
  return executeTaskActionThroughApplicationService({
    actionKind: input.actionKind,
    expectedSessionSeq: input.expectedSessionSeq,
    io: input.io,
    payload: input.payload,
    runtime: input.runtime,
    sessionId: input.sessionId,
    surface: "tui",
  });
}

/**
 * PHASE21: the TUI submits a typed application action and consumes its typed
 * envelope. It never invokes a CLI command, reconstructs command-line flags,
 * or parses another surface's stdout/stderr to decide whether authority moved.
 */
export async function executeTuiGraphApplicationAction(
  intent: TuiGraphApplicationIntentV1,
  runtime: CliRuntime,
  io: CliIO,
): Promise<TuiApplicationActionResultV1> {
  const common = {
    expectedSessionSeq: intent.expectedSessionSeq,
    io,
    runtime,
    sessionId: intent.sessionId,
  } as const;
  switch (intent.type) {
    case "approve":
      return resultForTui(await execute({
        ...common,
        actionKind: "graph.decide",
        payload: { decision: "approve", revision: intent.revision, sha256: intent.sha256 },
      }));
    case "enqueue":
      return resultForTui(await execute({
        ...common,
        actionKind: "graph.enqueue",
        payload: {
          requestedExecution: intent.background ? "background" : "foreground",
          revision: intent.revision,
          runtimeProfileId: "local-free",
          sha256: intent.sha256,
        },
      }));
    case "run":
      return resultForTui(await execute({
        ...common,
        actionKind: "graph.run",
        payload: {
          execution: intent.background ? "background" : "foreground",
          revision: intent.revision,
          sha256: intent.sha256,
        },
      }));
    case "cancel":
      return resultForTui(await execute({
        ...common,
        actionKind: "graph.cancel",
        payload: { reason: intent.reason, revision: intent.revision, sha256: intent.sha256 },
      }));
    case "resume":
      return resultForTui(await execute({
        ...common,
        actionKind: "graph.resume",
        payload: {
          execution: intent.background ? "background" : "foreground",
          revision: intent.revision,
          sha256: intent.sha256,
          takeover: false,
        },
      }));
    case "promote":
      return resultForTui(await execute({
        ...common,
        actionKind: "promotion.apply",
        payload: {
          attemptId: intent.attemptId,
          nodeId: intent.nodeId,
          revision: intent.revision,
          sha256: intent.sha256,
        },
      }));
    case "verify_origin":
      return resultForTui(await execute({
        ...common,
        actionKind: "promotion.verify_origin",
        payload: {
          promotionOperationId: intent.promotionOperation,
          revision: intent.revision,
          sha256: intent.sha256,
        },
      }));
  }
}

/** A decision+enqueue flow is two explicit application operations, never one CLI shortcut. */
export async function executeTuiDelegationApplicationAction(
  intent: TuiDelegationApplicationIntentV1,
  runtime: CliRuntime,
  io: CliIO,
): Promise<TuiApplicationActionResultV1> {
  const common = {
    expectedSessionSeq: intent.expectedSessionSeq,
    io,
    runtime,
    sessionId: intent.sessionId,
  } as const;
  if (intent.action === "reject") {
    return resultForTui(await execute({
      ...common,
      actionKind: "delegation.decide",
      payload: {
        decision: "reject",
        delegationId: intent.delegationId,
        reason: intent.reason ?? "Rejected from TUI",
        revision: intent.revision,
        sha256: intent.sha256,
      },
    }));
  }
  if (intent.action === "cancel") {
    return resultForTui(await requestActiveDelegationCancelThroughApplicationService({
      delegationId: intent.delegationId,
      io,
      reason: intent.reason ?? "Cancelled from TUI",
      runtime,
      sessionId: intent.sessionId,
      surface: "tui",
    }));
  }
  if (intent.action === "start_or_resume") {
    return resultForTui(await execute({
      ...common,
      actionKind: "delegation.resume",
      payload: { delegationId: intent.delegationId },
    }));
  }

  const decided = await execute({
    ...common,
    actionKind: "delegation.decide",
    payload: {
      decision: "approve",
      delegationId: intent.delegationId,
      revision: intent.revision,
      sha256: intent.sha256,
    },
  });
  if (decided.exitCode !== 0) return resultForTui(decided);
  if (decided.envelope.ledgerHead === null) {
    return Object.freeze({
      diagnostic: "control_operation_corrupt: delegation decision returned no session ledger head",
      exitCode: 1,
    });
  }
  return resultForTui(await execute({
    ...common,
    actionKind: "delegation.enqueue",
    expectedSessionSeq: decided.envelope.ledgerHead.sequence,
    payload: { delegationId: intent.delegationId },
  }));
}
