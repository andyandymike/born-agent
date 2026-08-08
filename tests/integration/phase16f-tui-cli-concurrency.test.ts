import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { ApprovalController } from "../../src/tui/approval-controller.js";
import { PersistedEventSource } from "../../src/tui/persisted-event-source.js";
import type { PiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import { SessionFileWatcher } from "../../src/tui/session-file-watcher.js";
import {
  TuiController,
  type TuiCorePort,
} from "../../src/tui/tui-controller.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "../unit/phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

async function runChildCli(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  const cliEntry = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cliEntry, ...args],
    {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stderr };
}

describe("Phase 16F TUI/CLI writer concurrency", () => {
  it("auto-refreshes an idle TUI after an external CLI Plan approval", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(
      join(workspace, "plan.json"),
      JSON.stringify({
        items: [
          {
            acceptance: "The external approval becomes visible without restarting.",
            id: "observe-external-approval",
            required: true,
            title: "Observe the external Plan approval",
          },
        ],
        schema_version: 1,
        title: "External approval refresh",
      }),
      "utf8",
    );
    const runtime = createRuntime({ cwd: workspace });
    let io = createMemoryIO();
    expect(
      await runCli(
        ["goal", "set", SESSION_ID, "--text", "Observe external approval"],
        io.io,
        runtime,
      ),
    ).toBe(0);
    const catalog = new SessionCatalog(workspace);
    const goal = (await catalog.read(SESSION_ID)).taskState.goals[0]!;
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
    const before = await catalog.read(SESSION_ID);
    const proposed = before.taskState.pendingDraft!;

    const controllerRef: { current?: TuiController } = {};
    const source = new PersistedEventSource({
      onEvent: (event) => controllerRef.current?.acceptPersistedEvent(event),
      onFatal: () => controllerRef.current?.handleSourceFatal(),
    });
    const watcher = new SessionFileWatcher(workspace, { debounceMs: 5 });
    let refreshes = 0;
    let initialRefreshCompleted = false;
    const core: TuiCorePort = {
      cancelActiveRun: () => undefined,
      loadSession: async (sessionId) => {
        refreshes += 1;
        const snapshot = (await catalog.read(sessionId))
          .events as readonly TuiPersistedEvent[];
        initialRefreshCompleted = true;
        return snapshot;
      },
      resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
      startTask: async () => ({ diagnostic: null, exitCode: 0 }),
      watchSession: (sessionId, onChange, onError) =>
        watcher.watch(sessionId, { onChange, onError }),
    };
    const renderer: PiTuiRenderer = {
      start: vi.fn(),
      stop: vi.fn(),
      update: vi.fn(),
    };
    const approvals = new ApprovalController(
      () => controllerRef.current!.view,
      { decideApproval: async () => undefined },
    );
    const controller = new TuiController({
      approvalController: approvals,
      core,
      renderer,
      source,
    });
    controllerRef.current = controller;
    controller.start(before.events as readonly TuiPersistedEvent[]);
    await vi.waitFor(() => {
      expect(refreshes).toBeGreaterThan(0);
      expect(initialRefreshCompleted).toBe(true);
    });

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
      io.readStderr(),
    ).toBe(0);

    await vi.waitFor(() => {
      expect(controller.view.taskState.pendingDraft).toBeNull();
      expect(controller.view.taskState.currentApprovedPlan).toMatchObject({
        planId: proposed.planId,
        revision: 1,
      });
    });
    expect(controller.ephemeral.sessionBusy).toBe(false);
    expect(renderer.stop).not.toHaveBeenCalled();
    controller.stop();
    expect(renderer.stop).toHaveBeenCalledOnce();
  });

  it("rejects a real child-process Plan mutation while the run-owned writer is active", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(
      join(workspace, "plan.json"),
      JSON.stringify({
        items: [
          {
            acceptance: "The competing mutation writes no event.",
            id: "exclusive-writer",
            required: true,
            title: "Keep the session writer exclusive",
          },
        ],
        schema_version: 1,
        title: "Exclusive task mutation",
      }),
      "utf8",
    );
    const runtime = createRuntime({ cwd: workspace });
    let io = createMemoryIO();
    expect(
      await runCli(
        ["goal", "set", SESSION_ID, "--text", "Prove exclusive mutation"],
        io.io,
        runtime,
      ),
    ).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState
      .goals[0]!;
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
    const proposed = (await new SessionCatalog(workspace).read(SESSION_ID))
      .taskState.pendingDraft!;
    const sessionPath = join(
      workspace,
      ".bornagent",
      "sessions",
      `${SESSION_ID}.jsonl`,
    );
    const before = await readFile(sessionPath, "utf8");
    const activeWriter = await V2SessionWriter.openExisting(
      workspace,
      SESSION_ID,
    );

    try {
      const child = await runChildCli(workspace, [
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
      ]);
      expect(child.exitCode).toBe(2);
      expect(child.stderr).toMatch(/lock|busy/iu);
      expect(await readFile(sessionPath, "utf8")).toBe(before);
    } finally {
      await activeWriter.close();
    }
  }, 10_000);
});
