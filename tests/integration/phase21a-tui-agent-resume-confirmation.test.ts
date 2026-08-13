import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCommandOptions } from "../../src/agent/agent-types.js";
import { runCli } from "../../src/cli/run-cli.js";
import { executeSessionsResume } from "../../src/commands/sessions.js";
import {
  executeAgentThroughApplicationService,
  executeExistingSessionAgentThroughApplicationService,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { registerPreparedApplicationActionReviewer } from "../../src/control-plane/adapters/prepared-action-reviewer.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

function tuiOptions(task: string): AgentCommandOptions {
  return {
    commandApproval: undefined,
    commandTimeoutMs: undefined,
    completionPolicy: undefined,
    editApproval: undefined,
    inputSurface: "tui",
    maxDurationMs: undefined,
    maxCommandOutputBytes: undefined,
    maxSteps: "1",
    maxTokens: undefined,
    maxToolOutputBytes: undefined,
    model: "qwen3:1.7b",
    mode: "build",
    modeSource: "explicit_tui",
    provider: "ollama",
    reportFormat: undefined,
    requestTimeoutMs: undefined,
    requireVerification: undefined,
    task,
    taskProfile: "read-only",
    verbose: false,
  };
}

async function completedSession(prefix: string) {
  const cwd = await directory(`bornagent-phase21a-${prefix}-repo-`);
  const controlPlaneStateRoot = await directory(`bornagent-phase21a-${prefix}-state-`);
  const createModelBackend = vi.fn(
    (request: { readonly model: string; readonly provider: string }) =>
      new FakeStreamingChatClient(fixedStream(["bounded answer"]), {
        model: request.model,
        provider: request.provider as "anthropic" | "ollama" | "openai",
      }),
  );
  const runtime = createRuntime({ controlPlaneStateRoot, createModelBackend, cwd });
  const output = createMemoryIO();
  expect(await runCli([
    "agent",
    "create a completed session for TUI confirmation",
    "--task-profile",
    "read-only",
    "--provider",
    "ollama",
    "--model",
    "qwen3:1.7b",
  ], output.io, runtime), output.readStderr()).toBe(0);
  const file = (await readdir(join(cwd, ".bornagent", "sessions")))
    .find((candidate) => candidate.endsWith(".jsonl"));
  if (file === undefined) throw new Error("session fixture is unavailable");
  const path = join(cwd, ".bornagent", "sessions", file);
  return {
    controlPlaneStateRoot,
    createModelBackend,
    path,
    runtime,
    sessionId: file.slice(0, -".jsonl".length),
  };
}

describe("Phase 21A TUI Agent/resume prepared confirmation", () => {
  it("shows a new-session message before commit and never starts the model when cancelled", async () => {
    const cwd = await directory("bornagent-phase21a-new-message-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-new-message-state-");
    const createModelBackend = vi.fn();
    const runtime = createRuntime({ controlPlaneStateRoot, createModelBackend, cwd });
    const output = createMemoryIO();
    const reviewedKinds: string[] = [];
    const unregister = registerPreparedApplicationActionReviewer(runtime, async (review) => {
      reviewedKinds.push(review.actionKind);
      if (review.actionKind !== "session.message.submit") return "confirmed";
      const plane = await createPhase21ALocalControlPlane({
        launcher: { launch: async () => { throw new Error("review must not launch"); } },
        stateRoot: controlPlaneStateRoot,
      });
      expect((await plane.operations.list()).some((operation) =>
        operation.actionKind === "session.message.submit"
      )).toBe(false);
      expect(createModelBackend).not.toHaveBeenCalled();
      return "cancelled";
    });
    try {
      expect(await executeAgentThroughApplicationService(
        tuiOptions("do not start before the TUI confirmation"),
        runtime,
        output.io,
      )).toBe(2);
    } finally {
      unregister();
    }

    expect(reviewedKinds).toEqual([
      "repository.register",
      "session.message.submit",
    ]);
    expect(createModelBackend).not.toHaveBeenCalled();
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: controlPlaneStateRoot,
    });
    expect((await plane.operations.list()).map((operation) => operation.actionKind).sort()).toEqual([
      "repository.register",
      "session.create",
    ]);
  });

  it("keeps existing-session message and resume at zero mutation before confirmation", async () => {
    const test = await completedSession("existing-message-resume");
    const baselineEvents = await readStoredSession(test.path);
    const baselineModelCalls = test.createModelBackend.mock.calls.length;
    const decisions = ["session.message.submit", "session.resume"];
    const reviewed: string[] = [];
    const unregister = registerPreparedApplicationActionReviewer(test.runtime, async (review) => {
      reviewed.push(review.actionKind);
      expect(review.actionKind).toBe(decisions[reviewed.length - 1]);
      expect(await readStoredSession(test.path)).toHaveLength(baselineEvents.length);
      expect(test.createModelBackend).toHaveBeenCalledTimes(baselineModelCalls);
      return "cancelled";
    });
    try {
      const messageOutput = createMemoryIO();
      expect(await executeExistingSessionAgentThroughApplicationService({
        expectedSessionSeq: baselineEvents.length,
        options: tuiOptions("continue only after exact TUI review"),
        sessionId: test.sessionId,
      }, test.runtime, messageOutput.io)).toBe(2);

      const resumeOutput = createMemoryIO();
      expect(await executeSessionsResume({
        allowDegradedResume: true,
        inputSurface: "tui",
        message: "resume only after exact TUI review",
        sessionId: test.sessionId,
      }, test.runtime, resumeOutput.io)).toBe(2);
    } finally {
      unregister();
    }

    expect(reviewed).toEqual(decisions);
    expect(await readStoredSession(test.path)).toEqual(baselineEvents);
    expect(test.createModelBackend).toHaveBeenCalledTimes(baselineModelCalls);
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: test.controlPlaneStateRoot,
    });
    expect((await plane.operations.list()).some((operation) =>
      operation.actionKind === "session.resume"
    )).toBe(false);
  }, 30_000);
});
