import {
  validateDockerImagePolicy,
  validateDockerResourceLimits,
  validateLocalDockerImage,
  type LocalDockerImageInspector,
  type DockerResourceLimits,
} from "./docker-policy.js";

export interface DockerSandboxDoctorConfig {
  readonly expectedLockfileSha256?: string;
  readonly image: string;
  readonly imagePath: string;
  readonly limits: DockerResourceLimits;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly supportsCUtf8: boolean;
  readonly wrapperSha256: string;
}

export interface DockerSandboxDoctorPort extends LocalDockerImageInspector {
  daemonOperatingSystem(): Promise<string>;
}

export interface DockerSandboxDoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

export interface DockerSandboxDoctorReport {
  readonly checks: readonly DockerSandboxDoctorCheck[];
  readonly failed: number;
  readonly ok: boolean;
  readonly passed: number;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "Docker policy check failed";
}

function report(checks: readonly DockerSandboxDoctorCheck[]): DockerSandboxDoctorReport {
  const passed = checks.filter((check) => check.ok).length;
  return Object.freeze({
    checks: Object.freeze([...checks]),
    failed: checks.length - passed,
    ok: passed === checks.length,
    passed,
  });
}

export async function runDockerSandboxDoctor(
  config: DockerSandboxDoctorConfig,
  port: DockerSandboxDoctorPort,
): Promise<DockerSandboxDoctorReport> {
  // PHASE13: Doctor has only local version/image-inspect ports. A missing image
  // is a configuration failure, never authority to pull or use a remote builder.
  const checks: DockerSandboxDoctorCheck[] = [];
  let policy;
  try {
    policy = validateDockerImagePolicy({
      ...(config.expectedLockfileSha256 === undefined
        ? {}
        : { expectedLockfileSha256: config.expectedLockfileSha256 }),
      image: config.image,
      imagePath: config.imagePath,
      runtime: config.runtime,
      runtimeVersion: config.runtimeVersion,
      supportsCUtf8: config.supportsCUtf8,
      wrapperSha256: config.wrapperSha256,
    });
    validateDockerResourceLimits(config.limits);
    checks.push({
      detail: `${config.limits.cpus} CPUs, ${config.limits.memoryMiB} MiB, ${config.limits.pids} PIDs, ${config.limits.tmpMiB} MiB tmpfs`,
      name: "Resource policy",
      ok: true,
    });
  } catch (error) {
    return report([
      { detail: errorDetail(error), name: "Docker sandbox config", ok: false },
    ]);
  }

  try {
    const operatingSystem = await port.daemonOperatingSystem();
    if (operatingSystem !== "linux") {
      checks.push({
        detail: `server OS is ${operatingSystem}; Linux containers are required`,
        name: "Docker daemon",
        ok: false,
      });
      return report(checks);
    }
    checks.push({ detail: "reachable; Linux containers", name: "Docker daemon", ok: true });
  } catch (error) {
    checks.push({ detail: errorDetail(error), name: "Docker daemon", ok: false });
    return report(checks);
  }

  try {
    const inspection = await port.inspectLocal(policy.image);
    const image = validateLocalDockerImage(policy, inspection);
    checks.push(
      {
        detail: `${image.image.reference}; local exact digest`,
        name: "Docker image",
        ok: true,
      },
      {
        detail: `Linux ${image.architecture}; user ${image.nonRootUser}; compatible labels`,
        name: "Image policy",
        ok: true,
      },
      {
        detail: "fixed wrapper label matches trusted SHA-256; digest identity is not a trust attestation",
        name: "Execution wrapper",
        ok: true,
      },
      {
        detail: "network=none; local inspect only; no pull/build/registry operation",
        name: "Offline policy",
        ok: true,
      },
    );
  } catch (error) {
    checks.push({ detail: errorDetail(error), name: "Docker image policy", ok: false });
  }
  return report(checks);
}
