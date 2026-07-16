import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCommandActionIdentity } from "../../src/permissions/action-digest.js";
import { executeAndCollect } from "../../src/execution/executor.js";
import { filterExecutionEnvironment } from "../../src/execution/environment-filter.js";
import type {
  ExecutionResult,
  ExecutionSignal,
  PreparedExecution,
} from "../../src/execution/execution-types.js";
import {
  createNodeSpawnAdapter,
  LocalExecutor,
} from "../../src/execution/local-executor.js";
import {
  createTaskkillArgvRunner,
  NodeProcessTreeCleanup,
} from "../../src/execution/process-tree-cleanup.js";

const fixtureDirectory = resolve("fixtures", "phase-06-command-execution");
const temporaryDirectories: string[] = [];
// Codex's managed Windows sandbox denies taskkill even for children owned by the
// current test process. The same real-process tests remain enabled on normal Windows
// hosts and all POSIX hosts; the adapter race is still covered below when managed.
const realTerminationIt =
  process.platform === "win32" &&
  process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined
    ? it.skip
    : it;
const timers = {
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

function isAlive(identity: number): boolean {
  try {
    process.kill(identity, 0);
    return true;
  } catch {
    return false;
  }
}

function createExecutor(): LocalExecutor {
  const cleanup = new NodeProcessTreeCleanup({
    isProcessAlive: isAlive,
    killProcess(identity, signal) {
      process.kill(identity, signal);
    },
    platform: process.platform,
    ...(process.platform === "win32"
      ? {
          taskkill: createTaskkillArgvRunner((file, args, options) =>
            spawn(file, [...args], options),
          ),
        }
      : {}),
    timers,
  });
  return new LocalExecutor({
    clock: { now: Date.now },
    platform: process.platform,
    processTreeCleanup: cleanup,
    spawn: createNodeSpawnAdapter(spawn),
    timers,
  });
}

function prepared(options: {
  readonly cwd?: string;
  readonly script: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly executableFile?: string;
}): PreparedExecution {
  const environment = filterExecutionEnvironment({
    hostEnvironment: options.hostEnvironment ?? process.env,
    platform: process.platform,
  });
  const args = [options.script, ...(options.args ?? [])];
  const action = createCommandActionIdentity({
    actionKind: "command",
    argv: args,
    binary: {
      bytesSha256: "a".repeat(64),
      canonicalIdentity: "trusted-test-node",
      version: process.version,
    },
    canonicalCwd: ".",
    environmentPolicy: environment.policy,
    executionInputs: {
      lockfileSha256: null,
      manifestSha256: null,
      runnerConfigHashes: [],
    },
    lifecycleScripts: null,
    logicalExecutable: "node",
    outputLimitBytes: options.outputLimitBytes ?? 32_768,
    packageManager: null,
    purpose: "inspect",
    timeoutMs: options.timeoutMs ?? 2000,
  });
  return Object.freeze({
    actionIdentity: action,
    actionSha256: action.actionSha256,
    executionInputsSha256: action.executionInputsSha256,
    request: Object.freeze({
      args: Object.freeze(args),
      cwd: options.cwd ?? fixtureDirectory,
      environment: environment.values,
      executableFile: options.executableFile ?? process.execPath,
      logicalExecutable: "node",
      outputLimitBytes: options.outputLimitBytes ?? 32_768,
      purpose: "inspect",
      timeoutMs: options.timeoutMs ?? 2000,
    }),
    revalidate: async () => "current" as const,
    review: Object.freeze({ lifecycleScripts: [], warning: "test fixture" }),
  });
}

async function run(
  execution: PreparedExecution,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ExecutionResult; readonly signals: ExecutionSignal[] }> {
  const signals: ExecutionSignal[] = [];
  const result = await executeAndCollect(
    createExecutor(),
    execution,
    signal,
    {
      onSignal(event) {
        signals.push(event);
      },
    },
  );
  return { result, signals };
}

async function readIdentitiesEventually(path: string): Promise<{
  readonly grandchildPid: number;
  readonly parentPid: number;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        grandchildPid: number;
        parentPid: number;
      };
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error("fixture did not publish process identities");
}

