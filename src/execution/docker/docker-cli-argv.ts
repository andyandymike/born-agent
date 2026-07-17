import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  DOCKER_SANDBOX_WRAPPER,
  DockerPolicyError,
  validateDockerResourceLimits,
  type DockerResourceLimits,
  type ValidatedLocalDockerImage,
} from "./docker-policy.js";
import {
  buildSandboxEnvironment,
  dockerEnvironmentArgv,
} from "./sandbox-environment.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;

export interface DockerSnapshotMount {
  readonly executionId: string;
  readonly hostPlatform: "linux" | "win32";
  readonly runId: string;
  readonly sandboxRoot: string;
  readonly snapshotSha256: string;
  readonly snapshotWorkspacePath: string;
}

export interface DockerCommandSpec {
  readonly args: readonly string[];
  readonly containerCwd: string;
  readonly logicalExecutable: string;
}

export interface DockerContainerIdentity {
  readonly executionId: string;
  readonly hostname: string;
  readonly name: string;
  readonly nonce: string;
  readonly runId: string;
}

export interface DockerCreateArgvPlan {
  readonly argv: readonly string[];
  readonly identity: DockerContainerIdentity;
  readonly mountIdentitySha256: string;
}

export interface DockerLifecycleArgv {
  readonly inspectById: readonly string[];
  readonly inspectByName: readonly string[];
  readonly kill: readonly string[];
  readonly logsFollow: readonly string[];
  readonly removeForce: readonly string[];
  readonly startDetached: readonly string[];
  readonly stop: readonly string[];
  readonly wait: readonly string[];
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new DockerPolicyError(
      `invalid_${field}`,
      `${field} must be a canonical UUID`,
    );
  }
}

function identityFor(
  runId: string,
  executionId: string,
  nonce: string,
): DockerContainerIdentity {
  requireUuid(runId, "run_id");
  requireUuid(executionId, "execution_id");
  requireUuid(nonce, "nonce");
  const digest = createHash("sha256")
    .update(`${runId}\0${executionId}\0${nonce}`, "utf8")
    .digest("hex");
  return Object.freeze({
    executionId,
    hostname: `born-${digest.slice(0, 12)}`,
    name: `bornagent-${digest.slice(0, 24)}`,
    nonce,
    runId,
  });
}

