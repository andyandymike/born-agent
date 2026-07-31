import { afterEach, describe, expect, it } from "vitest";

import { DurableAgentPlanStore } from "../../src/plans/agent-plan-store.js";
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
        acceptance: "The mutation is paired and replayable.",
        id: "pairing",
        required: true,
        title: "Implement mutation pairing",
      },
    ],
    title: "Phase 16C",
  },
};

describe("Phase 16C Agent-only PlanStore", () => {
  it("applies a Plan-mode proposal once with call_id as mutation identity", async () => {
    const workspace = await temporaryWorkspace();
    const fixture = await createAgentMutationFixture(workspace, proposal);
    const store = new DurableAgentPlanStore(
      () => "16000000-0000-4000-8000-000000000499",
    );

    const result = await store.applyAgentMutation(fixture.context, proposal);

    expect(result).toMatchObject({
      control: null,
      mutationId: "update-plan-1",
      status: "applied",
    });
    expect(renderPlanToolObservation(result.observation)).toContain(
      '"requires_user_approval":true',
    );
    const committed = fixture.writer.events.find(
      (event) => event.type === "plan.proposed",
    );
    expect(committed).toMatchObject({
      data: {
        origin: {
          call_id: "update-plan-1",
          kind: "agent",
          mutation_id: "update-plan-1",
        },
      },
    });
    await expect(
      store.applyAgentMutation(fixture.context, proposal),
    ).rejects.toThrow(/already committed/u);
    await fixture.writer.close();
  });

  it("rejects operation authority without writing a Plan event", async () => {
    const workspace = await temporaryWorkspace();
    const fixture = await createAgentMutationFixture(workspace, proposal);
    const before = fixture.writer.events.length;
    const result = await new DurableAgentPlanStore().applyAgentMutation(
      { ...fixture.context, agentMode: "build" },
      proposal,
    );

    expect(result).toMatchObject({
      eventId: null,
      observation: { code: "plan_propose_not_allowed" },
      status: "rejected",
    });
    expect(fixture.writer.events).toHaveLength(before);
    await fixture.writer.close();
  });
});
