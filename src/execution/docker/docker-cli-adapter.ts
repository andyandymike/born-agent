import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type {
  DetachedContainerRuntimePort,
  SanitizedContainerInspection,
} from "./container-lifecycle.js";
import type {
  DigestPinnedImageReference,
  LocalDockerImageInspection,
  LocalDockerImageInspector,
} from "./docker-policy.js";

const MAX_DOCKER_CONTROL_BYTES = 4 * 1024 * 1024;

export class DockerCliError extends Error {
  override readonly name = "DockerCliError";

  public constructor(
    readonly code: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

interface DockerCliResult {
  readonly exitCode: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}

function dockerCliEnvironment(
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

function appendBounded(
  target: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
): void {
  state.bytes += chunk.byteLength;
  if (state.bytes > MAX_DOCKER_CONTROL_BYTES) {
    throw new DockerCliError("docker_cli_output_limit", "Docker control output exceeded its fixed local limit");
  }
  target.push(Buffer.from(chunk));
}

function text(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value).trim();
  } catch {
    throw new DockerCliError("docker_cli_invalid_utf8", "Docker control output was not valid UTF-8");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerCliError("docker_inspect_invalid", "Docker inspect returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const output: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string" && name.length <= 200 && entry.length <= 2_048) output[name] = entry;
  }
  return Object.freeze(output);
}

function parseInspectArray(value: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(value));
  } catch (error) {
    if (error instanceof DockerCliError) throw error;
    throw new DockerCliError("docker_inspect_invalid_json", "Docker inspect returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 1) {
    throw new DockerCliError("docker_inspect_invalid", "Docker inspect must return at most one exact object");
  }
  return parsed.length === 0 ? null : record(parsed[0]);
}

function isAbsent(result: DockerCliResult): boolean {
  const value = `${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`;
  return /no such (?:object|container|image)/iu.test(value);
}

function containerStatus(value: string, running: boolean): SanitizedContainerInspection["status"] {
  if (running) return "running";
  return ["created", "dead", "exited", "removing"].includes(value)
    ? (value as SanitizedContainerInspection["status"])
    : "dead";
}

function normalizeDockerTimestamp(value: string): string | null {
  if (value.length === 0) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new DockerCliError(
      "docker_container_timestamp_invalid",
      "Docker container metadata contains an invalid timestamp",
    );
  }
  return new Date(milliseconds).toISOString();
}

