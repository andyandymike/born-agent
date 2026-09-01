import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from "node:child_process";

import { describe, expect, it } from "vitest";

import { createNodeSpawnAdapter } from "../../src/execution/local-executor.js";
import {
  createTaskkillArgvRunner,
  type TaskkillSpawnedProcess,
} from "../../src/execution/process-tree-cleanup.js";
import { sanitizeChildEnvironment } from "../../src/security/child-environment.js";
import { runExecutable } from "../../src/system/run-executable.js";
import { RipgrepRunner } from "../../src/tools/ripgrep-runner.js";
import { NodeGitArgvRunner } from "../../src/verification/git-argv-runner.js";

const SENTINEL_ENVIRONMENT = Object.freeze({
  AnThRoPiC_ApI_KeY: "anthropic-phase8-sentinel",
  DeEpSeEk_ApI_KeY: "deepseek-phase8-sentinel",
  OpenAi_Api_Key: "openai-phase8-sentinel",
  PATH: process.env.PATH ?? "",
  SAFE_CHILD_VALUE: "preserved",
});

const ENV_PROBE = String.raw`
const forbidden = new Set(["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]);
const leaked = Object.keys(process.env).filter((name) => forbidden.has(name.toUpperCase()));
process.stdout.write(JSON.stringify({ leaked, safe: process.env.SAFE_CHILD_VALUE }));
`;

function expectSanitized(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): void {
  expect(environment).toBeDefined();
  expect(
    Object.keys(environment ?? {}).filter((name) =>
      ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"].includes(
        name.toUpperCase(),
      ),
    ),
  ).toEqual([]);
  expect(environment?.SAFE_CHILD_VALUE).toBe("preserved");
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    kill(): boolean;
    stderr: PassThrough;
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("Phase 8 child environment boundary", () => {
  it("removes every provider-key casing without mutating the source", () => {
    const sanitized = sanitizeChildEnvironment(SENTINEL_ENVIRONMENT);

    expectSanitized(sanitized);
    expect(Object.isFrozen(sanitized)).toBe(true);
    expect(SENTINEL_ENVIRONMENT.OpenAi_Api_Key).toBe(
      "openai-phase8-sentinel",
    );
    expect(SENTINEL_ENVIRONMENT.AnThRoPiC_ApI_KeY).toBe(
      "anthropic-phase8-sentinel",
    );
    expect(SENTINEL_ENVIRONMENT.DeEpSeEk_ApI_KeY).toBe(
      "deepseek-phase8-sentinel",
    );
  });

  it("sanitizes the reviewed command final spawn boundary", () => {
    let observed: Readonly<Record<string, string | undefined>> | undefined;
    const child = fakeChild();
    const spawn = ((
      _file: string,
      _args: readonly string[],
      options: { readonly env?: Readonly<Record<string, string | undefined>> },
    ) => {
      observed = options.env;
      return child;
    }) as unknown as typeof nodeSpawn;

    createNodeSpawnAdapter(spawn)(process.execPath, [], {
      cwd: process.cwd(),
      detached: false,
      environment: SENTINEL_ENVIRONMENT,
      shell: false,
    });

    expectSanitized(observed);
  });

  it("sanitizes the ripgrep and taskkill helper boundaries", async () => {
    let ripgrepEnvironment:
      | Readonly<Record<string, string | undefined>>
      | undefined;
    const ripgrepChild = fakeChild();
    const ripgrep = new RipgrepRunner(
      (_args, _cwd, environment) => {
        ripgrepEnvironment = environment;
        queueMicrotask(() => ripgrepChild.emit("close", 0));
        return ripgrepChild;
      },
      SENTINEL_ENVIRONMENT,
    );
    await expect(
      ripgrep.run(["--version"], {
        cwd: process.cwd(),
        maxStdoutBytes: 1024,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ kind: "completed" });
    expectSanitized(ripgrepEnvironment);

    let taskkillEnvironment:
      | Readonly<Record<string, string | undefined>>
      | undefined;
    const taskkillChild = new EventEmitter() as EventEmitter &
      TaskkillSpawnedProcess;
    const taskkill = createTaskkillArgvRunner(
      (_file, _args, options) => {
        taskkillEnvironment = options.env;
        queueMicrotask(() => taskkillChild.emit("close", 0));
        return taskkillChild;
      },
      SENTINEL_ENVIRONMENT,
    );
    await expect(taskkill(["/PID", "123", "/T"])).resolves.toBe(0);
    expectSanitized(taskkillEnvironment);
  });

  it("keeps provider keys out of doctor and Git subprocesses", async () => {
    const doctor = await runExecutable(
      process.execPath,
      ["-e", ENV_PROBE],
      5_000,
      SENTINEL_ENVIRONMENT,
    );
    expect(doctor).toMatchObject({ kind: "completed", exitCode: 0 });
    if (doctor.kind !== "completed") throw new Error("doctor probe failed");
    expect(JSON.parse(doctor.stdout)).toEqual({ leaked: [], safe: "preserved" });

    const git = await new NodeGitArgvRunner(
      process.execPath,
      SENTINEL_ENVIRONMENT,
    ).run(process.cwd(), ["-e", ENV_PROBE]);
    expect(git.exitCode).toBe(0);
    expect(JSON.parse(git.stdout.toString("utf8"))).toEqual({
      leaked: [],
      safe: "preserved",
    });
  });
});
