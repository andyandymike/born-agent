import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";

const temporary: string[] = [];

async function journal(): Promise<{
  readonly journal: ControlOperationJournal;
  readonly paths: Awaited<ReturnType<typeof loadOrCreateHostControlAuthority>>["paths"];
}> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase21a-operation-"));
  temporary.push(root);
  const authority = await loadOrCreateHostControlAuthority({ root });
  const journal = new ControlOperationJournal(authority.paths);
  await journal.initialize();
  return { journal, paths: authority.paths };
}

function input(overrides: Partial<Parameters<ControlOperationJournal["accept"]>[0]> = {}) {
  const preparedActionId = overrides.preparedActionId ?? randomUUID();
  return {
    actionKind: "session.create",
    idempotencyKey: "commit-key",
    idempotencyNamespace: "application.commit.local_owner",
    preparedActionId,
    preparedActionSha256: sha256Canonical({ preparedActionId }),
    requestIdentitySha256: sha256Canonical({ preparedActionId, semantic: "session.create" }),
    target: {
      catalogScope: {
        kind: "session_catalog" as const,
        repositoryId: randomUUID(),
        teamId: null,
      },
      expectedCatalogVersion: { kind: "revision" as const, revision: 0, sha256: "a".repeat(64) },
      kind: "new_session" as const,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Phase 21A durable control operation journal", () => {
  it("gives K1/K2 commits of one prepared action one durable winner", async () => {
    const { journal: store } = await journal();
    const shared = input();
    const results = await Promise.all([
      store.accept(shared),
      store.accept({ ...shared, idempotencyKey: "K2" }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.operation.operationId)).size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects one idempotency key bound to a different semantic request", async () => {
    const { journal: store } = await journal();
    const first = input();
    await store.accept(first);
    await expect(store.accept(input({
      idempotencyKey: first.idempotencyKey,
      idempotencyNamespace: first.idempotencyNamespace,
      preparedActionId: randomUUID(),
      preparedActionSha256: "b".repeat(64),
      requestIdentitySha256: "c".repeat(64),
    }))).rejects.toMatchObject({ code: "control_idempotency_conflict" });
    expect(await store.list()).toHaveLength(1);
  });

  it("links every revision and rebuilds a missing prepared index from authority", async () => {
    const { journal: store, paths } = await journal();
    const request = input();
    const accepted = await store.accept(request);
    const validated = await store.update({
      expectedRecordSha256: accepted.operation.recordSha256,
      operationId: accepted.operation.operationId,
      patch: { state: "authority_validated" },
    });
    const started = await store.update({
      expectedRecordSha256: validated.recordSha256,
      operationId: validated.operationId,
      patch: { state: "domain_append_started" },
    });
    expect(started).toMatchObject({ operationRevision: 3, previousOperationRecordSha256: validated.recordSha256 });
    await unlink(join(
      paths.operationRoot,
      "indexes",
      "prepared",
      `${sha256Canonical(request.preparedActionId)}.json`,
    ));
    expect((await store.findByPreparedAction(request.preparedActionId))?.operationId).toBe(started.operationId);
  });

  it("accepts an immutable stale index only when its record is in the exact operation history", async () => {
    const { journal: store } = await journal();
    const request = input();
    const accepted = await store.accept(request);
    const updated = await store.update({
      expectedRecordSha256: accepted.operation.recordSha256,
      operationId: accepted.operation.operationId,
      patch: { state: "authority_validated" },
    });

    const found = await store.findByPreparedAction(request.preparedActionId);
    expect(found).toMatchObject({
      operationId: accepted.operation.operationId,
      operationRevision: updated.operationRevision,
      recordSha256: updated.recordSha256,
    });
  });

  it("rejects a self-consistent index whose record hash belongs to another operation history", async () => {
    const { journal: store, paths } = await journal();
    const request = input();
    await store.accept(request);
    const other = await store.accept(input({ idempotencyKey: "other-operation-key" }));
    const indexPath = join(
      paths.operationRoot,
      "indexes",
      "prepared",
      `${sha256Canonical(request.preparedActionId)}.json`,
    );
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Readonly<Record<string, unknown>>;
    const content = {
      indexValueSha256: parsed.indexValueSha256,
      kind: parsed.kind,
      operationId: parsed.operationId,
      recordSha256: other.operation.recordSha256,
      schemaVersion: parsed.schemaVersion,
    };
    await writeFile(indexPath, `${JSON.stringify({ ...content, indexSha256: sha256Canonical(content) })}\n`, "utf8");

    await expect(store.findByPreparedAction(request.preparedActionId)).rejects.toMatchObject({
      code: "control_operation_corrupt",
    });
  });

  it("persists one driver winner across journal instances", async () => {
    const { journal: first, paths } = await journal();
    const accepted = await first.accept(input());
    const second = new ControlOperationJournal(paths);
    const results = await Promise.all([
      first.acquireDriver(accepted.operation.operationId),
      second.acquireDriver(accepted.operation.operationId),
    ]);
    expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
    const persisted = await first.read(accepted.operation.operationId);
    expect(persisted?.ownerClaim).toMatchObject({ claimEpoch: 1 });
  });

  it("fences an expired pre-dispatch owner with a higher durable epoch", async () => {
    const { paths } = await journal();
    let now = new Date("2026-08-12T00:00:00.000Z");
    const first = new ControlOperationJournal(paths, {
      driverLeaseMs: 100,
      now: () => now,
      processIdentity: { pid: 101, startIdentity: "first-driver" },
    });
    const accepted = await first.accept(input());
    const firstDriver = await first.acquireDriver(accepted.operation.operationId);
    expect(firstDriver.kind).toBe("acquired");
    if (firstDriver.kind !== "acquired") throw new TypeError("expected first driver claim");

    now = new Date("2026-08-12T00:00:00.101Z");
    const second = new ControlOperationJournal(paths, {
      driverLeaseMs: 100,
      now: () => now,
      processIdentity: { pid: 202, startIdentity: "second-driver" },
    });
    const takeover = await second.acquireDriver(accepted.operation.operationId);
    expect(takeover).toMatchObject({ kind: "acquired", takeover: true });
    if (takeover.kind !== "acquired") throw new TypeError("expected takeover driver claim");
    expect(takeover.claim.claimEpoch).toBe(2);
    await expect(first.updateClaimed({
      claim: firstDriver.claim,
      patch: { state: "authority_validated" },
    })).rejects.toMatchObject({ code: "control_operation_busy" });
  });

  it("reconciles an expired post-dispatch owner to unknown without takeover", async () => {
    const { paths } = await journal();
    let now = new Date("2026-08-12T00:00:00.000Z");
    const first = new ControlOperationJournal(paths, {
      driverLeaseMs: 100,
      now: () => now,
      processIdentity: { pid: 303, startIdentity: "dispatch-driver" },
    });
    const accepted = await first.accept(input());
    const acquired = await first.acquireDriver(accepted.operation.operationId);
    if (acquired.kind !== "acquired") throw new TypeError("expected driver claim");
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "authority_validated" } });
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "domain_append_started" } });

    now = new Date("2026-08-12T00:00:00.101Z");
    const second = new ControlOperationJournal(paths, {
      driverLeaseMs: 100,
      now: () => now,
      processIdentity: { pid: 404, startIdentity: "recovery-driver" },
    });
    const reconciled = await second.acquireDriver(accepted.operation.operationId);
    expect(reconciled).toMatchObject({
      kind: "blocked_unknown_effect",
      operation: { ownerClaim: null, state: "blocked_unknown_effect" },
    });
  });

  it("releases a post-dispatch owner only into an action-specific reconcile-only takeover", async () => {
    const { journal: first, paths } = await journal();
    const accepted = await first.accept(input());
    const acquired = await first.acquireDriver(accepted.operation.operationId);
    if (acquired.kind !== "acquired") throw new TypeError("expected driver claim");
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "authority_validated" } });
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "domain_append_started" } });
    const released = await first.releaseDriver(acquired.claim, { allowPostDispatchReconcile: true });
    expect(released).toMatchObject({ ownerClaim: null, state: "domain_append_started" });

    const replacement = new ControlOperationJournal(paths, {
      processIdentity: { pid: 454, startIdentity: "exact-reconcile-driver" },
    });
    const takeover = await replacement.acquireDriver(accepted.operation.operationId, {
      allowPostDispatchReconcile: true,
    });
    expect(takeover).toMatchObject({
      kind: "acquired",
      operation: { state: "domain_append_started" },
      reconcileOnly: true,
      takeover: true,
    });
  });

  it("blocks a released post-dispatch owner when no action reconciler exists", async () => {
    const { journal: store } = await journal();
    const accepted = await store.accept(input());
    const acquired = await store.acquireDriver(accepted.operation.operationId);
    if (acquired.kind !== "acquired") throw new TypeError("expected driver claim");
    await store.updateClaimed({ claim: acquired.claim, patch: { state: "authority_validated" } });
    await store.updateClaimed({ claim: acquired.claim, patch: { state: "domain_append_started" } });

    const released = await store.releaseDriver(acquired.claim);
    expect(released).toMatchObject({
      errorCode: "control_driver_stopped_after_dispatch",
      ownerClaim: null,
      state: "blocked_unknown_effect",
    });
  });

  it("takes over a complete linked result without reopening domain dispatch", async () => {
    const { journal: first, paths } = await journal();
    const accepted = await first.accept(input());
    const acquired = await first.acquireDriver(accepted.operation.operationId);
    if (acquired.kind !== "acquired") throw new TypeError("expected driver claim");
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "authority_validated" } });
    await first.updateClaimed({ claim: acquired.claim, patch: { state: "domain_append_started" } });
    const target = accepted.operation.target;
    if (target.kind !== "new_session") throw new TypeError("expected session catalog target");
    const primary = Object.freeze({
      ledgerId: `session_catalog:${target.catalogScope.repositoryId}`,
      ownerKind: "catalog" as const,
      recordId: randomUUID(),
      recordSha256: "d".repeat(64),
      sequence: 1,
    });
    await first.updateClaimed({
      claim: acquired.claim,
      patch: {
        domainRecordRefs: [primary],
        primaryDomainRecord: primary,
        resolvedResourceScope: target.catalogScope,
        resolvedResourceVersion: target.expectedCatalogVersion,
        state: "domain_records_linked",
      },
    });
    const resultArtifact = {
          artifactId: randomUUID(),
          artifactSha256: "e".repeat(64),
          bytes: 64,
          createdByOperationId: accepted.operation.operationId,
          mediaType: "application/json",
          metadataDisclosure: "content_authorized",
          owner: "host_artifact_store",
          resourceScope: target.catalogScope,
          schemaVersion: 1,
          scopedIntegrityToken: null,
          transportVisibility: "resource_authorized",
        } as const;
    await first.updateClaimed({
      claim: acquired.claim,
      patch: { resultArtifact, state: "result_built" },
    });
    const released = await first.releaseDriver(acquired.claim);
    expect(released).toMatchObject({ ownerClaim: null, state: "result_built" });

    const replacement = new ControlOperationJournal(paths, {
      processIdentity: { pid: 505, startIdentity: "linked-result-finisher" },
    });
    const takeover = await replacement.acquireDriver(accepted.operation.operationId);
    expect(takeover).toMatchObject({ kind: "acquired", operation: { state: "result_built" }, takeover: true });
    if (takeover.kind !== "acquired") throw new TypeError("expected linked result takeover");
    const completed = await replacement.updateClaimed({ claim: takeover.claim, patch: { state: "completed" } });
    expect(completed.resultArtifact).toEqual(resultArtifact);
    expect(completed.state).toBe("completed");
  });
});
