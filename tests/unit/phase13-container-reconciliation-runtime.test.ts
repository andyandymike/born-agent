import { describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import type { DecodedRunEvent } from "../../src/events/event-decoder-registry.js";
import {
  reconcilePersistedContainers,
  type ContainerReconciliationRuntimePort,
} from "../../src/execution/docker/container-reconciliation-runtime.js";
import type { SanitizedContainerInspection } from "../../src/execution/docker/container-lifecycle.js";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "20000000-0000-4000-8000-000000000001";
const NONCE = "30000000-0000-4000-8000-000000000001";
const CONTAINER_ID = "c".repeat(64);
const IMAGE = `bornagent/node@sha256:${"a".repeat(64)}`;
const SNAPSHOT = "b".repeat(64);
const NAME = "bornagent-1234567890abcdef12345678";
const HOSTNAME = "born-1234567890ab";
const ACTION = "d".repeat(64);

function containerIdentitySha256(): string {
  return sha256Canonical({
    execution_id: EXECUTION_ID,
    hostname: HOSTNAME,
    image_digest: `sha256:${"a".repeat(64)}`,
    name: NAME,
    nonce: NONCE,
    run_id: RUN_ID,
    snapshot_sha256: SNAPSHOT,
  });
}

function event(type: string, data: unknown): DecodedRunEvent {
  return {
    data,
    eventId: "40000000-0000-4000-8000-000000000001",
    runId: RUN_ID,
    runSeq: 1,
    scope: "run",
    sessionId: "50000000-0000-4000-8000-000000000001",
    sessionSeq: 1,
    sourceSchemaVersion: 2,
    timestamp: "2026-07-17T00:00:00.000Z",
    type,
  } as DecodedRunEvent;
}

function unknownStartEvents(): readonly DecodedRunEvent[] {
  const common = {
    action_sha256: ACTION,
    container_identity_sha256: containerIdentitySha256(),
    execution_id: EXECUTION_ID,
  };
  return [
    event("run.started", {
      command: "agent",
      docker_sandbox: { image: IMAGE },
    }),
    event("sandbox.container.create.requested", {
      ...common,
      container_name: NAME,
      hostname: HOSTNAME,
      image_digest: `sha256:${"a".repeat(64)}`,
      nonce: NONCE,
      snapshot_sha256: SNAPSHOT,
    }),
    event("sandbox.container.created", {
      ...common,
      container_id: CONTAINER_ID,
      container_id_sha256: "e".repeat(64),
    }),
    event("sandbox.container.start.requested", common),
  ];
}

function inspection(running: boolean): SanitizedContainerInspection {
  return {
    containerId: CONTAINER_ID,
    exitCode: running ? null : 0,
    finishedAt: running ? null : "2026-07-17T00:00:01.000Z",
    imageId: `sha256:${"f".repeat(64)}`,
    imageReference: IMAGE,
    labels: {
      "org.bornagent.execution-id": EXECUTION_ID,
      "org.bornagent.nonce": NONCE,
      "org.bornagent.run-id": RUN_ID,
      "org.bornagent.snapshot-sha256": SNAPSHOT,
    },
    name: NAME,
    oomKilled: false,
    running,
    startedAt: "2026-07-17T00:00:00.000Z",
    stateError: null,
    status: running ? "running" : "exited",
  };
}

describe("Phase 13 production container reconciliation runtime", () => {
  it("stops and removes only the exact durable identity without replaying start", async () => {
    let current: SanitizedContainerInspection | null = inspection(true);
    const runtime: ContainerReconciliationRuntimePort = {
      async *collectBoundedLogs() {
        yield { bytes: 3, stream: "stdout", text: "ok\n" } as const;
      },
      create: vi.fn(async () => {
        throw new Error("recovery must never create");
      }),
      daemonOperatingSystem: async () => "linux",
      inspectById: async () => current,
      inspectByName: async () => current,
      kill: vi.fn(async () => {
        current = inspection(false);
      }),
      removeForce: async () => {
        current = null;
      },
      startDetached: vi.fn(async () => {
        throw new Error("recovery must never start");
      }),
      stop: async () => {
        current = inspection(false);
      },
      wait: async () => 0,
    };
    const appended: string[] = [];
    const result = await reconcilePersistedContainers(
      unknownStartEvents(),
      runtime,
      {
        append: async (_runId, type) => {
          appended.push(type);
        },
      },
    );

    expect(result).toMatchObject({ attempted: 1, blocked: [], cleaned: 1, mayReplayCommand: false });
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.startDetached).not.toHaveBeenCalled();
    expect(appended).toEqual([
      "sandbox.container.stopping",
      "sandbox.container.exited",
      "sandbox.container.inspected",
      "sandbox.container.cleaned",
    ]);
  });

  it("keeps resume blocked when the daemon cannot prove terminal state or absence", async () => {
    const runtime = {
      daemonOperatingSystem: async () => {
        throw new Error("daemon unavailable");
      },
    } as unknown as ContainerReconciliationRuntimePort;
    const append = vi.fn();
    const result = await reconcilePersistedContainers(unknownStartEvents(), runtime, {
      append,
    });
    expect(result).toMatchObject({ attempted: 1, cleaned: 0, mayReplayCommand: false });
    expect(result.blocked[0]).toContain("Docker daemon unavailable");
    expect(append).not.toHaveBeenCalled();
  });
});
