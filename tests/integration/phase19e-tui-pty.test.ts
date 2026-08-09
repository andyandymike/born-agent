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

interface PtyEvidence {
  readonly appExitCode: number;
  readonly graphApproved: boolean;
  readonly graphCancelled: boolean;
  readonly graphEnqueued: boolean;
  readonly graphNodeVisible: boolean;
  readonly outputBase64: string;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

describe("Phase 19E real PTY Graph controls", () => {
  it("approves, enqueues, inspects, and cancels a Graph before restoring the parent shell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase19e-pty-"));
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
        ["--import", import.meta.resolve("tsx"), driver, workspace, app, "graph"],
        {
          cwd: workspace,
          env: { ...process.env, LOCALAPPDATA: join(workspace, "user-state") },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 55_000,
          windowsHide: true,
        },
      ),
    );
    const evidence = JSON.parse(result.stdout.trim()) as PtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");

    expect(evidence).toMatchObject({
      appExitCode: 0,
      graphApproved: true,
      graphCancelled: true,
      graphEnqueued: true,
      graphNodeVisible: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("GRAPH NODE");
    expect(raw).toContain("PTY_SHELL_RESTORED");
  }, 60_000);
});
