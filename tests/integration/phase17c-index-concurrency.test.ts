import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function runIndexProcess(workspace: string): Promise<{
  readonly buildMode: "cold" | "incremental" | "reused";
  readonly generationSha256: string;
}> {
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const result = await execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cli, "repo", "index", "--json"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return JSON.parse(result.stdout.trim()) as {
    readonly buildMode: "cold" | "incremental" | "reused";
    readonly generationSha256: string;
  };
}

describe("Phase 17C cross-process index concurrency", () => {
  it("serializes two real writers and leaves one complete exact generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-concurrency-"));
    temporary.push(root);
    const source = Array.from({ length: 80 }, (_, index) =>
      `export const value${String(index)} = ${String(index)};\n`
    ).join("");
    const sourcePath = join(root, "values.ts");
    await writeFile(sourcePath, source, "utf8");
    const before = await readFile(sourcePath);

    const attempts = await Promise.allSettled([runIndexProcess(root), runIndexProcess(root)]);
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map((attempt) => attempt.reason), "concurrent repository index process failed");
    }
    const results = attempts.map((attempt) => {
      if (attempt.status === "rejected") throw attempt.reason;
      return attempt.value;
    });
    expect(results).toHaveLength(2);
    const first = results[0]!;
    const second = results[1]!;

    expect(first.generationSha256).toBe(second.generationSha256);
    expect([first.buildMode, second.buildMode].sort()).toEqual(["cold", "reused"]);
    expect(await readFile(sourcePath)).toEqual(before);
    const store = await RepositoryIndexV2Store.openExisting(root);
    expect(store).not.toBeNull();
    expect((await store!.readCurrent())?.generation.generationSha256).toBe(first.generationSha256);
    expect(await readdir(store!.paths.rootsRoot)).toHaveLength(1);
    expect(await readdir(store!.paths.locksRoot)).toEqual([]);
    expect(await readdir(store!.paths.temporaryRoot)).toEqual([]);
  }, 40_000);
});