describe("Phase 6 local executor", () => {
  it("passes metacharacters as literal argv and reports non-zero exit as observation", async () => {
    const argumentsRun = await run(
      prepared({
        args: [";", "|", ">", "$()", "&", "node delete-sentinel.mjs"],
        script: "print-args.mjs",
      }),
    );
    expect(JSON.parse(argumentsRun.result.stdout)).toEqual([
      ";",
      "|",
      ">",
      "$()",
      "&",
      "node delete-sentinel.mjs",
    ]);
    expect(
      await readFile(join(fixtureDirectory, "sentinel.txt"), "utf8"),
    ).toContain("must-remain");

    const failed = await run(prepared({ script: "fail.mjs" }));
    expect(failed.result).toMatchObject({
      exitCode: 7,
      ok: true,
      termination: "exit",
    });
    expect(failed.result.stderr).toContain("intentional-failure");
  });

  it("keeps channel order, sanitizes controls, and reports persisted byte totals", async () => {
    const execution = await run(prepared({ script: "mixed-output.mjs" }));
    expect(execution.result.stdout).toBe("stdout-1-你好\nstdout-2\n");
    expect(execution.result.stderr).toBe("stderr-1-世界\nstderr-2\nreplaced\n");
    expect(execution.result.stdout).not.toContain("\u001b");

    const outputs = execution.signals.filter(
      (signal): signal is Extract<ExecutionSignal, { type: "output" }> =>
        signal.type === "output",
    );
    const stdoutBytes = outputs
      .filter((output) => output.stream === "stdout")
      .reduce((total, output) => total + output.chunkBytes, 0);
    const stderrBytes = outputs
      .filter((output) => output.stream === "stderr")
      .reduce((total, output) => total + output.chunkBytes, 0);
    expect(stdoutBytes).toBe(execution.result.stdoutBytes);
    expect(stderrBytes).toBe(execution.result.stderrBytes);
  });

  it("does not inherit provider, proxy, token, or Git credential variables", async () => {
    const execution = await run(
      prepared({
        hostEnvironment: {
          ...process.env,
          ANTHROPIC_API_KEY: "paid-secret",
          GIT_ASKPASS: "credential-helper",
          HTTPS_PROXY: "http://credential@proxy.invalid",
          OPENAI_API_KEY: "paid-secret",
          SERVICE_TOKEN: "secret",
        },
        script: "print-env.mjs",
      }),
    );
    const names = JSON.parse(execution.result.stdout) as string[];
    expect(names).not.toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "GIT_ASKPASS",
        "HTTPS_PROXY",
        "OPENAI_API_KEY",
        "SERVICE_TOKEN",
      ]),
    );
    expect(names).toEqual(expect.arrayContaining(["CI", "NO_COLOR"]));
  });

  it("inherits the reviewed Node guard and denies loopback before opening a socket", async () => {
    const execution = await run(prepared({ script: "network-attempt.mjs" }));
    expect(execution.result).toMatchObject({ exitCode: 0, termination: "exit" });
    expect(execution.result.stdout).toBe("bornagent_network_denied\n");
    expect(execution.result.stderr).toBe("");
  });

  realTerminationIt("preserves output-limit as first cause and does not deadlock", async () => {
    const execution = await run(
      prepared({
        outputLimitBytes: 4096,
        script: "flood.mjs",
        timeoutMs: 3000,
      }),
    );
    expect(execution.result).toMatchObject({
      cleanupVerified: true,
      ok: false,
      termination: "output_limit_exceeded",
      truncated: true,
    });
    expect(
      execution.result.stdoutBytes + execution.result.stderrBytes,
    ).toBeLessThanOrEqual(4096);
  });

  realTerminationIt("kills and verifies a timeout parent and grandchild tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase6-tree-"));
    temporaryDirectories.push(workspace);
    await cp(join(fixtureDirectory, "long-parent.mjs"), join(workspace, "long-parent.mjs"));
    await cp(join(fixtureDirectory, "grandchild.mjs"), join(workspace, "grandchild.mjs"));

    const execution = await run(
      prepared({
        args: ["pids.json"],
        cwd: workspace,
        script: "long-parent.mjs",
        timeoutMs: 300,
      }),
    );
    expect(execution.result).toMatchObject({
      cleanupVerified: true,
      termination: "timeout",
    });
    const identities = JSON.parse(
      await readFile(join(workspace, "pids.json"), "utf8"),
    ) as { parentPid: number; grandchildPid: number };
    expect(isAlive(identities.parentPid)).toBe(false);
    expect(isAlive(identities.grandchildPid)).toBe(false);
  }, 15_000);

  realTerminationIt("cleans the process tree when an event consumer stops after spawn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase6-consumer-"));
    temporaryDirectories.push(workspace);
    await cp(join(fixtureDirectory, "long-parent.mjs"), join(workspace, "long-parent.mjs"));
    await cp(join(fixtureDirectory, "grandchild.mjs"), join(workspace, "grandchild.mjs"));
    const pidPath = join(workspace, "pids.json");
    const iterator = createExecutor().execute(
        prepared({
          args: ["pids.json"],
          cwd: workspace,
          script: "long-parent.mjs",
          timeoutMs: 3000,
        }),
        new AbortController().signal,
      )[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value).toMatchObject({ type: "started" });
    const identities = await readIdentitiesEventually(pidPath);
    await iterator.return?.();

    expect(isAlive(identities.parentPid)).toBe(false);
    expect(isAlive(identities.grandchildPid)).toBe(false);
  }, 15_000);

  realTerminationIt("preserves cancellation as first cause", async () => {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), 100);
    try {
      const execution = await run(
        prepared({ script: "grandchild.mjs", timeoutMs: 3000 }),
        controller.signal,
      );
      expect(execution.result).toMatchObject({
        cleanupVerified: true,
        termination: "cancelled",
      });
    } finally {
      clearTimeout(handle);
    }
  });

  it("returns a bounded spawn failure without raw host errors", async () => {
    const execution = await run(
      prepared({
        executableFile: join(fixtureDirectory, "missing-node-binary"),
        script: "pass.mjs",
      }),
    );
    expect(execution.result).toMatchObject({
      errorCode: expect.any(String),
      ok: false,
      termination: "spawn_error",
    });
    expect(execution.result.stderr).toBe("");
  });

  it("treats post-taskkill liveness as authoritative across exit-code races", async () => {
    let alive = true;
    const taskkillArguments: string[][] = [];
    const cleanup = new NodeProcessTreeCleanup({
      forceWaitMs: 25,
      gracePeriodMs: 1,
      isProcessAlive: () => alive,
      killProcess: () => {},
      platform: "win32",
      taskkill: async (args) => {
        taskkillArguments.push([...args]);
        if (args.includes("/F")) {
          alive = false;
        }
        return 1;
      },
      timers,
    });

    await expect(cleanup.terminate(1234)).resolves.toMatchObject({
      forced: true,
      verified: true,
    });
    expect(taskkillArguments).toEqual([
      ["/PID", "1234", "/T"],
      ["/PID", "1234", "/T", "/F"],
    ]);
  });
});
