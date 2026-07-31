import { afterEach, describe, expect, it } from "vitest";

import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import { DurableAgentPlanStore } from "../../src/plans/agent-plan-store.js";
import { createUpdatePlanTool } from "../../src/plans/update-plan-tool.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import {
  cleanupTemporaryWorkspaces,
  temporaryWorkspace,
} from "../unit/phase16b-test-helpers.js";
import { createAgentMutationFixture } from "../unit/phase16c-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

describe("Phase 16C update_plan tool adapter", () => {
  it("uses the normal strict ToolRegistry while preserving the exact observation", async () => {
    const workspace = await temporaryWorkspace();
    const input = {
      operation: "propose" as const,
      plan: {
        items: [
          {
            acceptance: "The strict registry returns the durable receipt.",
            id: "tool-adapter",
            required: true,
            title: "Verify tool adapter",
          },
        ],
        title: "Tool adapter",
      },
    };
    const fixture = await createAgentMutationFixture(workspace, input);
    const results: unknown[] = [];
    const registry = new ToolRegistry([
      createUpdatePlanTool({
        context: () => fixture.context,
        onResult: (result) => results.push(result),
        store: new DurableAgentPlanStore(
          () => "16000000-0000-4000-8000-000000000496",
        ),
      }),
    ]);

    expect(registry.modelDefinitions).toEqual([
      expect.objectContaining({ name: "update_plan", strict: true }),
    ]);
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify(input),
        callId: "update-plan-1",
        name: "update_plan",
        step: 1,
      },
      new AbortController().signal,
    );

    expect(execution).toMatchObject({ ok: true, truncated: false });
    expect(execution.control).toBeUndefined();
    expect(JSON.parse(execution.output)).toMatchObject({
      operation: "propose",
      requires_user_approval: true,
      status: "applied",
    });
    expect(results).toHaveLength(1);
    await fixture.writer.close();
  });

  it("returns a typed pause control for a Build-mode Plan revision", async () => {
    const workspace = await temporaryWorkspace();
    const proposed = {
      operation: "propose" as const,
      plan: {
        items: [
          {
            acceptance: "The initial plan is durable.",
            id: "initial",
            required: true,
            title: "Initial work",
          },
        ],
        title: "Initial Plan",
      },
    };
    const fixture = await createAgentMutationFixture(workspace, proposed);
    const store = new DurableAgentPlanStore(
      () => "16000000-0000-4000-8000-000000000497",
    );
    await store.applyAgentMutation(fixture.context, proposed);
    const state = fixture.context.writer.events;
    const proposedEvent = state.find(
      (event): event is Extract<(typeof state)[number], { type: "plan.proposed" }> =>
        event.type === "plan.proposed",
    )!;
    await fixture.writer.appendTaskEvent("plan.approved", {
      goal_id: fixture.goalId,
      goal_revision: 1,
      origin: { input_surface: "cli", kind: "user" },
      plan_id: proposedEvent.data.content.planId,
      plan_sha256: proposedEvent.data.plan_sha256,
      revision: 1,
    });
    const revision = {
      base_plan_id: proposedEvent.data.content.planId,
      base_revision: 1,
      base_sha256: proposedEvent.data.plan_sha256,
      operation: "revise" as const,
      plan: {
        items: [
          {
            acceptance: "The revised plan is reviewed before execution.",
            id: "revised",
            required: true,
            title: "Revised work",
          },
        ],
        title: "Revised Plan",
      },
    };
    const tool = createUpdatePlanTool({
      context: () => ({
        ...fixture.context,
        agentMode: "build",
        callId: "update-plan-revise",
        step: 2,
        taskStateBeforeCall: TaskStateMachine.project(fixture.writer.events),
      }),
      store,
    });
    await fixture.publisher.publish({
      data: {
        arguments_json: JSON.stringify(revision),
        call_id: "update-plan-revise",
        step: 2,
        tool_name: "update_plan",
      },
      type: "tool.call.requested",
    });
    const registry = new ToolRegistry([tool]);
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify(revision),
        callId: "update-plan-revise",
        name: "update_plan",
        step: 2,
      },
      new AbortController().signal,
    );

    expect(execution.control).toMatchObject({
      kind: "plan_revision_proposed",
      reason: "plan_approval_required",
      revision: 2,
    });
    await fixture.writer.close();
  });
});
