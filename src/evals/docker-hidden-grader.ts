import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DOCKER_SANDBOX_WRAPPER } from "../execution/docker/docker-policy.js";
import { EvalCoreError } from "./eval-errors.js";
import {
  HiddenGraderRunner,
  type GraderContainerSpec,
  type HiddenGraderPort,
} from "./hidden-grader-runner.js";
import { loadProtocolCases } from "./protocol-case-loader.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";
import type {
  EvalHiddenGrader,
  HiddenGradeResult,
} from "./static-hidden-grader.js";

const MAX_CONTROL_BYTES = 1024 * 1024;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;

const WORKER_SOURCE = `import { readFile } from "node:fs/promises";
const request = JSON.parse(await readFile("/runner/request.json", "utf8"));
const answer = await readFile("/workspace/" + request.entry, "utf8").catch(() => "");
if (Buffer.byteLength(answer, "utf8") > 1048576) process.exit(70);
for (const item of request.cases) {
  const value = request.mode === "protocol" ? answer.trimEnd() : answer;
  process.stdout.write(JSON.stringify({ case_id: item.id, value }) + "\\n");
}
`;

interface DockerControlResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DockerGraderControlPort {
  run(
    argv: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DockerControlResult>;
}

function dockerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const allowed = new Set([
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "WINDIR",
  ]);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).filter(
        ([name, value]) => value !== undefined && allowed.has(name.toUpperCase()),
      ) as [string, string][],
    ),
  );
}

function decodeUtf8(chunks: readonly Buffer[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new EvalCoreError(
      "eval_hidden_grader_invalid",
      "Docker grader control output was not UTF-8",
      1,
    );
  }
}

export class NodeDockerGraderControlPort implements DockerGraderControlPort {
  readonly #environment: Readonly<Record<string, string>>;

  public constructor(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly executable = "docker",
  ) {
    this.#environment = dockerEnvironment(environment);
  }

  public run(
    argv: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DockerControlResult> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Docker grader operation was cancelled"));
        return;
      }
      const child = spawn(this.executable, [...argv], {
        env: this.#environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("Docker grader control operation timed out"));
      }, timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        finish();
        child.kill();
        reject(error);
      };
      const capture = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > MAX_CONTROL_BYTES) {
          fail(new Error("Docker grader control output exceeded its fixed limit"));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      const abort = (): void => fail(new Error("Docker grader operation was cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => fail(error));
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        finish();
        resolve({
          exitCode: exitCode ?? 1,
          stderr: decodeUtf8(stderr),
          stdout: decodeUtf8(stdout),
        });
      });
    });
  }
}

function requireSuccess(result: DockerControlResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new EvalCoreError(
      "eval_hidden_grader_invalid",
      `Docker grader ${operation} failed`,
      1,
    );
  }
}

class DockerHiddenGraderPort implements HiddenGraderPort {
  readonly #active = new Map<"supervisor" | "worker", string>();

  public constructor(
    private readonly control: DockerGraderControlPort,
    private readonly observationsPath: string,
    private readonly randomId: () => string,
  ) {}

  public async preflight(image: string): Promise<void> {
    const signal = new AbortController().signal;
    const daemon = await this.control.run(
      ["version", "--format", "{{.Server.Os}}"],
      signal,
      5_000,
    );
    if (daemon.exitCode !== 0 || daemon.stdout.trim() !== "linux") {
      throw new EvalCoreError(
        "eval_cli_invalid",
        "local Linux Docker daemon is required for the hidden grader",
        2,
      );
    }
    const inspected = await this.control.run(
      ["image", "inspect", image, "--format", "{{.Id}}"],
      signal,
      5_000,
    );
    if (
      inspected.exitCode !== 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(inspected.stdout.trim())
    ) {
      // PHASE14: inspect-only preflight and `--pull=never` make a missing
      // grader image a local config error, never an implicit registry request.
      throw new EvalCoreError(
        "eval_cli_invalid",
        "digest-pinned hidden-grader image is not present locally",
        2,
      );
    }
  }