export class NodeDockerCliAdapter
  implements DetachedContainerRuntimePort, LocalDockerImageInspector {
  readonly #environment: Readonly<Record<string, string>>;

  public constructor(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly executable = "docker",
  ) {
    this.#environment = dockerCliEnvironment(environment);
  }

  async daemonOperatingSystem(): Promise<string> {
    const result = await this.runCapture(["version", "--format", "{{.Server.Os}}"]);
    if (result.exitCode !== 0) {
      throw new DockerCliError("docker_daemon_unavailable", "local Docker daemon is unavailable");
    }
    const os = text(result.stdout);
    if (os.length === 0 || os.length > 50) {
      throw new DockerCliError("docker_daemon_invalid", "Docker daemon returned an invalid operating system");
    }
    return os;
  }

  async inspectLocal(
    reference: DigestPinnedImageReference,
  ): Promise<LocalDockerImageInspection | null> {
    // PHASE13: image inspect is local-only. Missing means fail; this adapter has
    // no pull/build/registry method and never tries a tag fallback.
    const result = await this.runCapture(["image", "inspect", reference.reference]);
    if (result.exitCode !== 0) {
      if (isAbsent(result)) return null;
      throw new DockerCliError("docker_image_inspect_failed", "could not inspect the local Docker image");
    }
    const inspected = parseInspectArray(result.stdout);
    if (inspected === null) return null;
    const config = record(inspected.Config);
    const repoDigests = Array.isArray(inspected.RepoDigests)
      ? inspected.RepoDigests.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (
      typeof inspected.Architecture !== "string" ||
      typeof inspected.Id !== "string" ||
      typeof inspected.Os !== "string" ||
      typeof config.User !== "string"
    ) {
      throw new DockerCliError("docker_image_inspect_invalid", "local Docker image metadata is incomplete");
    }
    return Object.freeze({
      architecture: inspected.Architecture,
      configuredUser: config.User,
      id: inspected.Id,
      labels: stringRecord(config.Labels),
      operatingSystem: inspected.Os,
      repoDigests: Object.freeze(repoDigests),
    });
  }

  async create(argv: readonly string[], signal: AbortSignal): Promise<string> {
    const result = await this.runCapture(argv, signal);
    if (result.exitCode !== 0) {
      throw new DockerCliError("docker_create_failed", "Docker create failed");
    }
    const id = text(result.stdout);
    if (!/^[a-f0-9]{64}$/u.test(id)) {
      throw new DockerCliError("docker_create_identity_invalid", "Docker create did not return one full container id");
    }
    return id;
  }

  async inspectById(containerId: string): Promise<SanitizedContainerInspection | null> {
    return this.inspectContainer(containerId);
  }

  async inspectByName(name: string): Promise<SanitizedContainerInspection | null> {
    return this.inspectContainer(name);
  }

  async startDetached(containerId: string, signal: AbortSignal): Promise<void> {
    await this.requireSuccess(["start", containerId], "docker_start_failed", signal);
  }

  async wait(containerId: string, signal: AbortSignal): Promise<number> {
    const result = await this.runCapture(["wait", containerId], signal);
    if (result.exitCode !== 0) {
      throw new DockerCliError("docker_wait_failed", "Docker wait failed");
    }
    const value = text(result.stdout);
    if (!/^\d{1,3}$/u.test(value) || Number(value) > 255) {
      throw new DockerCliError("docker_wait_invalid", "Docker wait returned an invalid exit code");
    }
    return Number(value);
  }

  async stop(containerId: string, graceSeconds: number): Promise<void> {
    await this.requireSuccess(["stop", "--time", String(graceSeconds), containerId], "docker_stop_failed");
  }

  async kill(containerId: string): Promise<void> {
    await this.requireSuccess(["kill", containerId], "docker_kill_failed");
  }

  async removeForce(containerId: string): Promise<void> {
    await this.requireSuccess(["rm", "-f", containerId], "docker_remove_failed");
  }

  async *collectBoundedLogs(
    containerId: string,
    signal: AbortSignal,
  ): AsyncIterable<{
    readonly bytes: number;
    readonly stream: "stderr" | "stdout";
    readonly text: string;
  }> {
    const child = this.spawn(["logs", "--follow", containerId]);
    const queue: Array<{ stream: "stderr" | "stdout"; text: string }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let failure: Error | undefined;
    const decoders = {
      stderr: new TextDecoder("utf-8", { fatal: false }),
      stdout: new TextDecoder("utf-8", { fatal: false }),
    };
    const push = (stream: "stderr" | "stdout", chunk: Buffer, final = false): void => {
      const decoded = decoders[stream].decode(chunk, { stream: !final });
      if (decoded.length > 0) queue.push({ stream, text: decoded });
      wake?.();
      wake = undefined;
    };
    child.stdout.on("data", (chunk: Buffer) => push("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => push("stderr", chunk));
    const abort = (): void => {
      child.kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      failure = new DockerCliError("docker_logs_failed", "could not start Docker logs", { cause: error });
      closed = true;
      wake?.();
    });
    child.once("close", (code) => {
      push("stdout", Buffer.alloc(0), true);
      push("stderr", Buffer.alloc(0), true);
      if (!signal.aborted && code !== 0) {
        failure = new DockerCliError("docker_logs_failed", "Docker logs ended with an error");
      }
      closed = true;
      wake?.();
    });
    try {
      while (!closed || queue.length > 0) {
        const entry = queue.shift();
        if (entry !== undefined) {
          yield {
            bytes: Buffer.byteLength(entry.text, "utf8"),
            stream: entry.stream,
            text: entry.text,
          };
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure !== undefined) throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!closed) child.kill();
    }
  }

  private async inspectContainer(identity: string): Promise<SanitizedContainerInspection | null> {
    const result = await this.runCapture(["inspect", identity]);
    if (result.exitCode !== 0) {
      if (isAbsent(result)) return null;
      throw new DockerCliError("docker_container_inspect_failed", "could not inspect the exact Docker container");
    }
    const inspected = parseInspectArray(result.stdout);
    if (inspected === null) return null;
    const config = record(inspected.Config);
    const state = record(inspected.State);
    if (
      typeof inspected.Id !== "string" ||
      typeof inspected.Image !== "string" ||
      typeof inspected.Name !== "string" ||
      typeof config.Image !== "string" ||
      typeof state.Running !== "boolean" ||
      typeof state.OOMKilled !== "boolean" ||
      typeof state.Status !== "string" ||
      typeof state.Error !== "string" ||
      typeof state.StartedAt !== "string" ||
      typeof state.FinishedAt !== "string" ||
      typeof state.ExitCode !== "number"
    ) {
      throw new DockerCliError("docker_container_inspect_invalid", "Docker container metadata is incomplete");
    }
    return Object.freeze({
      containerId: inspected.Id,
      exitCode: state.Running ? null : state.ExitCode,
      finishedAt: normalizeDockerTimestamp(state.FinishedAt),
      imageId: inspected.Image,
      imageReference: config.Image,
      labels: stringRecord(config.Labels),
      name: inspected.Name.replace(/^\//u, ""),
      oomKilled: state.OOMKilled,
      running: state.Running,
      startedAt: normalizeDockerTimestamp(state.StartedAt),
      stateError: state.Error.length === 0 ? null : state.Error.slice(0, 500),
      status: containerStatus(state.Status, state.Running),
    });
  }

  private async requireSuccess(
    argv: readonly string[],
    code: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.runCapture(argv, signal);
    if (result.exitCode !== 0) throw new DockerCliError(code, `${argv[0]} failed for the exact Docker object`);
  }

  private spawn(argv: readonly string[]): ChildProcessByStdio<null, Readable, Readable> {
    return spawn(this.executable, [...argv], {
      env: this.#environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  private runCapture(
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<DockerCliResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DockerCliError("docker_cli_aborted", "Docker CLI operation was cancelled"));
        return;
      }
      const child = this.spawn(argv);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const state = { bytes: 0 };
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };
      const capture = (target: Buffer[], chunk: Buffer): void => {
        try {
          appendBounded(target, chunk, state);
        } catch (error) {
          fail(error);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      const abort = (): void => fail(new DockerCliError("docker_cli_aborted", "Docker CLI operation was cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        fail(new DockerCliError("docker_cli_spawn_failed", "could not start the local Docker CLI", { cause: error }));
      });
      child.once("close", (exitCode) => {
        signal?.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        resolve({
          exitCode: exitCode ?? 1,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        });
      });
    });
  }
}
