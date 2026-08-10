import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { IDS, SHA } from "../phase20-test-helpers.js";

const roots: string[] = [];
let uuid = 800;
const nextUuid = () => `a0000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Phase 20D durable delegation group lease", () => {
  it("admits one repository group and gives exactly one of two takeover processes the CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-group-lease-"));
    roots.push(root);
    const store = await DelegationGroupLeaseStore.create({ repositoryId: SHA, root });
    const acquired = await store.acquire({
      acquiredAt: "2026-08-10T00:00:00.000Z",
      graphBindingSha256: null,
      groupId: nextUuid(),
      nonceSha256: "b".repeat(64),
      ownerBackgroundOperationId: null,
      ownerKind: "foreground",
      ownerPid: 2_000_000_000,
      ownerProcessStartIdentity: "dead-owner-start",
      parentActorId: IDS.parent,
      parentRunId: IDS.parent,
      sessionId: IDS.session,
    });

    const competing = await DelegationGroupLeaseStore.openExisting({ repositoryId: SHA, root });
    await expect(competing.acquire({
      acquiredAt: "2026-08-10T00:00:00.001Z",
      graphBindingSha256: null,
      groupId: nextUuid(),
      nonceSha256: "c".repeat(64),
      ownerBackgroundOperationId: null,
      ownerKind: "foreground",
      ownerPid: 2_000_000_001,
      ownerProcessStartIdentity: "other-owner-start",
      parentActorId: IDS.parent,
      parentRunId: IDS.parent,
      sessionId: IDS.session,
    })).rejects.toMatchObject({ code: "delegation_lease_busy" });

    const takeover = (pid: number, nonce: string) => competing.takeover({
      effectsReconciled: true,
      expectedLeaseSha256: acquired.leaseSha256,
      newNonceSha256: nonce.repeat(64),
      newOwnerBackgroundOperationId: null,
      newOwnerKind: "foreground",
      newOwnerPid: pid,
      newOwnerProcessStartIdentity: `takeover-${String(pid)}`,
      now: "2026-08-10T00:00:01.000Z",
      ownerProbe: { probe: async () => "missing" },
    });
    const outcomes = await Promise.allSettled([
      takeover(2_000_000_002, "d"),
      takeover(2_000_000_003, "e"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await store.read())?.revision).toBe(2);
  });

  it("keeps unknown effects held and binds background ownership to one exact worker operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-group-release-"));
    roots.push(root);
    const store = await DelegationGroupLeaseStore.create({ repositoryId: SHA, root });
    const operationId = nextUuid();
    const acquired = await store.acquire({
      acquiredAt: "2026-08-10T00:00:00.000Z",
      graphBindingSha256: "f".repeat(64),
      groupId: nextUuid(),
      nonceSha256: "1".repeat(64),
      ownerBackgroundOperationId: operationId,
      ownerKind: "phase19_background_worker",
      ownerPid: 2_000_000_004,
      ownerProcessStartIdentity: "worker-owner-start",
      parentActorId: IDS.parent,
      parentRunId: IDS.parent,
      sessionId: IDS.session,
    });
    await expect(store.release({
      effectsReconciled: false,
      expectedLeaseSha256: acquired.leaseSha256,
      now: "2026-08-10T00:00:01.000Z",
      reason: "terminal",
    })).rejects.toMatchObject({ code: "delegation_effect_reconciliation_required" });
    const released = await store.release({
      effectsReconciled: true,
      expectedLeaseSha256: acquired.leaseSha256,
      now: "2026-08-10T00:00:02.000Z",
      reason: "terminal",
    });
    expect(released).toMatchObject({
      ownerBackgroundOperationId: operationId,
      ownerKind: "phase19_background_worker",
      releaseReason: "terminal",
      state: "released",
    });
  });
});
