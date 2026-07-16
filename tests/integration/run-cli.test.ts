import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

describe("runCli", () => {
  it("prints help to stdout", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(["--help"], memory.io, createRuntime());
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toContain("Usage: born");
    expect(memory.readStderr()).toBe("");
  });

  it("prints the package version to stdout", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(["--version"], memory.io, createRuntime());
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toBe("0.0.0\n");
    expect(memory.readStderr()).toBe("");
  });

  it("prints help when no arguments are provided", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli([], memory.io, createRuntime());
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toContain("Usage: born");
    expect(memory.readStderr()).toBe("");
  });

  it("returns usage error 2 for an unknown command", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(["unknown"], memory.io, createRuntime());
    expect(exitCode).toBe(2);
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toContain("unknown command 'unknown'");
  });

  it("validates Phase 10 context CLI options before creating a session", async () => {
    const memory = createMemoryIO();
    const createSessionWriter = vi.fn(createRuntime().createSessionWriter);
    const exitCode = await runCli(
      [
        "agent",
        "inspect",
        "--context-compaction-threshold",
        "0.49",
        "--context-reserve-output-tokens",
        "4096",
        "--context-window-tokens",
        "32768",
        "--artifact-capture-bytes",
        "4194304",
      ],
      memory.io,
      createRuntime({ createSessionWriter }),
    );

    expect(exitCode).toBe(2);
    expect(createSessionWriter).not.toHaveBeenCalled();
    expect(memory.readStderr()).toContain("context compaction threshold");
  });

  it("returns success when every doctor check passes", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(["doctor"], memory.io, createRuntime());
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toContain("[ok] Node.js");
    expect(memory.readStdout()).toContain("[ok] Provider: openai");
    expect(memory.readStdout()).toContain("[ok] OpenAI credential: configured");
    expect(memory.readStdout()).toContain("[ok] Model: gpt-5.6-terra");
    expect(memory.readStdout()).toContain("Doctor: 7 passed, 0 failed");
    expect(memory.readStderr()).toBe("");
  });

  it("returns doctor error 3 when ripgrep is missing", async () => {
    const memory = createMemoryIO();
    const fallback = createRuntime().runExecutable;
    const runtime = createRuntime({
      runExecutable: async (command, args, timeout) =>
        command === "rg"
          ? { kind: "missing" }
          : fallback(command, args, timeout),
    });
    const exitCode = await runCli(["doctor"], memory.io, runtime);
    expect(exitCode).toBe(3);
    expect(memory.readStdout()).toContain("[fail] ripgrep");
    expect(memory.readStdout()).toContain("Doctor: 6 passed, 1 failed");
    expect(memory.readStderr()).toBe("");
  });
});
