import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEM_E0_ACTOR_QUALIFICATION_PROTECTED_PATHS,
  observeMemE0ActorQualificationSource,
} from "../src/actor-qualification-source.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-09-01T00:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-09-01T00:00:00.000Z",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    windowsHide: true,
  });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mem-e0-source-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "actor.ts"), "export const actor = 1;\n", "utf8");
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "mem-e0@example.invalid"]);
  await git(root, ["config", "user.name", "FAL MEM-E0"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe("MEM-E0 actor qualification source", () => {
  it("protects the complete paid-qualification execution boundary", () => {
    expect(MEM_E0_ACTOR_QUALIFICATION_PROTECTED_PATHS).toEqual(
      expect.arrayContaining([
        "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/actor-config.json",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-model-evidence.ts",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-provider-meter.ts",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-actor-qualification-executor.ts",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-actor-qualification-runner.ts",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-actor-qualification-child.ts",
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-actor-qualification.ts",
        "src/control-plane/adapters/agent-cli-adapter.ts",
        "src/providers/pi/production-pi-runtime-port.ts",
        "src/tools/create-agent-tool-registry.ts",
      ]),
    );
  });

  it("derives a clean exact-commit snapshot from Git and file bytes", async () => {
    const root = await fixture();
    const first = await observeMemE0ActorQualificationSource({
      protectedPaths: ["src/actor.ts"],
      repositoryRoot: root,
    });
    const second = await observeMemE0ActorQualificationSource({
      protectedPaths: ["src/actor.ts"],
      repositoryRoot: root,
    });

    expect(first).toEqual(second);
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(first.implementationSha256s).toHaveLength(1);
    expect(first.protectedPathsClean).toBe(true);
    expect(first.protectedTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("marks the source dirty without hiding unrelated or untracked drift", async () => {
    const root = await fixture();
    await writeFile(join(root, "untracked.txt"), "drift\n", "utf8");

    const observed = await observeMemE0ActorQualificationSource({
      protectedPaths: ["src/actor.ts"],
      repositoryRoot: root,
    });

    expect(observed.protectedPathsClean).toBe(false);
  });

  it("rejects missing, escaping, duplicate, or non-root protected inputs", async () => {
    const root = await fixture();

    await expect(observeMemE0ActorQualificationSource({
      protectedPaths: ["../outside.ts"],
      repositoryRoot: root,
    })).rejects.toThrow("protected paths are invalid");
    await expect(observeMemE0ActorQualificationSource({
      protectedPaths: ["src/actor.ts", "src/actor.ts"],
      repositoryRoot: root,
    })).rejects.toThrow("protected paths are invalid");
    await expect(observeMemE0ActorQualificationSource({
      protectedPaths: ["src/missing.ts"],
      repositoryRoot: root,
    })).rejects.toThrow();
    await expect(observeMemE0ActorQualificationSource({
      protectedPaths: ["actor.ts"],
      repositoryRoot: join(root, "src"),
    })).rejects.toThrow("exact Git root");
  });
});
