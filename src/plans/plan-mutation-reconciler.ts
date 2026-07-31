import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { PlanMutationControl } from "./agent-plan-store.js";
import type { PlanMutationLedgerEntry } from "./plan-mutation-ledger.js";
import { renderPlanToolObservation } from "./plan-tool-observation.js";

export type PlanMutationRecoveryDecision =
  | { readonly kind: "none" }
  | {
      readonly input: PlanMutationLedgerEntry["input"];
      readonly kind: "apply_request";
      readonly sourceCallId: string;
      readonly sourceRunId: string;
    }
  | {
      readonly control: PlanMutationControl | null;
      readonly kind: "recover_result";
      readonly observation: NonNullable<PlanMutationLedgerEntry["observation"]>;
      readonly sourceCallId: string;
      readonly sourceRunId: string;
    };

export function planMutationRecoveryDecision(
  entry: PlanMutationLedgerEntry,
): PlanMutationRecoveryDecision {
  switch (entry.state) {
    case "closed":
      return Object.freeze({ kind: "none" });
    case "requested":
      return Object.freeze({
        input: entry.input,
        kind: "apply_request",
        sourceCallId: entry.request.data.call_id,
        sourceRunId: entry.sourceRunId,
      });
    case "applied_without_result":
      if (entry.observation === null) {
        throw new Error("applied plan mutation has no derived observation");
      }
      return Object.freeze({
        control: entry.control,
        kind: "recover_result",
        observation: entry.observation,
        sourceCallId: entry.request.data.call_id,
        sourceRunId: entry.sourceRunId,
      });
  }
}

export async function appendRecoveredPlanMutationResult(input: {
  readonly adoptedCallId: string;
  readonly decision: Extract<
    PlanMutationRecoveryDecision,
    { kind: "recover_result" }
  >;
  readonly runId: string;
  readonly step: number;
  readonly writer: V2SessionWriter;
}): Promise<PlanMutationControl | null> {
  await input.writer.appendRunEvent(input.runId, "tool.call.recovered", {
    call_id: input.adoptedCallId,
    duration_ms: 0,
    output: renderPlanToolObservation(input.decision.observation),
    source_run_id: input.decision.sourceRunId,
    status: "success",
    step: input.step,
    tool_name: "update_plan",
    truncated: false,
  });
  return input.decision.control;
}
