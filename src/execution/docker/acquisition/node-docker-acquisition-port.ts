import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DockerAcquisitionCommandPort,
  DockerAcquisitionCommandResult,
} from "./docker-acquisition-port.js";
import { DockerAcquisitionError } from "./docker-acquisition-errors.js";

const MAX_CONTROL_BYTES = 4 * 1024 * 1024;

function minimalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  dockerConfig: string,
): Readonly<Record<string, string>> {
  const allowed = new Set([
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "PROGRAMFILES",
    "PROGRAMW6432",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "WINDIR",
  ]);
  const entries = Object.entries(source).filter(
    ([name, value]) => value !== undefined && allowed.has(name.toUpperCase()),
  ) as [string, string][];
  return Object.freeze({
    ...Object.fromEntries(entries),
    DOCKER_BUILDKIT: "1",
    DOCKER_CONFIG: dockerConfig,
  });
}

function decode(parts: readonly Buffer[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch (error) {
    throw new DockerAcquisitionError(
      "docker_cli_invalid_utf8",
      "Docker control output was not valid UTF-8",
      3,
      { cause: error },
    );
  }
}

export class NodeDockerAcquisitionPort
  implements DockerAcquisitionCommandPort
{
  public constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly executable = "docker",
  ) {}

  async run(
    argv: readonly string[],
    options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
  ): Promise<DockerAcquisitionCommandResult> {
    if (
      argv.length === 0 ||
      argv.length > 64 ||
      argv.some(
        (argument) =>
          argument.length === 0 ||
          argument.length > 2_048 ||
          /[\0\r\n]/u.test(argument),
      )
    ) {
      throw new DockerAcquisitionError(
        "docker_cli_argv_invalid",
        "Docker acquisition argv is outside the fixed bound",
        1,
      );
    }
    const config = await mkdtemp(path.join(tmpdir(), "bornagent-docker-anonymous-"));
    try {
      // PHASE15: every control command receives a fresh empty DOCKER_CONFIG
      // and a minimal environment. Registry auth, credential helpers, provider
      // keys, proxies, SSH agents, and remote-builder state cannot cross here.
      return await new Promise<DockerAcquisitionCommandResult>((resolve, reject) => {
        const child = spawn(this.executable, [...argv], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: minimalEnvironment(this.environment, config),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const timeoutMs = options.timeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(
            new DockerAcquisitionError(
              "docker_cli_timeout",
              "local Docker control command exceeded its fixed timeout",
              3,
            ),
          );
        }, timeoutMs);
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(error);
        };
        const capture = (target: Buffer[], chunk: Buffer): void => {
          bytes += chunk.byteLength;
          if (bytes > MAX_CONTROL_BYTES) {
            fail(
              new DockerAcquisitionError(
                "docker_cli_output_limit",
                "Docker control output exceeded its fixed limit",
                3,
              ),
            );
            return;
          }
          target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
        child.once("error", (error) => {
          fail(
            new DockerAcquisitionError(
              "docker_cli_spawn_failed",
              "could not start the local Docker CLI",
              3,
              { cause: error },
            ),
          );
        });
        child.once("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(
              Object.freeze({
                exitCode: exitCode ?? 1,
                stderr: decode(stderr),
                stdout: decode(stdout),
              }),
            );
          } catch (error) {
            reject(error);
          }
        });
      });
    } finally {
      await rm(config, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}
