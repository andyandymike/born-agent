import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { EvalCliRuntime } from "../../src/evals/eval-cli.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

describe("Phase 14 eval CLI wiring", () => {
  it("routes list/run/show/compare only through the dedicated eval runtime", async () => {
    const calls: string[] = [];
    const evalRuntime: EvalCliRuntime = {
      async list() { calls.push("list"); return { exitCode: 0, stdout: "listed\n" }; },
      async run(options) { calls.push(`run:${options.suite}:${options.provider}`); return { exitCode: 2, stderr: "full refused\n" }; },
      async show(options) { calls.push(`show:${options.runId}`); return { exitCode: 0, stdout: "shown\n" }; },
      async compare(options) { calls.push(`compare:${options.baselineId}:${options.candidateId}`); return { exitCode: 9, stdout: "regression\n" }; },
    };
    const createModelBackend = vi.fn(createRuntime().createModelBackend);

    let memory = createMemoryIO();
    expect(await runCli(["eval", "list"], memory.io, createRuntime({ evalRuntime, createModelBackend }))).toBe(0);
    expect(memory.readStdout()).toBe("listed\n");
    memory = createMemoryIO();
    expect(await runCli(["eval", "run", "--suite", "full", "--provider", "fake", "--model", "fixture"], memory.io, createRuntime({ evalRuntime, createModelBackend }))).toBe(2);
    memory = createMemoryIO();
    expect(await runCli(["eval", "show", "run-1"], memory.io, createRuntime({ evalRuntime, createModelBackend }))).toBe(0);
    memory = createMemoryIO();
    expect(await runCli(["eval", "compare", "run-1", "run-2"], memory.io, createRuntime({ evalRuntime, createModelBackend }))).toBe(9);

    expect(calls).toEqual(["list", "run:full:fake", "show:run-1", "compare:run-1:run-2"]);
    expect(createModelBackend).not.toHaveBeenCalled();
  });
});
