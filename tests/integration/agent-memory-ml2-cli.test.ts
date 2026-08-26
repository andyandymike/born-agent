import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { disposeApplicationHostForStateRoot } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const activeStateRoots: string[] = [];
const tsxLoader = import.meta.resolve("tsx");

afterEach(async () => {
  await Promise.all(activeStateRoots.splice(0).map((root) => disposeApplicationHostForStateRoot(root)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function seedProductEpisode(stateRoot: string, cwd: string, task: string): Promise<void> {
  activeStateRoots.push(stateRoot);
  const output = createMemoryIO();
  expect(await runCli([
    "agent",
    task,
    "--task-profile",
    "read-only",
    "--max-steps",
    "1",
    "--memory",
    "local",
  ], output.io, createRuntime({ controlPlaneStateRoot: stateRoot, cwd })), output.readStderr()).toBe(0);
  await disposeApplicationHostForStateRoot(stateRoot);
  const index = activeStateRoots.indexOf(stateRoot);
  if (index >= 0) activeStateRoots.splice(index, 1);
}

async function processSearch(
  stateRoot: string,
  cwd: string,
  query: string,
  format: "human" | "json",
): Promise<Readonly<{ stderr: string; stdout: string }>> {
  const result = await execFileAsync(process.execPath, [
    "--import",
    tsxLoader,
    resolve("src/cli.ts"),
    "memory",
    "search",
    query,
    "--explain",
    ...(format === "json" ? ["--json"] : []),
  ], {
    cwd,
    env: { ...process.env, BORN_CONTROL_STATE_ROOT: stateRoot },
    timeout: 30_000,
    windowsHide: true,
  });
  return Object.freeze({ stderr: result.stderr, stdout: result.stdout });
}

describe("Agent memory ML2 product search", () => {
  it("ML2 packed-style search explain survives a full process restart", async () => {
    const stateRoot = await directory("bornagent-ml2-restart-state-");
    const cwd = await directory("bornagent-ml2-restart-repository-");
    await seedProductEpisode(
      stateRoot,
      cwd,
      "Add repository scope filtering to local memory search",
    );
    const firstProcess = await processSearch(stateRoot, cwd, '"repository scope filtering"', "json");
    const first = JSON.parse(firstProcess.stdout) as {
      readonly hits: readonly {
        readonly reason: string;
        readonly record: { readonly recordId: string };
        readonly score: { readonly lexicalBm25: number };
      }[];
      readonly projection: { readonly action: string };
      readonly status: string;
    };
    expect(first).toMatchObject({ projection: { action: "rebuilt" }, status: "matched" });
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0]).toMatchObject({ reason: "exact_phrase" });

    const secondProcess = await processSearch(stateRoot, cwd, '"repository scope filtering"', "json");
    const second = JSON.parse(secondProcess.stdout) as typeof first;
    expect(second).toMatchObject({ projection: { action: "reused" }, status: "matched" });
    expect(second.hits).toEqual(first.hits);

    const human = await processSearch(stateRoot, cwd, '"repository scope filtering"', "human");
    expect(human.stdout).toContain(first.hits[0]!.record.recordId);
    expect(human.stdout).toContain("exact_phrase");
    expect(human.stdout).toContain(`bm25=${String(first.hits[0]!.score.lexicalBm25)}`);
    expect(human.stdout).toContain("source=available");
  }, 30_000);

  it("ML2 stale source candidates are removed before search output", async () => {
    const stateRoot = await directory("bornagent-ml2-stale-state-");
    const cwd = await directory("bornagent-ml2-stale-repository-");
    const task = "Repair incremental cache invalidation for renamed source files";
    await seedProductEpisode(stateRoot, cwd, task);

    const before = JSON.parse((await processSearch(stateRoot, cwd, "cache invalidation renamed", "json")).stdout) as {
      readonly candidates: { readonly available: number; readonly matched: number };
      readonly hits: readonly unknown[];
      readonly status: string;
    };
    expect(before).toMatchObject({ candidates: { available: 1, matched: 1 }, status: "matched" });
    expect(before.hits).toHaveLength(1);

    const sessionRoot = join(cwd, ".bornagent", "sessions");
    const sessionFiles = (await readdir(sessionRoot)).filter((name) => name.endsWith(".jsonl"));
    expect(sessionFiles).toHaveLength(1);
    const sessionPath = join(sessionRoot, sessionFiles[0]!);
    const source = await readFile(sessionPath, "utf8");
    expect(source).toContain(task);
    await writeFile(sessionPath, source.replace(task, task.replace("files", "filez")), "utf8");

    const after = JSON.parse((await processSearch(stateRoot, cwd, "cache invalidation renamed", "json")).stdout) as {
      readonly abstentionReason: string;
      readonly candidates: { readonly available: number; readonly matched: number };
      readonly hits: readonly unknown[];
      readonly status: string;
    };
    expect(after).toMatchObject({
      abstentionReason: "no_available_match",
      candidates: { available: 0, matched: 1 },
      hits: [],
      status: "abstained",
    });
  }, 30_000);
});