  public async runWorker(
    spec: GraderContainerSpec,
    signal: AbortSignal,
  ): Promise<{ readonly observationsPath: string }> {
    const exitCode = await this.runContainer(spec, signal);
    if (exitCode !== 0) {
      throw new EvalCoreError(
        "eval_hidden_grader_invalid",
        "generic candidate worker failed",
        1,
      );
    }
    const containerId = this.#active.get("worker");
    if (containerId === undefined) throw new Error("worker identity disappeared");
    const logs = await this.control.run(
      ["logs", containerId],
      signal,
      Math.min(5_000, spec.command.timeoutMs),
    );
    requireSuccess(logs, "worker log collection");
    await mkdir(this.observationsPath, { recursive: true });
    await writeFile(
      path.join(this.observationsPath, "observations.jsonl"),
      logs.stdout,
      "utf8",
    );
    return Object.freeze({ observationsPath: this.observationsPath });
  }

  public async runSupervisor(
    spec: GraderContainerSpec,
    observationsPath: string,
    signal: AbortSignal,
  ): Promise<{ readonly exitCode: number }> {
    if (path.resolve(observationsPath) !== path.resolve(this.observationsPath)) {
      throw new EvalCoreError(
        "eval_hidden_grader_invalid",
        "worker observations identity changed before grading",
        1,
      );
    }
    return Object.freeze({ exitCode: await this.runContainer(spec, signal) });
  }

  public async cleanup(phase: "worker" | "supervisor"): Promise<boolean> {
    const containerId = this.#active.get(phase);
    if (containerId === undefined) return true;
    const signal = new AbortController().signal;
    const removed = await this.control.run(
      ["rm", "--force", containerId],
      signal,
      5_000,
    ).catch(() => null);
    if (removed?.exitCode !== 0) return false;
    const inspected = await this.control.run(
      ["inspect", containerId],
      signal,
      5_000,
    ).catch(() => null);
    if (inspected === null || inspected.exitCode === 0) return false;
    this.#active.delete(phase);
    return true;
  }

  async runContainer(
    spec: GraderContainerSpec,
    signal: AbortSignal,
  ): Promise<number> {
    if (this.#active.has(spec.phase)) {
      throw new Error(`grader ${spec.phase} container is already active`);
    }
    const suffix = this.randomId().replace(/-/gu, "").slice(-24);
    if (!/^[0-9a-f]{24}$/u.test(suffix)) {
      throw new Error("grader container suffix is not canonical");
    }
    const name = `bornagent-grader-${spec.phase}-${suffix}`;
    const argv = [
      "create",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--ulimit",
      "nofile=1024:1024",
      "--init",
      "--user",
      spec.runAs,
      "--entrypoint",
      DOCKER_SANDBOX_WRAPPER,
      "--workdir",
      spec.command.cwd,
      ...spec.mounts.flatMap((mount) => [
        "--volume",
        `${mount.source}:${mount.target}:ro`,
      ]),
      spec.image,
      spec.command.executable,
      ...spec.command.args,
    ];
    const created = await this.control.run(argv, signal, 10_000);
    requireSuccess(created, `${spec.phase} create`);
    const containerId = created.stdout.trim();
    if (!CONTAINER_ID.test(containerId)) {
      throw new EvalCoreError(
        "eval_hidden_grader_invalid",
        "Docker grader returned an invalid container identity",
        1,
      );
    }
    this.#active.set(spec.phase, containerId);
    requireSuccess(
      await this.control.run(["start", containerId], signal, 10_000),
      `${spec.phase} start`,
    );
    const waited = await this.control.run(
      ["wait", containerId],
      signal,
      spec.command.timeoutMs,
    );
    requireSuccess(waited, `${spec.phase} wait`);
    const value = waited.stdout.trim();
    if (!/^\d{1,3}$/u.test(value) || Number(value) > 255) {
      throw new EvalCoreError(
        "eval_hidden_grader_invalid",
        "Docker grader returned an invalid process exit code",
        1,
      );
    }
    return Number(value);
  }
}

