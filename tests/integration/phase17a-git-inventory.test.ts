import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const execFile = promisify(nodeExecFile);
const temporaryDirectories: string[] = [];

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFile("git", [...args], { cwd: root, shell: false, windowsHide: true });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17A Git inventory", () => {
  it("binds tracked, dirty, untracked, and deleted facts without indexing .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17a-git-"));
    temporaryDirectories.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "phase17@example.invalid"]);
    await git(root, ["config", "user.name", "Phase 17"]);
    await writeFile(join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
    await writeFile(join(root, "deleted.ts"), "export const deleted = 1;\n", "utf8");
    await git(root, ["add", "tracked.ts", "deleted.ts"]);
    await git(root, ["commit", "-m", "fixture"]);

    const snapshotter = await RepositorySourceSnapshotter.create(root);
    const clean = await snapshotter.snapshot();
    expect(clean.snapshot).toMatchObject({ coverage: "complete", sourceKind: "git_worktree" });
    expect(clean.snapshot.gitHeadOid).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(clean.snapshot.entries.some((entry) => entry.relativePath.startsWith(".git/"))).toBe(false);

    await writeFile(join(root, "tracked.ts"), "export const tracked = 2;\n", "utf8");
    await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n", "utf8");
    const dirty = await snapshotter.snapshot();
    expect(dirty.snapshot.sourceStateSha256).not.toBe(clean.snapshot.sourceStateSha256);
    expect(dirty.snapshot.entries.map((entry) => entry.relativePath)).toContain("untracked.ts");

    await unlink(join(root, "deleted.ts"));
    const deleted = await snapshotter.snapshot();
    expect(deleted.snapshot.coverage).toBe("complete");
    expect(deleted.snapshot.entries.map((entry) => entry.relativePath)).not.toContain("deleted.ts");
    expect(deleted.snapshot.sourceStateSha256).not.toBe(dirty.snapshot.sourceStateSha256);
  });
});
