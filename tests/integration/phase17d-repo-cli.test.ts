import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("Phase 17D repository CLI", () => {
  it("keeps status read-only, builds in the foreground, and shares canonical query results", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17d-cli-"));
    temporary.push(root);
    const sourcePath = join(root, "session.ts");
    await writeFile(sourcePath, "export class Session {}\nexport const current = new Session();\n", "utf8");
    const sourceBefore = await readFile(sourcePath);
    const runtime = createRuntime({ cwd: root });

    const firstStatus = createMemoryIO();
    expect(await runCli(["repo", "status", "--json"], firstStatus.io, runtime)).toBe(0);
    const missing = JSON.parse(firstStatus.readStdout()) as Record<string, unknown>;
    expect(missing).toMatchObject({ generationSha256: null, indexState: "idle", schemaVersion: 1 });
    expect(missing.statusSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await exists(join(root, ".bornagent"))).toBe(false);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    const index = createMemoryIO();
    expect(await runCli(["repo", "index", "--json"], index.io, runtime)).toBe(0);
    const generation = JSON.parse(index.readStdout()) as { readonly generationSha256: string };
    expect(generation.generationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    const symbol = createMemoryIO();
    expect(await runCli(["repo", "query", "symbol", "Session", "--limit", "1"], symbol.io, runtime)).toBe(0);
    const result = JSON.parse(symbol.readStdout()) as {
      readonly generationSha256: string;
      readonly result: readonly { readonly name: string; readonly relativePath: string }[];
    };
    expect(result.generationSha256).toBe(generation.generationSha256);
    expect(result.result[0]).toMatchObject({ name: "Session", relativePath: "session.ts" });

    const currentStatus = createMemoryIO();
    expect(await runCli(["repo", "status"], currentStatus.io, runtime)).toBe(0);
    expect(currentStatus.readStdout()).toContain(`gen=${generation.generationSha256.slice(0, 8)}`);
    expect(currentStatus.readStdout()).toContain("index=ready");
  });

  it("rejects raw/absolute query surfaces as usage errors without leaking parser details", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17d-cli-"));
    temporary.push(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const runtime = createRuntime({ cwd: root });
    const invalid = createMemoryIO();

    expect(await runCli(["repo", "query", "outline", "C:/outside"], invalid.io, runtime)).toBe(2);
    expect(invalid.readStderr()).toContain("repository_query_invalid");
    expect(invalid.readStderr()).not.toContain(root);

    const raw = createMemoryIO();
    expect(await runCli(["repo", "query", "sql", "select *"], raw.io, runtime)).toBe(2);
    expect(raw.readStderr()).toContain("unknown command");
  });
});
