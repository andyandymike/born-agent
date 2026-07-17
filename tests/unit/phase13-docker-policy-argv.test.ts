import { describe, expect, it } from "vitest";

import {
  buildDetachedDockerLifecycleArgv,
  buildDockerCreateArgv,
} from "../../src/execution/docker/docker-cli-argv.js";
import {
  DockerPolicyError,
  parseDigestPinnedImageReference,
  validateDockerImagePolicy,
  validateDockerResourceLimits,
  validateLocalDockerImage,
  type LocalDockerImageInspection,
} from "../../src/execution/docker/docker-policy.js";
import {
  buildSandboxEnvironment,
  dockerEnvironmentArgv,
} from "../../src/execution/docker/sandbox-environment.js";

const DIGEST = "a".repeat(64);
const WRAPPER_DIGEST = "b".repeat(64);
const IMAGE = `localhost:5000/bornagent/node@sha256:${DIGEST}`;
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "20000000-0000-4000-8000-000000000001";
const NONCE = "30000000-0000-4000-8000-000000000001";
const CONTAINER_ID = "c".repeat(64);

function policy() {
  return validateDockerImagePolicy({
    image: IMAGE,
    imagePath: "/usr/local/bin:/usr/bin:/bin",
    runtime: "node",
    runtimeVersion: "22.19.0",
    supportsCUtf8: true,
    wrapperSha256: WRAPPER_DIGEST,
  });
}

function inspection(
  overrides: Partial<LocalDockerImageInspection> = {},
): LocalDockerImageInspection {
  return {
    architecture: "amd64",
    configuredUser: "10001:10001",
    id: `sha256:${"d".repeat(64)}`,
    labels: {
      "org.bornagent.exec-wrapper-sha256": WRAPPER_DIGEST,
      "org.bornagent.image-policy-version": "phase13-docker-v1",
      "org.bornagent.runtime": "node",
      "org.bornagent.runtime-version": "22.19.0",
    },
    operatingSystem: "linux",
    repoDigests: [IMAGE],
    ...overrides,
  };
}

describe("Phase 13 Docker image and policy core", () => {
  it("accepts only exact digest-pinned name references", () => {
    expect(parseDigestPinnedImageReference(IMAGE)).toEqual({
      digest: `sha256:${DIGEST}`,
      reference: IMAGE,
      repository: "localhost:5000/bornagent/node",
    });
    for (const denied of [
      "bornagent/node:latest",
      `bornagent/node:latest@sha256:${DIGEST}`,
      `https://registry.example/bornagent/node@sha256:${DIGEST}`,
      `BornAgent/node@sha256:${DIGEST}`,
      "bornagent/node@sha256:short",
    ]) {
      expect(() => parseDigestPinnedImageReference(denied), denied).toThrow(
        DockerPolicyError,
      );
    }
  });

  it("validates local Linux identity, non-root user, and exact compatibility labels", () => {
    expect(validateLocalDockerImage(policy(), inspection())).toMatchObject({
      image: { reference: IMAGE },
      nonRootUser: "10001:10001",
    });
    expect(() => validateLocalDockerImage(policy(), null)).toThrow(
      "not present locally",
    );
    expect(() =>
      validateLocalDockerImage(
        policy(),
        inspection({ operatingSystem: "windows" }),
      ),
    ).toThrow("Linux container image");
    expect(() =>
      validateLocalDockerImage(policy(), inspection({ configuredUser: "0:0" })),
    ).toThrow("non-root");
    expect(() =>
      validateLocalDockerImage(
        policy(),
        inspection({
          labels: {
            ...inspection().labels,
            "org.bornagent.exec-wrapper-sha256": "e".repeat(64),
          },
        }),
      ),
    ).toThrow("does not match trusted policy");
  });

  it("enforces resource hard limits", () => {
    expect(
      validateDockerResourceLimits({
        cpus: 0.25,
        memoryMiB: 256,
        pids: 32,
        tmpMiB: 16,
      }),
    ).toEqual({ cpus: 0.25, memoryMiB: 256, pids: 32, tmpMiB: 16 });
    expect(() =>
      validateDockerResourceLimits({
        cpus: 8.01,
        memoryMiB: 1024,
        pids: 256,
        tmpMiB: 128,
      }),
    ).toThrow("sandbox CPUs");
    expect(() =>
      validateDockerResourceLimits({
        cpus: 2,
        memoryMiB: 128,
        pids: 256,
        tmpMiB: 128,
      }),
    ).toThrow("memory limit");
  });

  it("rebuilds environment from an empty fixed allowlist", () => {
    const environment = buildSandboxEnvironment(policy(), {
      ANTHROPIC_API_KEY: "must-not-cross",
      BORN_MCP_TOKEN: "must-not-cross",
      HOME: "C:\\Users\\host",
      HTTP_PROXY: "http://host-proxy",
      PATH: "C:\\host-bin",
      SSH_AUTH_SOCK: "host-agent",
    });
    expect(environment).toEqual({
      names: ["PATH", "HOME", "TMPDIR", "CI", "NO_COLOR", "LANG", "BORN_SANDBOX"],
      values: {
        BORN_SANDBOX: "1",
        CI: "1",
        HOME: "/home/born",
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp",
      },
    });
    expect(dockerEnvironmentArgv(environment)).not.toContain(
      expect.stringContaining("must-not-cross"),
    );
  });
});

