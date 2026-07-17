import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeWorkspaceSnapshotSource } from "../../src/execution/snapshot/node-workspace-snapshot-adapters.js";
import { WorkspaceSnapshotPlanner } from "../../src/execution/snapshot/workspace-snapshot-planner.js";
import { NodeGitArgvRunner } from "../../src/verification/git-argv-runner.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })));
});

async function requireGit(runner: NodeGitArgvRunner, cwd: string, args: readonly string[]) {
  const result = await runner.run(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

describe("Phase 13 Node workspace snapshot source", () => {
  it("uses current tracked plus nonignored untracked bytes and omits deleted/ignored/sensitive paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase13-git-"));
    workspaces.push(workspace);
    const git = new NodeGitArgvRunner();
    await requireGit(git, workspace, ["init", "--initial-branch=main"]);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, ".gitignore"), "*.log\n", "utf8");
    await writeFile(join(workspace, ".env"), "PROVIDER_KEY=sentinel\n", "utf8");
    await writeFile(join(workspace, "deleted.txt"), "delete me\n", "utf8");
    await writeFile(join(workspace, "src", "长 file.txt"), "staged bytes\n", "utf8");
    await requireGit(git, workspace, ["add", "--all"]);
    await writeFile(join(workspace, "src", "长 file.txt"), "current worktree bytes\n", "utf8");
    await unlink(join(workspace, "deleted.txt"));
    await writeFile(join(workspace, "new.txt"), "untracked\n", "utf8");
    await writeFile(join(workspace, "ignored.log"), "ignored\n", "utf8");

    const source = await NodeWorkspaceSnapshotSource.create(workspace, git);
    const plan = await new WorkspaceSnapshotPlanner(source).plan();

    expect(plan.entries.map((entry) => [entry.path, entry.tracked])).toEqual([
      [".gitignore", true],
      ["new.txt", false],
      ["src/长 file.txt", true],
    ]);
    expect(plan.manifest.omitted).toEqual([
      { category: "sensitive_path", count: 1 },
    ]);
    expect(plan.entries.find((entry) => entry.path === "src/长 file.txt")?.bytes).toBe(
      Buffer.byteLength("current worktree bytes\n", "utf8"),
    );
    expect(JSON.stringify(plan.manifest)).not.toContain("PROVIDER_KEY");
    expect(plan.entries.some((entry) => entry.path === "deleted.txt")).toBe(false);
    expect(plan.entries.some((entry) => entry.path === "ignored.log")).toBe(false);
  });
});
