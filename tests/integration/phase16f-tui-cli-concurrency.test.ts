import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
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
  });
});
