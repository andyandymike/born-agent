import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readStoredSession } from "../../src/sessions/read-stored-session.js";

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16f-pty-"));
  workspaces.push(workspace);
  await writeFile(join(workspace, "fixture.txt"), "phase16 PTY\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 PTY Fixture"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: workspace,
  });
  return workspace;
}

interface PtyEvidence {
  readonly appExitCode: number;
  readonly outputBase64: string;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

describe("Phase 16F real PTY lifecycle", () => {
  it(
    "survives resize, cancels an active run, starts another run, and restores the terminal",
    async () => {
      const workspace = await fixtureWorkspace();
      const driver = fileURLToPath(
        new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url),
      );
      const app = fileURLToPath(
        new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url),
      );
      const result = await execFileAsync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), driver, workspace, app],
        {
          cwd: workspace,
          env: { ...process.env },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
        },
      );
      const evidence = JSON.parse(result.stdout.trim()) as PtyEvidence;
      const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");

      expect(evidence).toMatchObject({
        appExitCode: 0,
        resized: true,
        shellExitCode: 0,
        shellRestored: true,
        signal: null,
      });
      expect(raw).toContain("PTY_ACTIVE");
      expect(raw).toContain("PTY_SECOND");
      expect(raw).toContain("PTY_APP_EXIT=0");
      expect(raw).toContain("PTY_SHELL_RESTORED");

      const files = (await readdir(join(workspace, ".bornagent", "sessions"))).filter(
        (name) => name.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const events = await readStoredSession(
        join(workspace, ".bornagent", "sessions", files[0]!),
      );
      const starts = events.filter((event) => event.type === "run.started");
      expect(starts).toHaveLength(2);
      expect(events.filter((event) => event.type === "run.cancelled")).toEqual([
        expect.objectContaining({ runId: starts[0]!.runId }),
      ]);
      expect(events.filter((event) => event.type === "run.incomplete")).toEqual([
        expect.objectContaining({ runId: starts[1]!.runId }),
      ]);
      expect(events.filter((event) => event.type === "goal.created")).toHaveLength(1);
    },
    40_000,
  );
});
