import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { runDockerSandboxDoctor } from "../../src/execution/docker/docker-doctor.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const image = `bornagent-node@${digest}`;
const wrapperSha256 = "b".repeat(64);
const config = Object.freeze({
  image,
  imagePath: "/usr/local/bin:/usr/bin:/bin",
  limits: Object.freeze({ cpus: 2, memoryMiB: 1_024, pids: 256, tmpMiB: 128 }),
  runtime: "node",
  runtimeVersion: "phase13",
  supportsCUtf8: true,
  wrapperSha256,
});

function compatibleInspection() {
  return Object.freeze({
    architecture: "amd64",
    configuredUser: "10001:10001",
    id: `sha256:${"c".repeat(64)}`,
    labels: Object.freeze({
      "org.bornagent.exec-wrapper-sha256": wrapperSha256,
      "org.bornagent.image-policy-version": "phase13-docker-v1",
      "org.bornagent.runtime": "node",
      "org.bornagent.runtime-version": "phase13",
    }),
    operatingSystem: "linux",
    repoDigests: Object.freeze([image]),
  });
}

describe("Phase 13 Docker sandbox doctor", () => {
  it("validates a local Linux digest image without pull or container start", async () => {
    const daemonOperatingSystem = vi.fn(async () => "linux");
    const inspectLocal = vi.fn(async () => compatibleInspection());

    const report = await runDockerSandboxDoctor(config, {
      daemonOperatingSystem,
      inspectLocal,
    });

    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(daemonOperatingSystem).toHaveBeenCalledOnce();
    expect(inspectLocal).toHaveBeenCalledWith({
      digest,
      reference: image,
      repository: "bornagent-node",
    });
    expect(report.checks.some((check) => check.detail.includes("no pull/build"))).toBe(true);
  });

  it("fails closed for a missing local image and a non-Linux daemon", async () => {
    const missing = await runDockerSandboxDoctor(config, {
      daemonOperatingSystem: async () => "linux",
      inspectLocal: async () => null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.checks.at(-1)?.detail).toContain("not present locally");

    const inspectLocal = vi.fn(async () => compatibleInspection());
    const windows = await runDockerSandboxDoctor(config, {
      daemonOperatingSystem: async () => "windows",
      inspectLocal,
    });
    expect(windows.ok).toBe(false);
    expect(inspectLocal).not.toHaveBeenCalled();
  });

  it("wires born sandbox doctor through trusted config only", async () => {
    const runDoctor = vi.fn(async () => ({
      checks: [{ detail: "local only", name: "Offline policy", ok: true }],
      failed: 0,
      ok: true,
      passed: 1,
    }));
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["sandbox", "doctor"],
      memory.io,
      createRuntime({
        env: {
          BORN_DOCKER_IMAGE: image,
          BORN_DOCKER_WRAPPER_SHA256: wrapperSha256,
        },
        runDockerSandboxDoctor: runDoctor,
      }),
    );

    expect(exitCode).toBe(0);
    expect(runDoctor).toHaveBeenCalledWith(config);
    expect(memory.readStdout()).toContain("Docker sandbox doctor: 1 passed, 0 failed");
    expect(memory.readStderr()).toBe("");
  });

  it("rejects tag-only image config before touching Docker", async () => {
    const runDoctor = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["sandbox", "doctor", "--docker-image", "bornagent-node:latest"],
      memory.io,
      createRuntime({
        env: { BORN_DOCKER_WRAPPER_SHA256: wrapperSha256 },
        runDockerSandboxDoctor: runDoctor,
      }),
    );

    expect(exitCode).toBe(2);
    expect(runDoctor).not.toHaveBeenCalled();
    expect(memory.readStderr()).toContain("@sha256");
  });
});
