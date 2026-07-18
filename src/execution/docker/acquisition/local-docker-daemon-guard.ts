import type { DockerAcquisitionCommandPort } from "./docker-acquisition-port.js";
import { DockerAcquisitionError } from "./docker-acquisition-errors.js";

const FORBIDDEN_OVERRIDES = new Set([
  "BUILDKIT_HOST",
  "BUILDX_BUILDER",
  "DOCKER_AUTH_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
]);

export interface LocalDockerDaemonEvidence {
  readonly architecture: "amd64" | "arm64";
  readonly context: "default";
  readonly endpoint: string;
  readonly operatingSystem: "linux";
  readonly registryMirrors: readonly string[];
}

function output(result: { readonly exitCode: number; readonly stdout: string }): string {
  if (result.exitCode !== 0) {
    throw new DockerAcquisitionError(
      "docker_daemon_unavailable",
      "local Docker daemon is unavailable; start Docker Desktop/Engine explicitly",
      3,
    );
  }
  return result.stdout.trim();
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new DockerAcquisitionError(
      "docker_daemon_evidence_invalid",
      `Docker ${label} evidence is invalid`,
      3,
      { cause: error },
    );
  }
}

export class LocalDockerDaemonGuard {
  public constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly platform: NodeJS.Platform,
  ) {}

  async assertLocal(
    port: DockerAcquisitionCommandPort,
  ): Promise<LocalDockerDaemonEvidence> {
    for (const [name, value] of Object.entries(this.environment)) {
      if (
        value !== undefined &&
        value.trim().length > 0 &&
        FORBIDDEN_OVERRIDES.has(name.toUpperCase())
      ) {
        throw new DockerAcquisitionError(
          "docker_remote_override_denied",
          `${name.toUpperCase()} is denied for locked local Docker acquisition`,
          2,
        );
      }
    }
    const context = output(await port.run(["context", "show"]));
    if (context !== "default") {
      throw new DockerAcquisitionError(
        "docker_context_not_local",
        "anonymous Docker acquisition requires the isolated default context",
        2,
      );
    }
    const endpoint = parseJson<string>(
      output(
        await port.run([
          "context",
          "inspect",
          "default",
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ]),
      ),
      "endpoint",
    );
    // PHASE15: a command named `docker build` does not prove locality. The
    // isolated context must resolve to a canonical local socket/named pipe;
    // TCP, SSH, HTTP, cloud contexts, and builder overrides fail closed.
    const localEndpoint =
      this.platform === "win32"
        ? [
            "npipe:////./pipe/docker_engine",
            "npipe:////./pipe/dockerDesktopLinuxEngine",
          ].includes(endpoint)
        : endpoint === "unix:///var/run/docker.sock";
    if (!localEndpoint) {
      throw new DockerAcquisitionError(
        "docker_endpoint_not_local",
        "Docker endpoint is not a canonical local daemon socket",
        2,
      );
    }
    const server = output(
      await port.run(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]),
    );
    const [operatingSystem, architecture] = server.split("/");
    if (
      operatingSystem !== "linux" ||
      (architecture !== "amd64" && architecture !== "arm64")
    ) {
      throw new DockerAcquisitionError(
        "docker_daemon_platform_denied",
        "Docker daemon must run Linux containers on amd64 or arm64",
        3,
      );
    }
    const mirrors = parseJson<unknown>(
      output(
        await port.run([
          "info",
          "--format",
          "{{json .RegistryConfig.Mirrors}}",
        ]),
      ),
      "registry mirror",
    );
    if (!Array.isArray(mirrors) || mirrors.length !== 0) {
      throw new DockerAcquisitionError(
        "docker_registry_mirror_denied",
        "locked acquisition requires an empty registry mirror list",
        2,
      );
    }
    return Object.freeze({
      architecture,
      context: "default",
      endpoint,
      operatingSystem: "linux",
      registryMirrors: Object.freeze([]),
    });
  }
}
