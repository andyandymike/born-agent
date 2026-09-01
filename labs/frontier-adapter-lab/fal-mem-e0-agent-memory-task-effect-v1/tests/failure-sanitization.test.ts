import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { observeMemE0SanitizedFailure } from "../src/sanitized-failure.js";

const execFileAsync = promisify(execFile);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const repositoryRoot = resolve(".");
const mechanicsEntry = resolve(
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-mechanics.ts",
);

const observationKeys = [
  "failureClassSha256",
  "failureCode",
  "failureMessageSha256",
  "observationSha256",
  "schemaVersion",
  "status",
  "stderrSha256",
  "stdoutSha256",
] as const;

interface RejectedProcessObservation {
  readonly code: number | string | null;
  readonly stderr: string;
  readonly stdout: string;
}

function textField(error: object, key: "stderr" | "stdout"): string {
  if (!(key in error)) return "";
  const value = (error as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" ? value : String(value ?? "");
}

async function runRejectedMechanics(
  absoluteSentinel: string,
): Promise<RejectedProcessObservation> {
  try {
    await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        mechanicsEntry,
        absoluteSentinel,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    if (error === null || typeof error !== "object") {
      throw new Error(
        "MEM-E0 failure-boundary child produced no process result",
        { cause: error },
      );
    }
    const code = "code" in error
      ? (error as Readonly<Record<string, unknown>>).code
      : null;
    return Object.freeze({
      code: typeof code === "number" || typeof code === "string" ? code : null,
      stderr: textField(error, "stderr"),
      stdout: textField(error, "stdout"),
    });
  }
  throw new Error("MEM-E0 failure-boundary child unexpectedly succeeded");
}

function expectHashOnlyObservation(
  value: unknown,
  failureCode: "mechanics_command_failed" | "workspace_process_failed",
): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const observation = value as Readonly<Record<string, unknown>>;
  expect(Object.keys(observation).sort()).toEqual([...observationKeys].sort());
  expect(observation).toMatchObject({
    failureCode,
    schemaVersion: 1,
    status: "failed_closed",
  });
  for (const key of [
    "failureClassSha256",
    "failureMessageSha256",
    "observationSha256",
    "stderrSha256",
    "stdoutSha256",
  ]) {
    expect(observation[key]).toMatch(sha256Pattern);
  }
  const { observationSha256, ...content } = observation;
  expect(observationSha256).toBe(sha256Canonical(content));
}

describe("MEM-E0 failure sanitization", () => {
  it("reduces Error message and raw stdio to an enum plus hashes", () => {
    const absoluteSentinel = resolve(
      "MEM_E0_ABSOLUTE_PATH_SENTINEL__unit_failure",
    );
    const secretStdout = "MEM_E0_SECRET_STDOUT_SENTINEL";
    const secretStderr = "MEM_E0_SECRET_STDERR_SENTINEL";
    const error = Object.assign(
      new Error(`private failure at ${absoluteSentinel}`),
      {
        stderr: `${secretStderr}:${absoluteSentinel}`,
        stdout: `${secretStdout}:${absoluteSentinel}`,
      },
    );

    const observation = observeMemE0SanitizedFailure(
      "workspace_process_failed",
      error,
    );
    const serialized = JSON.stringify(observation);

    expectHashOnlyObservation(observation, "workspace_process_failed");
    for (const forbidden of [
      absoluteSentinel,
      repositoryRoot,
      secretStdout,
      secretStderr,
      "private failure",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("emits exactly one hash-only stderr line for an unexpected CLI argument", async () => {
    const absoluteSentinel = resolve(
      "MEM_E0_ABSOLUTE_PATH_SENTINEL__mechanics_cli",
    );
    const result = await runRejectedMechanics(absoluteSentinel);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.endsWith("\n")).toBe(true);
    const stderrLines = result.stderr.trimEnd().split(/\r?\n/u);
    expect(stderrLines).toHaveLength(1);
    const parsed = JSON.parse(stderrLines[0]!) as unknown;
    expectHashOnlyObservation(parsed, "mechanics_command_failed");

    for (const forbidden of [
      absoluteSentinel,
      repositoryRoot,
      repositoryRoot.replaceAll("\\", "/"),
      "MEM_E0_ABSOLUTE_PATH_SENTINEL",
      "accepts no command-line arguments",
    ]) {
      expect(result.stderr).not.toContain(forbidden);
    }
    expect(result.stderr).not.toContain("private failure");
  }, 30_000);
});
