import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { withRealPtyTestLock } from "../pty-test-lock.js";

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];
const realBuiltCodingPtyTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  })));
});

interface CodingPtyEvidence {
  readonly appExitCode: number;
  readonly childCommandApprovalVisible: boolean;
  readonly childPatchApprovalVisible: boolean;
  readonly outputBase64: string;
  readonly receiptVisible: boolean;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

interface CodingCancelPtyEvidence {
  readonly appExitCode: number;
  readonly cancelledVisible: boolean;
  readonly childPatchApprovalVisible: boolean;
  readonly cleanProjectionVisible: boolean;
  readonly exitChoiceVisible?: boolean;
  readonly outputBase64: string;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

describe("Phase 20E real PTY child effect approvals", () => {
  realBuiltCodingPtyTest("shows actor-bound patch and command approvals before accepting a coding receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20cp-"));
    workspaces.push(workspace);
    const driver = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url));
    const app = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url));
    const result = await withRealPtyTestLock(() => execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), driver, workspace, app, "delegation-coding"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          LOCALAPPDATA: join(workspace, "user-state"),
          XDG_STATE_HOME: join(workspace, "user-state"),
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 170_000,
        windowsHide: true,
      },
    ));
    const evidence = JSON.parse(result.stdout.trim()) as CodingPtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");
    expect(evidence).toMatchObject({
      appExitCode: 0,
      childCommandApprovalVisible: true,
      childPatchApprovalVisible: true,
      receiptVisible: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("Default deny; approval is bound to this exact child/action identity.");
    expect(raw).toContain("PTY_SHELL_RESTORED");
  }, 180_000);

  realBuiltCodingPtyTest("cancels an active coding child from its patch modal before separately exiting the TUI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20ccp-"));
    workspaces.push(workspace);
    const driver = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url));
    const app = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url));
    const result = await withRealPtyTestLock(() => execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), driver, workspace, app, "delegation-coding-cancel"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          LOCALAPPDATA: join(workspace, "user-state"),
          XDG_STATE_HOME: join(workspace, "user-state"),
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 170_000,
        windowsHide: true,
      },
    ));
    const evidence = JSON.parse(result.stdout.trim()) as CodingCancelPtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");
    expect(evidence).toMatchObject({
      appExitCode: 0,
      cancelledVisible: true,
      childPatchApprovalVisible: true,
      cleanProjectionVisible: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("PTY_CODING_CANCEL_SNAPSHOT=");
    expect(raw).toContain("PTY_SHELL_RESTORED");
  }, 180_000);

  realBuiltCodingPtyTest("confirms exit with an active foreground child, cancels it exactly, and restores the shell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20cep-"));
    workspaces.push(workspace);
    const driver = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url));
    const app = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url));
    const result = await withRealPtyTestLock(() => execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), driver, workspace, app, "delegation-coding-exit-cancel"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          LOCALAPPDATA: join(workspace, "user-state"),
          XDG_STATE_HOME: join(workspace, "user-state"),
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 170_000,
        windowsHide: true,
      },
    ));
    const evidence = JSON.parse(result.stdout.trim()) as CodingCancelPtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");
    expect(evidence).toMatchObject({
      appExitCode: 0,
      cancelledVisible: true,
      childPatchApprovalVisible: true,
      cleanProjectionVisible: true,
      exitChoiceVisible: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("EXIT WITH ACTIVE CHILD");
    expect(raw).toContain("BACKGROUND HANDOFF UNAVAILABLE");
    expect(raw).toContain("PTY_SHELL_RESTORED");
  }, 180_000);
});
