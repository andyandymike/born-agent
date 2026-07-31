import { afterEach, describe, expect, it } from "vitest";

import { DurableAgentPlanStore } from "../../src/plans/agent-plan-store.js";
import {
  PlanMutationLedgerError,
  reconstructPlanMutationLedger,
} from "../../src/plans/plan-mutation-ledger.js";
import { planMutationRecoveryDecision } from "../../src/plans/plan-mutation-reconciler.js";
import { renderPlanToolObservation } from "../../src/plans/plan-tool-observation.js";
import {
  cleanupTemporaryWorkspaces,
  temporaryWorkspace,
} from "./phase16b-test-helpers.js";
import { createAgentMutationFixture } from "./phase16c-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

const proposal = {
  operation: "propose" as const,
  plan: {
    items: [
      {
        acceptance: "Recovery derives the same receipt.",
        id: "recover",
        required: true,
        title: "Recover receipt",
      },
    ],
    title: "Crash-safe Plan",
  },
};

describe("Phase 16C PlanMutationLedger", () => {
  it("projects request-only, applied-without-result, and closed prefixes", async () => {
    const workspace = await temporaryWorkspace();
    const fixture = await createAgentMutationFixture(workspace, proposal);

    let [entry] = reconstructPlanMutationLedger(fixture.writer.events);
    expect(entry?.state).toBe("requested");
    expect(planMutationRecoveryDecision(entry!)).toMatchObject({
      kind: "apply_request",
      sourceCallId: "update-plan-1",
    });

    const result = await new DurableAgentPlanStore(
      () => "16000000-0000-4000-8000-000000000498",
    ).applyAgentMutation(fixture.context, proposal);
    [entry] = reconstructPlanMutationLedger(fixture.writer.events);
    expect(entry?.state).toBe("applied_without_result");
    expect(planMutationRecoveryDecision(entry!)).toMatchObject({
      kind: "recover_result",
      observation: result.observation,
    });

    await fixture.publisher.publish({
      data: {
        call_id: "update-plan-1",
        duration_ms: 1,
        output: renderPlanToolObservation(result.observation),
        status: "success",
        step: 1,
        tool_name: "update_plan",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    [entry] = reconstructPlanMutationLedger(fixture.writer.events);
    expect(entry?.state).toBe("closed");
    expect(planMutationRecoveryDecision(entry!)).toEqual({ kind: "none" });
    await fixture.writer.close();
  });

  it("fails closed when a success receipt does not match the applied event", async () => {
    const workspace = await temporaryWorkspace();
    const fixture = await createAgentMutationFixture(workspace, proposal);
    await new DurableAgentPlanStore(
      () => "16000000-0000-4000-8000-000000000497",
    ).applyAgentMutation(fixture.context, proposal);
    await fixture.publisher.publish({
      data: {
        call_id: "update-plan-1",
        duration_ms: 1,
        output: "{}",
        status: "success",
        step: 1,
        tool_name: "update_plan",
        truncated: false,
      },
      type: "tool.call.completed",
    });

    expect(() => reconstructPlanMutationLedger(fixture.writer.events)).toThrow(
      PlanMutationLedgerError,
    );
    await fixture.writer.close();
  });
});