describe("Phase 13 deterministic Docker argv", () => {
  it("emits the mandatory detached create policy in stable order", () => {
    const image = validateLocalDockerImage(policy(), inspection());
    const sandboxRoot = "D:\\repo\\.bornagent\\sandboxes";
    const snapshotWorkspacePath = `${sandboxRoot}\\${RUN_ID}\\${EXECUTION_ID}\\workspace`;
    const plan = buildDockerCreateArgv({
      command: {
        args: ["test", "--privileged", "--mount"],
        containerCwd: "/workspace/src",
        logicalExecutable: "pnpm",
      },
      image,
      limits: { cpus: 2, memoryMiB: 1024, pids: 256, tmpMiB: 128 },
      nonce: NONCE,
      snapshot: {
        executionId: EXECUTION_ID,
        hostPlatform: "win32",
        runId: RUN_ID,
        sandboxRoot,
        snapshotSha256: "f".repeat(64),
        snapshotWorkspacePath,
      },
    });
    expect(plan.argv).toEqual([
      "create",
      "--name",
      plan.identity.name,
      "--hostname",
      plan.identity.hostname,
      "--label",
      `org.bornagent.run-id=${RUN_ID}`,
      "--label",
      `org.bornagent.execution-id=${EXECUTION_ID}`,
      "--label",
      `org.bornagent.nonce=${NONCE}`,
      "--label",
      `org.bornagent.snapshot-sha256=${"f".repeat(64)}`,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=128m",
      "--tmpfs",
      "/home/born:rw,nosuid,nodev,noexec,size=128m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1024m",
      "--cpus",
      "2",
      "--ulimit",
      "nofile=1024:1024",
      "--init",
      "--user",
      "10001:10001",
      "--entrypoint",
      "/usr/local/bin/born-sandbox-exec",
      "--workdir",
      "/workspace/src",
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env",
      "HOME=/home/born",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "CI=1",
      "--env",
      "NO_COLOR=1",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "BORN_SANDBOX=1",
      "--mount",
      `type=bind,src=${snapshotWorkspacePath},dst=/workspace,rw`,
      IMAGE,
      "pnpm",
      "test",
      "--privileged",
      "--mount",
    ]);
    const imageIndex = plan.argv.indexOf(IMAGE);
    expect(plan.argv.indexOf("--privileged")).toBeGreaterThan(imageIndex);
    expect(plan.argv.lastIndexOf("--mount")).toBeGreaterThan(imageIndex);
    expect(plan.argv.slice(0, imageIndex)).not.toContain("--rm");
    expect(plan.argv.slice(0, imageIndex)).not.toContain("--device");
    expect(plan.argv.slice(0, imageIndex)).not.toContain("--privileged");
  });

  it("rejects any host mount except the exact snapshot workspace leaf", () => {
    const image = validateLocalDockerImage(policy(), inspection());
    const sandboxRoot = "D:\\repo\\.bornagent\\sandboxes";
    expect(() =>
      buildDockerCreateArgv({
        command: {
          args: [],
          containerCwd: "/workspace",
          logicalExecutable: "node",
        },
        image,
        limits: { cpus: 2, memoryMiB: 1024, pids: 256, tmpMiB: 128 },
        nonce: NONCE,
        snapshot: {
          executionId: EXECUTION_ID,
          hostPlatform: "win32",
          runId: RUN_ID,
          sandboxRoot,
          snapshotSha256: "f".repeat(64),
          snapshotWorkspacePath: "D:\\repo",
        },
      }),
    ).toThrow("exact run/execution workspace leaf");
  });

  it("builds explicit start/wait/inspect/remove argv with no auto-remove", () => {
    const argv = buildDetachedDockerLifecycleArgv({
      containerId: CONTAINER_ID,
      containerName: "bornagent-1234567890abcdef12345678",
      stopGraceSeconds: 5,
    });
    expect(argv).toEqual({
      inspectById: ["inspect", CONTAINER_ID],
      inspectByName: ["inspect", "bornagent-1234567890abcdef12345678"],
      kill: ["kill", CONTAINER_ID],
      logsFollow: ["logs", "--follow", CONTAINER_ID],
      removeForce: ["rm", "-f", CONTAINER_ID],
      startDetached: ["start", CONTAINER_ID],
      stop: ["stop", "--time", "5", CONTAINER_ID],
      wait: ["wait", CONTAINER_ID],
    });
    expect(Object.values(argv).flat()).not.toContain("--rm");
  });
});
