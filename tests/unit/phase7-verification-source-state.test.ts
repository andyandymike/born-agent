import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeGitArgvRunner } from "../../src/verification/git-argv-runner.js";
import { SourceStateDigestBuilder } from "../../src/verification/source-state-digest.js";

const temporaryDirectories: string[] = [];
const git = new NodeGitArgvRunner();

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "born-phase7-source-"));
  temporaryDirectories.push(path);
  return path;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

describe("Phase 7 source-state digest", () => {
  it("covers tracked and nonignored untracked source while excluding ignored and internal state", async () => {
    const root = await temporaryDirectory();
    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.email", "bornagent@example.invalid"]);
    await runGit(root, ["config", "user.name", "BornAgent Test"]);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "build"));
    await mkdir(join(root, ".bornagent"));
    await writeFile(join(root, ".gitignore"), "build/\n", "utf8");
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "visible-未跟踪.txt"), "visible\n", "utf8");
    await writeFile(join(root, "build", "ignored.txt"), "ignored v1\n", "utf8");
    await writeFile(join(root, ".bornagent", "ledger.jsonl"), "internal v1\n", "utf8");
    await runGit(root, ["add", ".gitignore", "src/value.ts", ".bornagent/ledger.jsonl"]);
    await runGit(root, ["commit", "--quiet", "-m", "fixture"]);

    const builder = new SourceStateDigestBuilder(git);
    const before = await builder.build(root);
    expect(before.files.map((file) => file.path)).toEqual([
      ".gitignore",
      "src/value.ts",
      "visible-未跟踪.txt",
    ]);

    await writeFile(join(root, "build", "ignored.txt"), "ignored v2\n", "utf8");
    await writeFile(join(root, ".bornagent", "ledger.jsonl"), "internal v2\n", "utf8");
    const afterExcludedChanges = await builder.build(root);
    expect(afterExcludedChanges).toEqual(before);

    await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n", "utf8");
    const afterSourceChange = await builder.build(root);
    expect(afterSourceChange.sourceStateSha256).not.toBe(before.sourceStateSha256);
    expect(afterSourceChange.gitHeadSha256).toBe(before.gitHeadSha256);
    expect(afterSourceChange.gitIndexSha256).toBe(before.gitIndexSha256);

    await runGit(root, ["add", "src/value.ts"]);
    const afterIndexChange = await builder.build(root);
    expect(afterIndexChange.sourceStateSha256).toBe(
      afterSourceChange.sourceStateSha256,
    );
    expect(afterIndexChange.gitIndexSha256).not.toBe(before.gitIndexSha256);

    await runGit(root, ["commit", "--quiet", "-m", "advance head"]);
    const afterHeadChange = await builder.build(root);
    expect(afterHeadChange.sourceStateSha256).toBe(
      afterSourceChange.sourceStateSha256,
    );
    expect(afterHeadChange.gitHeadSha256).not.toBe(before.gitHeadSha256);
  }, 20_000);
});
