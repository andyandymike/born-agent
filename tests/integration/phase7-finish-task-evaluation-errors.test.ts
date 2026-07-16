import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createFinishTaskTool } from "../../src/completion/finish-task-tool.js";
import type {
  CompletionPolicy,
  CompletionState,
} from "../../src/completion/completion-types.js";
import type { AgentToolRegistryOptions } from "../../src/tools/create-agent-tool-registry.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ToolDefinition } from "../../src/tools/tool-types.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  InMemorySessionWriter,
} from "../helpers.js";

type FailurePoint = "policy" | "state";

function failingClient(): FakeStreamingChatClient {
  return new FakeStreamingChatClient(async function* (request) {
    expect(request.tools.map((tool) => tool.name)).toEqual(["finish_task"]);
    yield {
      call: {
        argumentsJson: JSON.stringify({
          status: "completed",
          summary: "The requested change is complete.",
        }),
        callId: "call_finish_error",
        name: "finish_task",
      },
      type: "tool_call",
    };
    yield {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    };
    yield {
      continuation: new FakeContinuation("finish-error"),
      providerResponseId: "resp_finish_error",
      type: "turn_completed",
    };
  });
}

function emptyCompletionState(
  options: AgentToolRegistryOptions,
): CompletionState {
  return {
    activity: {
      activeApproval: false,
      activeCommand: false,
      activePatch: false,
      mutationMutexLocked: false,
      unknownSideEffect: false,
    },
    changedByRun: [],
    diffCheck: {
      checkedPaths: [],
      detail: "not evaluated",
      diffSha256: "0".repeat(64),
      status: "not_run",
    },
    finalSnapshot: null,
    generation: 0,
    journal: {
      consistent: true,
      postimagesMatchDisk: true,
      readable: true,
    },
    modelEvidence: options.modelEvidence,
    preExistingDirtyPaths: [],
    runId: options.runId,
    sessionId: options.sessionId,
    verifications: [],
  };
}

function failingRegistry(
  failurePoint: FailurePoint,
): (options: AgentToolRegistryOptions) => Promise<ToolRegistry> {
  return async (options) => {
    const policy: CompletionPolicy = {
      evaluate: async () => {
        if (failurePoint === "policy") {
          throw new Error("synthetic policy failure");
        }
        return { effect: "continue", reasons: ["verification_missing"] };
      },
    };
    const tool = createFinishTaskTool({
      policy,
      publisher: options.publisher,
      state: async () => {
        if (failurePoint === "state") {
          throw new Error("synthetic state failure");
        }
        return emptyCompletionState(options);
      },
    });
    return new ToolRegistry([tool as ToolDefinition<unknown>]);
  };
}

async function runFailure(
  failurePoint: FailurePoint,
  writer: InMemorySessionWriter,
) {
  const memory = createMemoryIO();
  const exitCode = await runCli(
    [
      "agent",
      "complete the local fixture",
      "--provider",
      "ollama",
      "--task-profile",
      "coding",
    ],
    memory.io,
    createRuntime({
      createAgentToolRegistry: failingRegistry(failurePoint),
      createModelTurnClient: () => failingClient(),
      createSessionWriter: async () => writer,
      env: {},
    }),
  );
  return { exitCode, memory };
}

describe("Phase 7 finish_task evaluation failure pairing", () => {
  it.each(["state", "policy"] as const)(
    "closes the candidate, tool call, and run after a %s failure",
    async (failurePoint) => {
      const writer = new InMemorySessionWriter();
      const result = await runFailure(failurePoint, writer);

      expect(result.exitCode).toBe(1);
      expect(writer.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "completion.candidate" }),
          expect.objectContaining({
            data: expect.objectContaining({
              effect: "error",
              error_code: "completion_evaluation_failed",
            }),
            type: "completion.evaluated",
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              error_category: "system",
              error_code: "completion_evaluation_failed",
              status: "error",
              tool_name: "finish_task",
            }),
            type: "tool.call.completed",
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              code: "completion_evaluation_failed",
              tool_calls: 1,
            }),
            type: "run.failed",
          }),
        ]),
      );
      expect(reconstructSession(writer.events).terminal).toMatchObject({
        data: { code: "completion_evaluation_failed", tool_calls: 1 },
        type: "run.failed",
      });
    },
  );

  it("keeps a failed error-evaluation write at the fatal storage boundary", async () => {
    const writer = new InMemorySessionWriter(
      "memory://completion-evaluation-storage-failure.jsonl",
      (event) => {
        if (
          event.type === "completion.evaluated" &&
          event.data.effect === "error"
        ) {
          throw new Error("synthetic storage failure");
        }
      },
    );
    const result = await runFailure("state", writer);

    expect(result.exitCode).toBe(1);
    expect(result.memory.readStderr()).toContain("session storage failed");
    expect(writer.events.at(-1)?.type).toBe("completion.candidate");
    expect(
      writer.events.some(
        (event) =>
          event.type === "tool.call.completed" ||
          event.type.startsWith("run.") && event.type !== "run.started",
      ),
    ).toBe(false);
  });
});
