import { randomUUID } from "node:crypto";

import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { GoalManager } from "../../src/goals/goal-manager.js";
import type { AgentPlanMutationContext } from "../../src/plans/agent-plan-store.js";
import type { UpdatePlanInput } from "../../src/plans/update-plan-input-schema.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  context,
  RUN_ID,
  SESSION_ID,
  writeLegacySession,
} from "./phase16b-test-helpers.js";

export const ACTIVE_RUN_ID = "16000000-0000-4000-8000-000000000402";

export async function createAgentMutationFixture(
  workspace: string,
  input: UpdatePlanInput,
  callId = "update-plan-1",
): Promise<{
  readonly context: AgentPlanMutationContext;
  readonly goalId: string;
  readonly publisher: EventPublisher;
  readonly writer: V2SessionWriter;
}> {
  await writeLegacySession(workspace);
  const goal = await new GoalManager().createInitialGoal({
    context: context(workspace),
    objective: "Implement Phase 16C",
  });
  const writer = await V2SessionWriter.openExisting(workspace, SESSION_ID);
  await writer.appendSessionEvent("session.resume.requested", {
    requested_mode: "exact",
    source_run_id: RUN_ID,
  });
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: ACTIVE_RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => "2026-07-31T01:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "plan the work" },
      model: "fake-model",
      provider: "fake",
      resume_mode: "exact",
      resume_of_run_id: RUN_ID,
      timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "deterministic-fake",
      adapter_version: "phase16c-test-v1",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "b".repeat(64),
      model: "fake-model",
      provider: "fake",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
  await publisher.publish({
    data: {
      arguments_json: JSON.stringify(input),
      call_id: callId,
      step: 1,
      tool_name: "update_plan",
    },
    type: "tool.call.requested",
  });
  return {
    context: {
      activeGoal: { goalId: goal.content.goalId, revision: 1 },
      agentMode: "plan",
      callId,
      runId: ACTIVE_RUN_ID,
      sessionId: SESSION_ID,
      step: 1,
      taskStateBeforeCall: TaskStateMachine.project(writer.events),
      writer,
    },
    goalId: goal.content.goalId,
    publisher,
    writer,
  };
}
