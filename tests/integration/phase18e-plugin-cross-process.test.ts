import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function installProcess(root: string, workspace: string, source: string): Promise<{
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      resolve("tests/fixtures/phase18e-plugin-install-worker.mjs"),
      root,
      workspace,
      source,
    ], {
      cwd: resolve("."),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveProcess({ exitCode, stderr, stdout }));
  });
}

describe("Phase 18E cross-process Plugin state", () => {
  it("serializes two real Node installs and publishes one exact package/index fact", async () => {
    const base = await mkdtemp(join(tmpdir(), "bornagent-phase18e-cross-process-"));
    temporary.push(base);
    const root = join(base, "state");
    const workspace = join(base, "workspace");
    await mkdir(workspace);
    const source = resolve("fixtures/capability-platform/m9-review-pack");
    const results = await Promise.all([
      installProcess(root, workspace, source),
      installProcess(root, workspace, source),
    ]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    const values = results.map((result) => JSON.parse(result.stdout));
    expect(values.filter((value) => value.changed === true)).toHaveLength(1);
    expect(values.filter((value) => value.deduplicated === true)).toHaveLength(1);
    expect(new Set(values.map((value) => value.exactSelector)).size).toBe(1);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
  }, 30_000);
});
