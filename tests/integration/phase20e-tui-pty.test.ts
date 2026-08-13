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
const realBuiltDelegationPtyTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  })));
});

interface Phase20PtyEvidence {
  readonly appExitCode: number;
  readonly delegationRejected: boolean;
  readonly delegationPreparedNoProgress: boolean;
  readonly hostPreparedActions: readonly string[];
  readonly hostPreparedExactIdentityVisible: boolean;
  readonly hostPreparedSummaryVisible: boolean;
  readonly hostPreparedTargetVisible: boolean;
  readonly maximumActiveChildrenVisible: boolean;
  readonly outputBase64: string;
  readonly receiptsVisible: boolean;
  readonly replayStable: boolean;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
  readonly verifiedReceiptVisible: boolean;
}

describe("Phase 20E real PTY controlled delegation lifecycle", () => {
  realBuiltDelegationPtyTest("rejects one exact proposal, runs two sealed children, and replays receipts without duplicate spawn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20p-"));
    workspaces.push(workspace);
    const driver = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url));
    const app = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url));
    const result = await withRealPtyTestLock(() => execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), driver, workspace, app, "delegation"],
      {
        cwd: workspace,
        env: { ...process.env, LOCALAPPDATA: join(workspace, "user-state") },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 110_000,
        windowsHide: true,
      },
    ));
    const evidence = JSON.parse(result.stdout.trim()) as Phase20PtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");
    expect(evidence).toMatchObject({
      appExitCode: 0,
      delegationRejected: true,
      delegationPreparedNoProgress: true,
      hostPreparedExactIdentityVisible: true,
      hostPreparedSummaryVisible: true,
      hostPreparedTargetVisible: true,
      maximumActiveChildrenVisible: true,
      receiptsVisible: true,
      replayStable: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
      verifiedReceiptVisible: true,
    });
    expect(evidence.hostPreparedActions).toEqual(expect.arrayContaining([
      "delegation.decide",
      "delegation.resume",
    ]));
    expect(raw).toContain("HOST PREPARED ACTION | delegation.resume");
    expect(raw).toContain("[CONFIRM EXACT PREPARED ACTION]");
    expect(raw).toContain("DELEGATION DECISION | REJECT");
    expect(raw).toContain("DELEGATION DECISION | START_OR_RESUME");
    expect(raw).toContain("PTY_SHELL_RESTORED");
  }, 120_000);
});
