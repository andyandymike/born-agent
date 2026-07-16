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
    expect(report.checks).toHaveLength(4);
  });
});

