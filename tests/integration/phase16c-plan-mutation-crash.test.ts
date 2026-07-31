import { afterEach, describe, expect, it } from "vitest";

import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import { DurableAgentPlanStore } from "../../src/plans/agent-plan-store.js";
import { reconstructPlanMutationLedger } from "../../src/plans/plan-mutation-ledger.js";
import { planMutationRecoveryDecision } from "../../src/plans/plan-mutation-reconciler.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
} from "../unit/phase16b-test-helpers.js";
import { createAgentMutationFixture } from "../unit/phase16c-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

describe("Phase 16C update_plan crash recovery", () => {
  it("reopens an applied-without-result prefix and never applies its revision twice", async () => {
    const workspace = await temporaryWorkspace();
    const input = {
      operation: "propose" as const,
      plan: {
        items: [
          {
            acceptance: "A reopened prefix has exactly one Plan revision.",
            id: "apply-once",
            required: true,
            title: "Apply once",
          },
        ],
        title: "Crash recovery",
      },
    };
    const fixture = await createAgentMutationFixture(workspace, input);
    const store = new DurableAgentPlanStore(
      () => "16000000-0000-4000-8000-000000000495",
    );
    await store.applyAgentMutation(fixture.context, input);
    await fixture.writer.close();

    const reopened = await V2SessionWriter.openExisting(workspace, SESSION_ID);
    const [entry] = reconstructPlanMutationLedger(reopened.events);
    expect(entry?.state).toBe("applied_without_result");
    expect(planMutationRecoveryDecision(entry!)).toMatchObject({
      kind: "recover_result",
    });
    const state = TaskStateMachine.project(reopened.events);
    expect(state.plans).toHaveLength(1);
    await expect(
      store.applyAgentMutation(
        {
          ...fixture.context,
          taskStateBeforeCall: state,
          writer: reopened,
        },
        input,
      ),
    ).rejects.toThrow(/already committed/u);
    expect(TaskStateMachine.project(reopened.events).plans).toHaveLength(1);
    await reopened.close();
  });
});
