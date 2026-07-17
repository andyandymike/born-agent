import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PreparedExecution } from "../../src/execution/execution-types.js";
import type { SanitizedContainerInspection } from "../../src/execution/docker/container-lifecycle.js";
import { DockerExecutionPreparer } from "../../src/execution/docker/docker-execution-preparer.js";
import { DockerExecutor } from "../../src/execution/docker/docker-executor.js";
import { createCommandActionIdentity } from "../../src/permissions/action-digest.js";

const workspaces: string[] = [];
const runId = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";
const image = `bornagent-node@sha256:${"a".repeat(64)}`;
const wrapperSha256 = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })));
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function localPrepared(workspace: string): PreparedExecution {
  const action = createCommandActionIdentity({
    actionKind: "command",
    argv: [],
    binary: {
      bytesSha256: "d".repeat(64),
      canonicalIdentity: "phase13-test-node",
      version: "v24-test",
    },
    canonicalCwd: ".",
    environmentPolicy: {
      id: "phase13-test-local-env",
      variableNames: [],
      version: "1",
    },
    executionInputs: {
      lockfileSha256: null,
      manifestSha256: null,
      runnerConfigHashes: [],
    },
    lifecycleScripts: null,
    logicalExecutable: "node",
    outputLimitBytes: 16_384,
    packageManager: null,
    purpose: "verify",
    timeoutMs: 2_000,
  });
  return Object.freeze({
    actionIdentity: action,
    actionSha256: action.actionSha256,
    executionInputsSha256: action.executionInputsSha256,
    request: Object.freeze({
      args: Object.freeze([]),
      cwd: workspace,
      environment: Object.freeze({}),
      executableFile: "node",
      logicalExecutable: "node",
      outputLimitBytes: 16_384,
      purpose: "verify",
      timeoutMs: 2_000,
    }),
    revalidate: async () => "current" as const,
    review: Object.freeze({ lifecycleScripts: [], warning: "local test" }),
  });
}

describe("Phase 13 Docker executor lifecycle", () => {
  it("runs against a disposable copy, preserves fast logs, and proves exact cleanup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase13-"));
    workspaces.push(workspace);
    const sourceBytes = Buffer.from("host sentinel\n", "utf8");
    await writeFile(join(workspace, "sentinel.txt"), sourceBytes);
    const sourceStateSha256 = "e".repeat(64);
    const source = {
      workspaceRealPath: workspace,
      enumerateSourceEntries: async () => [
        {
          bytes: sourceBytes.byteLength,
          contentSha256: sha256(sourceBytes),
          ignored: false,
          kind: "file" as const,
          mode: "regular" as const,
          relativePath: "sentinel.txt",
          tracked: true,
        },
      ],
      readFile: async () => sourceBytes,
      readSourceStateSha256: async () => sourceStateSha256,
      withMutationLock: async <T>(operation: () => Promise<T>) => operation(),
    };
    const local = localPrepared(workspace);
    const preparer = new DockerExecutionPreparer({
      hostPlatform: process.platform === "win32" ? "win32" : "linux",
      imageInspector: {
        inspectLocal: async () => ({
          architecture: "amd64",
          configuredUser: "10001:10001",
          id: imageId,
          labels: {
            "org.bornagent.exec-wrapper-sha256": wrapperSha256,
            "org.bornagent.image-policy-version": "phase13-docker-v1",
            "org.bornagent.runtime": "node",
            "org.bornagent.runtime-version": "phase13",
          },
          operatingSystem: "linux",
          repoDigests: [image],
        }),
      },
      imagePolicy: {
        image,
        imagePath: "/usr/local/bin:/usr/bin:/bin",
        runtime: "node",
        runtimeVersion: "phase13",
        supportsCUtf8: true,
        wrapperSha256,
      },
      limits: { cpus: 2, memoryMiB: 1_024, pids: 256, tmpMiB: 128 },
      localPreparer: { prepare: async () => local },
      runId,
      source,
    });
    const prepared = (await preparer.prepare({
      args: [],
      cwd: null,
      executable: "node",
      outputLimitBytes: 16_384,
      purpose: "verify",
      timeoutMs: 2_000,
    })).bindExecutionContext!({ executionId });

    const trace: string[] = [];
    const eventData = new Map<string, unknown>();
    const containerId = "f".repeat(64);
    let inspection: SanitizedContainerInspection | null = null;
    let snapshotWorkspace = "";
    const runtime = {
      async *collectBoundedLogs() {
        yield { bytes: 3, stream: "stdout" as const, text: "ok\n" };
      },
      create: async (argv: readonly string[]) => {
        const nameIndex = argv.indexOf("--name");
        const mountIndex = argv.indexOf("--mount");
        const name = argv[nameIndex + 1]!;
        const mount = argv[mountIndex + 1]!;
        snapshotWorkspace = mount.slice("type=bind,src=".length).split(",dst=/workspace", 1)[0]!;
        const labels: Record<string, string> = {};
        for (let index = 0; index < argv.length; index += 1) {
          if (argv[index] !== "--label") continue;
          const [key, value] = argv[index + 1]!.split("=", 2);
          labels[key!] = value!;
        }
        inspection = {
          containerId,
          exitCode: null,
          finishedAt: null,
          imageId,
          imageReference: image,
          labels,
          name,
          oomKilled: false,
          running: false,
          startedAt: null,
          stateError: null,
          status: "created",
        };
        return containerId;
      },
      inspectById: async () => inspection,
      inspectByName: async () => inspection,
      kill: async () => undefined,
      removeForce: async () => {
        inspection = null;
      },
      startDetached: async () => {
        await writeFile(join(snapshotWorkspace, "generated.txt"), "ephemeral\n", "utf8");
        inspection = {
          ...inspection!,
          running: true,
          startedAt: "2026-07-17T00:00:00.000Z",
          status: "running",
        };
      },
      stop: async () => undefined,
      wait: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        inspection = {
          ...inspection!,
          exitCode: 0,
          finishedAt: "2026-07-17T00:00:00.010Z",
          running: false,
          status: "exited",
        };
        return 0;
      },
    };
    const executor = new DockerExecutor({
      clock: { now: () => 25 },
      events: {
        append: async (type, data) => {
          trace.push(type);
          eventData.set(type, data);
        },
      },
      randomUUID: () => nonce,
      redact: (value) => value,
      runtime,
    });

    const signals = [];
    for await (const signal of executor.execute(prepared, new AbortController().signal)) {
      signals.push(signal);
      trace.push(`command.${signal.type}`);
    }

    expect(signals.map((signal) => signal.type)).toEqual(["started", "output", "completed"]);
    expect(signals.at(-1)).toMatchObject({
      result: {
        cleanupVerified: true,
        exitCode: 0,
        ok: true,
        sandboxEphemeralChanges: { created: 1, paths: ["generated.txt"] },
        stdout: "ok\n",
      },
      type: "completed",
    });
    expect(trace).toEqual([
      "sandbox.snapshot.created",
      "sandbox.container.create.requested",
      "sandbox.container.created",
      "sandbox.container.start.requested",
      "sandbox.container.started",
      "command.started",
      "command.output",
      "sandbox.container.exited",
      "sandbox.container.inspected",
      "sandbox.container.cleaned",
      "sandbox.snapshot.changed",
      "sandbox.snapshot.cleaned",
      "command.completed",
    ]);
    expect(eventData.get("sandbox.snapshot.changed")).toMatchObject({
      created: 1,
      deleted: 0,
      modified: 0,
      paths: ["generated.txt"],
    });
    await expect(access(join(workspace, "generated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(workspace, ".bornagent", "sandboxes", runId, executionId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
