import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "../unit/phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

describe("Phase 16B Goal/Plan CLI", () => {
  it("adopts, proposes, stale-rejects, exact-approves, and replays with zero model/tool calls", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(
      join(workspace, "plan.json"),
      JSON.stringify({
        items: [
          {
            acceptance: "The CLI flow replays exactly.",
            id: "cli-flow",
            required: true,
            title: "Verify the CLI flow",
          },
        ],
        schema_version: 1,
        title: "CLI control plane",
      }),
      "utf8",
    );
    const runtime = createRuntime({ cwd: workspace });
    const model = vi.spyOn(runtime, "createModelBackend");
    const agentTools = vi.spyOn(runtime, "createAgentToolRegistry");
    const readTools = vi.spyOn(runtime, "createToolRegistry");

    let io = createMemoryIO();
    expect(
      await runCli(
        ["goal", "set", SESSION_ID, "--text", "Implement the control plane"],
        io.io,
        runtime,
      ),
    ).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;

    io = createMemoryIO();
    expect(
      await runCli(
        [
          "plan",
          "replace",
          SESSION_ID,
          "--goal-id",
          goal.content.goalId,
          "--goal-revision",
          "1",
          "--file",
          "plan.json",
        ],
        io.io,
        runtime,
      ),
    ).toBe(0);
    const proposed = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    const sessionPath = join(workspace, ".bornagent", "sessions", `${SESSION_ID}.jsonl`);
    const beforeStale = await readFile(sessionPath, "utf8");

    io = createMemoryIO();
    expect(
      await runCli(
        [
          "plan",
          "approve",
          SESSION_ID,
          "--goal-id",
          goal.content.goalId,
          "--goal-revision",
          "1",
          "--plan-id",
          proposed.planId,
          "--revision",
          "1",
          "--sha256",
          "0".repeat(64),
        ],
        io.io,
        runtime,
      ),
    ).toBe(2);
    expect(await readFile(sessionPath, "utf8")).toBe(beforeStale);

    io = createMemoryIO();
    expect(
      await runCli(
        [
          "plan",
          "approve",
          SESSION_ID,
          "--goal-id",
          goal.content.goalId,
          "--goal-revision",
          "1",
          "--plan-id",
          proposed.planId,
          "--revision",
          "1",
          "--sha256",
          proposed.planSha256,
        ],
        io.io,
        runtime,
      ),
    ).toBe(0);

    io = createMemoryIO();
    expect(
      await runCli(["plan", "show", SESSION_ID, "--json"], io.io, runtime),
    ).toBe(0);
    const shown = JSON.parse(io.readStdout()) as Record<string, unknown>;
    expect(shown).toMatchObject({
      currentApprovedPlan: {
        planId: proposed.planId,
        planSha256: proposed.planSha256,
        revision: 1,
      },
      trackingMode: "phase16",
    });
    expect(model).not.toHaveBeenCalled();
    expect(agentTools).not.toHaveBeenCalled();
    expect(readTools).not.toHaveBeenCalled();
  });
});
