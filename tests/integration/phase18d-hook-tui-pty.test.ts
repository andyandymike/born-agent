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

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    })),
  );
});

interface HookPtyEvidence {
  readonly appExitCode: number;
  readonly hookApprovalDenied: boolean;
  readonly hookApprovalVisible: boolean;
  readonly originalApprovalVisible: boolean;
  readonly outputBase64: string;
  readonly resized: boolean;
  readonly serverApprovalVisible: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

describe("Phase 18D real PTY command Hook approval", () => {
  it("keeps MCP and command Hook authority separate, denies the Hook, and restores the shell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase18d-hook-pty-"));
    workspaces.push(workspace);
    const driver = fileURLToPath(
      new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url),
    );
    const app = fileURLToPath(
      new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url),
    );
    const result = await withRealPtyTestLock(() =>
      execFileAsync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), driver, workspace, app, "hook-approval"],
        {
          cwd: workspace,
          env: { ...process.env, LOCALAPPDATA: join(workspace, "user-state") },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 70_000,
          windowsHide: true,
        },
      ),
    );
    const evidence = JSON.parse(result.stdout.trim()) as HookPtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");

    expect(evidence).toMatchObject({
      appExitCode: 0,
      hookApprovalDenied: true,
      hookApprovalVisible: true,
      originalApprovalVisible: true,
      resized: true,
      serverApprovalVisible: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("HOOK_PTY_DENIED");
    expect(raw).toContain("Hook: user_install:bornagent.hook-pty@1.0.0/hook/command-gate#sha256:");
  }, 75_000);
});
