import { describe, expect, it } from "vitest";

import { runDoctor } from "../../src/doctor/run-doctor.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { createRuntime } from "../helpers.js";

function findCheck(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`missing ${name} check`);
  }
  return check;
}

describe("runDoctor", () => {
  it("accepts a supported Node.js version", async () => {
    const report = await runDoctor(createRuntime({ nodeVersion: "22.0.0" }));
    expect(findCheck(report, "Node.js")).toMatchObject({ ok: true });
  });

  it("rejects an older Node.js version", async () => {
    const report = await runDoctor(createRuntime({ nodeVersion: "20.19.0" }));
    expect(findCheck(report, "Node.js")).toMatchObject({
      detail: expect.stringContaining("v22+ required"),
      ok: false,
    });
  });

  it("reports Git when its executable exists", async () => {
    const report = await runDoctor(createRuntime());
    expect(findCheck(report, "Git")).toEqual({
      detail: "git version 2.30.0.windows.2",
      name: "Git",
      ok: true,
    });
  });

  it("reports install hints when Git is missing", async () => {
    const runtime = createRuntime({
      runExecutable: async (command, args, timeout) =>
        command === "git"
          ? { kind: "missing" }
          : createRuntime().runExecutable(command, args, timeout),
    });
    const report = await runDoctor(runtime);
    const check = findCheck(report, "Git");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Windows");
    expect(check.detail).toContain("macOS");
    expect(check.detail).toContain("Linux");
  });

  it("reports a ripgrep timeout", async () => {
    const fallback = createRuntime().runExecutable;
    const runtime = createRuntime({
      runExecutable: async (command, args, timeout) =>
        command === "rg"
          ? { kind: "timeout" }
          : fallback(command, args, timeout),
    });
    const report = await runDoctor(runtime);
    expect(findCheck(report, "ripgrep")).toMatchObject({
      detail: expect.stringContaining("3000 ms"),
      ok: false,
    });
  });

  it("reports an unreadable workspace and still runs every check", async () => {
    const commands: string[] = [];
    const fallback = createRuntime().runExecutable;
    const runtime: CliRuntime = createRuntime({
      isReadableDirectory: async () => false,
      runExecutable: async (command, args, timeout) => {
        commands.push(command);
        return fallback(command, args, timeout);
      },
    });
    const report = await runDoctor(runtime);
    expect(findCheck(report, "Workspace")).toMatchObject({ ok: false });
    expect(commands).toEqual(["git", "rg"]);
    expect(report.checks).toHaveLength(7);
  });

  it("reports credential state without exposing the API key", async () => {
    const secret = "sk-doctor-secret";
    const configured = await runDoctor(
      createRuntime({ env: { OPENAI_API_KEY: secret } }),
    );
    const missing = await runDoctor(createRuntime({ env: {} }));
    expect(findCheck(configured, "OpenAI credential")).toEqual({
      detail: "configured",
      name: "OpenAI credential",
      ok: true,
    });
    expect(JSON.stringify(configured)).not.toContain(secret);
    expect(findCheck(missing, "OpenAI credential")).toMatchObject({
      detail: "not configured",
      ok: false,
    });
  });

  it("shows the resolved model and rejects a blank override", async () => {
    const selected = await runDoctor(
      createRuntime({
        env: { BORN_MODEL: "custom-model", OPENAI_API_KEY: "test-key" },
      }),
    );
    const blank = await runDoctor(
      createRuntime({
        env: { BORN_MODEL: "   ", OPENAI_API_KEY: "test-key" },
      }),
    );
    expect(findCheck(selected, "Model")).toMatchObject({
      detail: "custom-model",
      ok: true,
    });
    expect(findCheck(blank, "Model")).toMatchObject({ ok: false });
  });

  it("checks the Ollama service and selected local model", async () => {
    const fallback = createRuntime().runExecutable;
    const report = await runDoctor(
      createRuntime({
        env: { BORN_MODEL: "qwen3:1.7b", BORN_PROVIDER: "ollama" },
        runExecutable: async (command, args, timeout) =>
          command === "ollama"
            ? {
                kind: "completed",
                exitCode: 0,
                stderr: "",
                stdout:
                  "NAME        ID      SIZE\nqwen3:1.7b  abc123  1.4 GB\n",
              }
            : fallback(command, args, timeout),
      }),
    );

    expect(findCheck(report, "Provider")).toEqual({
      detail: "ollama",
      name: "Provider",
      ok: true,
    });
    expect(findCheck(report, "Ollama service")).toMatchObject({ ok: true });
    expect(findCheck(report, "Model")).toMatchObject({
      detail: "qwen3:1.7b",
      ok: true,
    });
    expect(
      report.checks.some((check) => check.name === "OpenAI credential"),
    ).toBe(false);
  });

  it("reports how to pull a missing Ollama model", async () => {
    const fallback = createRuntime().runExecutable;
    const report = await runDoctor(
      createRuntime({
        env: { BORN_MODEL: "qwen3:8b", BORN_PROVIDER: "ollama" },
        runExecutable: async (command, args, timeout) =>
          command === "ollama"
            ? {
                kind: "completed",
                exitCode: 0,
                stderr: "",
                stdout:
                  "NAME        ID      SIZE\nqwen3:1.7b  abc123  1.4 GB\n",
              }
            : fallback(command, args, timeout),
      }),
    );

    expect(findCheck(report, "Model")).toMatchObject({
      detail: expect.stringContaining("ollama pull qwen3:8b"),
      ok: false,
    });
  });
});
