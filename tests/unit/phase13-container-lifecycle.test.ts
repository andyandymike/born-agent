import { describe, expect, it } from "vitest";

import {
  ContainerLifecycleError,
  projectContainerLifecycle,
  type ContainerLifecycleFact,
  type ContainerLifecycleIdentity,
} from "../../src/execution/docker/container-lifecycle.js";
import { planContainerReconciliation } from "../../src/execution/docker/container-reconciler.js";

const CONTAINER_ID = "c".repeat(64);

function identity(): ContainerLifecycleIdentity {
  const digest = "a".repeat(64);
  return {
    executionId: "20000000-0000-4000-8000-000000000001",
    hostname: "born-1234567890ab",
    image: {
      digest: `sha256:${digest}`,
      reference: `bornagent/node@sha256:${digest}`,
      repository: "bornagent/node",
    },
    name: "bornagent-1234567890abcdef12345678",
    nonce: "30000000-0000-4000-8000-000000000001",
    runId: "10000000-0000-4000-8000-000000000001",
    snapshotSha256: "b".repeat(64),
  };
}

function requested(): ContainerLifecycleFact {
  return { identity: identity(), type: "create_requested" };
}

function terminalPrefix(): readonly ContainerLifecycleFact[] {
  return [
    requested(),
    { containerId: CONTAINER_ID, type: "created" },
    { type: "start_requested" },
    { recovered: false, type: "started" },
    { exitCode: 0, recovered: false, type: "exited" },
    {
      exitCode: 0,
      finishedAt: "2026-07-17T00:00:01.000Z",
      oomKilled: false,
      startedAt: "2026-07-17T00:00:00.000Z",
      stateError: null,
      type: "inspected",
    },
  ];
}

describe("Phase 13 detached container lifecycle", () => {
  it("accepts fast exit only after durable create/start requests and terminal inspect", () => {
    const projection = projectContainerLifecycle([
      ...terminalPrefix(),
      {
        absentById: true,
        absentByName: true,
        recovered: false,
        resolution: "terminal_inspected",
        type: "cleaned",
      },
    ]);
    expect(projection).toMatchObject({
      cleanupState: "verified",
      containerId: CONTAINER_ID,
      effectState: "terminal",
      resumeDisposition: "complete",
      safeToPublishCommandTerminal: true,
    });
  });

  it("rejects reordered, inconsistent, and prematurely completed facts", () => {
    expect(() =>
      projectContainerLifecycle([
        requested(),
        { containerId: CONTAINER_ID, type: "created" },
        { recovered: false, type: "started" },
      ]),
    ).toThrow("prior durable start request");
    expect(() =>
      projectContainerLifecycle([
        requested(),
        { containerId: CONTAINER_ID, type: "created" },
        { type: "start_requested" },
        { recovered: false, type: "started" },
        { exitCode: 1, recovered: false, type: "exited" },
        {
          exitCode: 0,
          finishedAt: "2026-07-17T00:00:01.000Z",
          oomKilled: false,
          startedAt: "2026-07-17T00:00:00.000Z",
          stateError: null,
          type: "inspected",
        },
      ]),
    ).toThrow("match docker wait evidence");
    expect(() =>
      projectContainerLifecycle([
        requested(),
        { containerId: CONTAINER_ID, type: "created" },
        {
          absentById: true,
          absentByName: true,
          recovered: false,
          resolution: "terminal_inspected",
          type: "cleaned",
        },
      ]),
    ).toThrow(ContainerLifecycleError);
  });

  it("keeps start-requested prefixes unknown and non-completable", () => {
    expect(
      projectContainerLifecycle([
        requested(),
        { containerId: CONTAINER_ID, type: "created" },
        { type: "start_requested" },
      ]),
    ).toMatchObject({
      cleanupState: "pending",
      effectState: "start_unknown",
      resumeDisposition: "reconcile_only",
      safeToPublishCommandTerminal: false,
    });
  });
});

describe("Phase 13 container reconciliation planner", () => {
  const unknownStart: readonly ContainerLifecycleFact[] = [
    requested(),
    { containerId: CONTAINER_ID, type: "created" },
    { type: "start_requested" },
  ];

  it("never replays and blocks when daemon or exact identity proof is unavailable", () => {
    for (const observation of [
      { kind: "daemon_unavailable" as const },
      { kind: "identity_mismatch" as const },
      {
        absentById: true,
        absentByName: false,
        kind: "absent" as const,
      },
    ]) {
      const plan = planContainerReconciliation(unknownStart, observation);
      expect(plan.disposition).toBe("blocked");
      expect(plan.mayReplayCommand).toBe(false);
      expect(plan.actions).toEqual([]);
    }
  });

  it("stops a matching running unknown effect and preserves terminal evidence order", () => {
    const plan = planContainerReconciliation(unknownStart, {
      containerId: CONTAINER_ID,
      kind: "present_exact",
      state: "running",
    });
    expect(plan.mayReplayCommand).toBe(false);
    expect(plan.disposition).toBe("effect_unknown_cleanup");
    expect(plan.actions.map(({ type }) => type)).toEqual([
      "inspect_exact",
      "record_stopping",
      "stop_exact",
      "kill_if_still_running",
      "wait_terminal",
      "record_exited",
      "collect_bounded_logs",
      "record_terminal_inspect",
      "remove_force_exact",
      "prove_absent_by_id",
      "prove_absent_by_name",
      "record_recovered_cleaned",
    ]);
    expect(plan.actions.map(({ type }) => type)).not.toContain("start");
  });

  it("records cleanup without inventing terminal evidence when an unknown start is absent", () => {
    const plan = planContainerReconciliation(unknownStart, {
      absentById: true,
      absentByName: true,
      kind: "absent",
    });
    expect(plan).toMatchObject({
      disposition: "effect_unknown_cleanup",
      mayReplayCommand: false,
    });
    expect(plan.actions).toEqual([
      {
        resolution: "effect_unknown_absent",
        type: "record_recovered_cleaned",
      },
    ]);
  });

  it("removes an inspected terminal object and proves absence by id and name", () => {
    const plan = planContainerReconciliation(terminalPrefix(), {
      containerId: CONTAINER_ID,
      kind: "present_exact",
      state: "exited",
    });
    expect(plan.disposition).toBe("cleanup_only");
    expect(plan.actions).toEqual([
      { type: "remove_force_exact" },
      { type: "prove_absent_by_id" },
      { type: "prove_absent_by_name" },
      {
        resolution: "terminal_inspected",
        type: "record_recovered_cleaned",
      },
    ]);
  });
});
