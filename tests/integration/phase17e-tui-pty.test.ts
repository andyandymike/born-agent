import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })));
});

interface PtyEvidence {
  readonly appExitCode: number;
  readonly outputBase64: string;
  readonly repositoryDirty: boolean;
  readonly repositoryReady: boolean;
  readonly repositoryRefreshed: boolean;
  readonly resized: boolean;
  readonly shellExitCode: number;
  readonly shellRestored: boolean;
  readonly signal: number | null;
}

describe("Phase 17E real PTY repository lifecycle", () => {
  it("refreshes in the foreground, observes an external edit, runs again, and restores the shell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase17e-pty-"));
    workspaces.push(workspace);
    await writeFile(join(workspace, "repo.ts"), "export const ptyValue = 1;\n", "utf8");
    const driver = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-driver.ts", import.meta.url));
    const app = fileURLToPath(new URL("../fixtures/phase16f-tui-pty-app.ts", import.meta.url));

    const result = await execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), driver, workspace, app, "repository"],
      {
        cwd: workspace,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 45_000,
        windowsHide: true,
      },
    );
    const evidence = JSON.parse(result.stdout.trim()) as PtyEvidence;
    const raw = Buffer.from(evidence.outputBase64, "base64").toString("utf8");

    expect(evidence).toMatchObject({
      appExitCode: 0,
      repositoryDirty: true,
      repositoryReady: true,
      repositoryRefreshed: true,
      resized: true,
      shellExitCode: 0,
      shellRestored: true,
      signal: null,
    });
    expect(raw).toContain("PTY_ACTIVE");
    expect(raw).toContain("PTY_SECOND");
    expect(raw).toContain("engine=typescript-language-service");
    expect(raw).toContain("index=dirty");
    expect(raw).toContain("index=ready");
    expect(raw).toContain("PTY_SHELL_RESTORED");
    await expect(DefaultRepositoryNavigationService.inspect(workspace)).resolves.toMatchObject({
      indexState: "ready",
    });
  }, 55_000);
});