function normalizedSnapshotMount(input: DockerSnapshotMount): string {
  requireUuid(input.runId, "run_id");
  requireUuid(input.executionId, "execution_id");
  if (!SHA256.test(input.snapshotSha256)) {
    throw new DockerPolicyError(
      "invalid_snapshot_digest",
      "snapshot identity must be a lowercase SHA-256 digest",
    );
  }
  const pathApi = input.hostPlatform === "win32" ? win32 : posix;
  if (
    !pathApi.isAbsolute(input.sandboxRoot) ||
    !pathApi.isAbsolute(input.snapshotWorkspacePath)
  ) {
    throw new DockerPolicyError(
      "snapshot_mount_not_absolute",
      "sandbox storage and snapshot workspace paths must be absolute",
    );
  }
  const expected = pathApi.resolve(
    input.sandboxRoot,
    input.runId,
    input.executionId,
    "workspace",
  );
  const actual = pathApi.resolve(input.snapshotWorkspacePath);
  const rootSegments = pathApi
    .normalize(input.sandboxRoot)
    .split(pathApi.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (
    rootSegments.at(-1) !== "sandboxes" ||
    rootSegments.at(-2) !== ".bornagent"
  ) {
    throw new DockerPolicyError(
      "invalid_sandbox_storage_root",
      "sandbox storage root must be the workspace .bornagent/sandboxes directory",
    );
  }
  const same = input.hostPlatform === "win32"
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
  if (!same) {
    throw new DockerPolicyError(
      "snapshot_mount_not_leaf",
      "Docker bind source must be the exact run/execution workspace leaf",
    );
  }
  if (
    actual.includes(",") ||
    actual.includes("\0") ||
    actual.includes("\n") ||
    actual.includes("\r")
  ) {
    throw new DockerPolicyError(
      "snapshot_mount_not_encodable",
      "snapshot bind source cannot be encoded unambiguously as --mount argv",
    );
  }
  return actual;
}

function assertCommand(command: DockerCommandSpec): void {
  if (
    !/^[a-z][a-z0-9_-]{0,127}$/u.test(command.logicalExecutable) ||
    command.args.length > 64 ||
    command.args.some(
      (argument) =>
        argument.length > 4_096 ||
        argument.includes("\0") ||
        argument.includes("\n") ||
        argument.includes("\r"),
    )
  ) {
    throw new DockerPolicyError(
      "invalid_container_command",
      "container command must use a registered logical executable and bounded exact argv",
    );
  }
  if (
    command.containerCwd !== "/workspace" &&
    !/^\/workspace\/(?!.*(?:^|\/)\.\.?\/)[^\0\r\n]+$/u.test(
      command.containerCwd,
    )
  ) {
    throw new DockerPolicyError(
      "invalid_container_cwd",
      "container cwd must be /workspace or a mapped directory below it",
    );
  }
}

function formatCpus(value: number): string {
  return String(value);
}

export function buildDockerCreateArgv(input: {
  readonly command: DockerCommandSpec;
  readonly image: ValidatedLocalDockerImage;
  readonly limits: DockerResourceLimits;
  readonly nonce: string;
  readonly snapshot: DockerSnapshotMount;
}): DockerCreateArgvPlan {
  assertCommand(input.command);
  const limits = validateDockerResourceLimits(input.limits);
  const mountSource = normalizedSnapshotMount(input.snapshot);
  const identity = identityFor(
    input.snapshot.runId,
    input.snapshot.executionId,
    input.nonce,
  );
  const environment = buildSandboxEnvironment(input.image.policy);
  const mount = `type=bind,src=${mountSource},dst=/workspace,rw`;
  const tmpSize = `${limits.tmpMiB}m`;
  // PHASE13: These fixed flags separately deny network, capabilities, writable
  // rootfs and unbounded resources. Model argv is appended only after the exact
  // image reference, so it cannot become a Docker flag or second mount.
  const argv = Object.freeze([
    "create",
    "--name",
    identity.name,
    "--hostname",
    identity.hostname,
    "--label",
    `org.bornagent.run-id=${identity.runId}`,
    "--label",
    `org.bornagent.execution-id=${identity.executionId}`,
    "--label",
    `org.bornagent.nonce=${identity.nonce}`,
    "--label",
    `org.bornagent.snapshot-sha256=${input.snapshot.snapshotSha256}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${tmpSize}`,
    "--tmpfs",
    `/home/born:rw,nosuid,nodev,noexec,size=${tmpSize}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(limits.pids),
    "--memory",
    `${limits.memoryMiB}m`,
    "--cpus",
    formatCpus(limits.cpus),
    "--ulimit",
    "nofile=1024:1024",
    "--init",
    "--user",
    input.image.nonRootUser,
    "--entrypoint",
    DOCKER_SANDBOX_WRAPPER,
    "--workdir",
    input.command.containerCwd,
    ...dockerEnvironmentArgv(environment),
    "--mount",
    mount,
    input.image.image.reference,
    input.command.logicalExecutable,
    ...input.command.args,
  ]);
  if (
    argv.includes("--rm") ||
    ["run", "pull", "build"].includes(argv[0] ?? "")
  ) {
    throw new DockerPolicyError(
      "forbidden_docker_lifecycle",
      "Docker create plan cannot auto-remove, pull, build, or use docker run",
    );
  }
  return Object.freeze({
    argv,
    identity,
    mountIdentitySha256: createHash("sha256")
      .update(`${input.snapshot.snapshotSha256}\0/workspace\0rw`, "utf8")
      .digest("hex"),
  });
}

export function buildDetachedDockerLifecycleArgv(input: {
  readonly containerId: string;
  readonly containerName: string;
  readonly stopGraceSeconds: number;
}): DockerLifecycleArgv {
  if (
    !CONTAINER_ID.test(input.containerId) ||
    !/^bornagent-[0-9a-f]{24}$/u.test(input.containerName) ||
    !Number.isSafeInteger(input.stopGraceSeconds) ||
    input.stopGraceSeconds < 0 ||
    input.stopGraceSeconds > 60
  ) {
    throw new DockerPolicyError(
      "invalid_container_lifecycle_identity",
      "detached lifecycle requires exact container id, reserved name, and bounded grace",
    );
  }
  // PHASE13: Killing a host docker CLI does not stop its container. Detached
  // create/start, wait/inspect and explicit rm keep the daemon object available
  // until terminal evidence and exact ID/name absence are both proven.
  return Object.freeze({
    inspectById: Object.freeze(["inspect", input.containerId]),
    inspectByName: Object.freeze(["inspect", input.containerName]),
    kill: Object.freeze(["kill", input.containerId]),
    logsFollow: Object.freeze(["logs", "--follow", input.containerId]),
    removeForce: Object.freeze(["rm", "-f", input.containerId]),
    startDetached: Object.freeze(["start", input.containerId]),
    stop: Object.freeze([
      "stop",
      "--time",
      String(input.stopGraceSeconds),
      input.containerId,
    ]),
    wait: Object.freeze(["wait", input.containerId]),
  });
}
