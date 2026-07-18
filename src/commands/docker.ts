import type { CliIO, CliRuntime } from "../cli/types.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import { resolveEffectiveRuntimePolicy } from "../policy/policy-resolver.js";
import { DockerAcquisitionError } from "../execution/docker/acquisition/docker-acquisition-errors.js";
import { BUILT_IN_DOCKER_ARTIFACT_ID } from "../execution/docker/acquisition/docker-artifact-registry.js";

export interface DockerArtifactCommandOptions {
  readonly artifact?: string | undefined;
  readonly json: boolean;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly source?: string | undefined;
}

function emitText(value: Readonly<Record<string, unknown>>, io: CliIO): void {
  io.stdout.write(
    [
      `Docker artifact:       ${String(value.artifactId)}`,
      `Artifact lock SHA:     ${String(value.artifactLockSha256)}`,
      `Artifact ready:        ${String(value.artifactReady)}`,
      `Locked base ready:     ${String(value.baseImageReady)}`,
      `Image identity:        ${value.imageIdentity === null ? "none" : JSON.stringify(value.imageIdentity)}`,
      `Registry accesses:     ${String(value.registryAccesses)}`,
      `Local builds:          ${String(value.builds)}`,
      "Registry credentials: 0 reads",
      "Docker pushes:        0",
      "Remote builds:        0",
      "",
    ].join("\n"),
  );
}

async function effectivePolicy(
  options: DockerArtifactCommandOptions,
  runtime: CliRuntime,
) {
  return resolveEffectiveRuntimePolicy(
    await loadRuntimePolicyRegistry({
      ...(options.policyConfig === undefined
        ? {}
        : { configPath: options.policyConfig }),
      env: runtime.env,
      platform: runtime.platform,
      workspace: runtime.cwd,
    }),
    options.policyProfile,
  );
}

function failure(error: unknown, io: CliIO): number {
  if (error instanceof RuntimePolicyError || error instanceof DockerAcquisitionError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  io.stderr.write("docker_acquisition_internal: Docker acquisition failed internally\n");
  return 1;
}

export async function executeDockerStatus(
  options: DockerArtifactCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  if (runtime.dockerArtifactAcquirer === undefined) {
    io.stderr.write("docker_acquisition_unavailable: runtime has no Docker acquisition port\n");
    return 1;
  }
  try {
    const result = await runtime.dockerArtifactAcquirer.status({
      artifactId: options.artifact ?? BUILT_IN_DOCKER_ARTIFACT_ID,
      policy: await effectivePolicy(options, runtime),
    });
    if (options.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else emitText(result as unknown as Readonly<Record<string, unknown>>, io);
    return result.artifactReady ? 0 : 3;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeDockerPrepare(
  options: DockerArtifactCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  if (runtime.dockerArtifactAcquirer === undefined) {
    io.stderr.write("docker_acquisition_unavailable: runtime has no Docker acquisition port\n");
    return 1;
  }
  if (
    options.source !== undefined &&
    options.source !== "pull" &&
    options.source !== "build"
  ) {
    io.stderr.write("usage/config error: --source must be pull or build\n");
    return 2;
  }
  try {
    const result = await runtime.dockerArtifactAcquirer.prepare({
      artifactId: options.artifact ?? BUILT_IN_DOCKER_ARTIFACT_ID,
      policy: await effectivePolicy(options, runtime),
      ...(options.source === undefined
        ? {}
        : { source: options.source as "build" | "pull" }),
    });
    if (options.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else emitText(result as unknown as Readonly<Record<string, unknown>>, io);
    return result.requestedSource === "pull" || result.artifactReady ? 0 : 3;
  } catch (error) {
    return failure(error, io);
  }
}