export interface DockerHiddenGraderOptions {
  readonly control?: DockerGraderControlPort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly image: string;
  readonly randomUUID?: () => string;
}

export class DockerHiddenGrader implements EvalHiddenGrader {
  readonly #control: DockerGraderControlPort;
  readonly #randomUUID: () => string;

  public constructor(private readonly options: DockerHiddenGraderOptions) {
    if (!DIGEST_IMAGE.test(options.image)) {
      throw new EvalCoreError(
        "eval_cli_invalid",
        "hidden-grader image must be an exact lowercase digest reference",
        2,
      );
    }
    this.#control =
      options.control ?? new NodeDockerGraderControlPort(options.environment);
    this.#randomUUID = options.randomUUID ?? randomUUID;
  }

  public async preflight(): Promise<void> {
    const port = new DockerHiddenGraderPort(
      this.#control,
      path.resolve("."),
      this.#randomUUID,
    );
    await port.preflight(this.options.image);
  }

  public async grade(
    task: LoadedEvalTaskAsset,
    workspacePath: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<HiddenGradeResult> {
    const codes: string[] = [];
    for (const acceptance of task.task.manifest.acceptance) {
      const runtimeRoot = path.join(
        path.dirname(workspacePath),
        "grader-runtime",
        acceptance.id,
      );
      const runnerPath = path.join(runtimeRoot, "runner");
      const observationsPath = path.join(runtimeRoot, "observations");
      await mkdir(runnerPath, { recursive: true });
      await mkdir(observationsPath, { recursive: true });
      let cases: readonly { readonly id: string; readonly input: unknown }[];
      if (acceptance.kind === "protocol") {
        const inputs = JSON.parse(
          await readFile(path.join(task.taskRoot, acceptance.inputs_ref), "utf8"),
        ) as unknown;
        const expected = JSON.parse(
          await readFile(path.join(task.taskRoot, acceptance.expected_ref), "utf8"),
        ) as unknown;
        const loaded = loadProtocolCases(inputs, expected);
        cases = Object.freeze(
          loaded.caseIds.map((id) => ({ id, input: loaded.inputs.get(id) })),
        );
      } else {
        cases = Object.freeze([{ id: "static", input: null }]);
      }
      // PHASE14: the runner bundle contains public inputs and generic code,
      // never expected values or grader commands. It is mounted only after the
      // Agent terminates and cannot be fed back into a later model turn.
      await writeFile(path.join(runnerPath, "worker.mjs"), WORKER_SOURCE, "utf8");
      await writeFile(
        path.join(runnerPath, "request.json"),
        `${JSON.stringify({
          cases,
          entry:
            acceptance.kind === "protocol"
              ? acceptance.worker.entry
              : "answer.txt",
          mode: acceptance.kind,
          schema_version: 1,
        })}\n`,
        "utf8",
      );
      const port = new DockerHiddenGraderPort(
        this.#control,
        observationsPath,
        this.#randomUUID,
      );
      const passed = await new HiddenGraderRunner(port).run(
        {
          expectedExit: acceptance.grader.expected_exit,
          graderPath: task.graderRoot,
          image: this.options.image,
          observationsPath,
          runnerPath,
          supervisorCommand: Object.freeze({
            args: Object.freeze([...acceptance.grader.args]),
            cwd: acceptance.grader.cwd,
            executable: acceptance.grader.executable,
            timeoutMs: acceptance.grader.timeout_ms,
          }),
          workerCommand: Object.freeze({
            args: Object.freeze(["/runner/worker.mjs"]),
            cwd: "/runner",
            executable: "node",
            timeoutMs:
              acceptance.kind === "protocol"
                ? acceptance.worker.timeout_ms
                : task.task.manifest.limits.grader_duration_ms,
          }),
          workspacePath,
        },
        signal,
      );
      if (!passed) codes.push(`hidden_${acceptance.kind}_mismatch`);
    }
    return Object.freeze({
      passed: codes.length === 0,
      secondaryCodes: Object.freeze(codes),
    });
  }
}
