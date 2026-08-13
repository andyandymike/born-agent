import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { SessionProjectionService } from "../../src/control-plane/session-projection-service.js";
import { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("AS3.3 SessionRegistry run read path", () => {
  it("AS3.3 SessionRegistry keeps idle run observations on one verified catalog prefix", async () => {
    const authority = await loadOrCreateHostControlAuthority({
      root: await directory("bornagent-as33-state-"),
    });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root: await directory("bornagent-as33-repository-"),
    });
    let fullScanCount = 0;
    const incrementalReads: Array<Readonly<{ anchorRecordCount: number; appendedRecordCount: number }>> = [];
    const sessions = new SessionRegistry(authority.paths, repositories, {
      onRunCatalogFullScan: () => { fullScanCount += 1; },
      onRunCatalogIncrementalRead: (input) => { incrementalReads.push(input); },
    });
    const created = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    const runId = randomUUID();
    await sessions.registerRunOwner({
      initialObservedHead: created.entry.initialLedgerHead,
      ownerGenerationSha256: "a".repeat(64),
      ownerOperationId: runId,
      repositoryId: repository.registration.repositoryId,
      runId,
      sessionId: created.entry.sessionId,
    });

    const scansAfterWarmup = fullScanCount;
    const incrementsAfterWarmup = incrementalReads.length;
    for (let index = 0; index < 10; index += 1) {
      const barrier = await sessions.readRunCancelBarrier(
        repository.registration.repositoryId,
        created.entry.sessionId,
        runId,
      );
      expect(barrier.owner?.fact.ownerOperationId).toBe(runId);
    }

    expect(fullScanCount).toBe(scansAfterWarmup);
    expect(incrementalReads.slice(incrementsAfterWarmup)).toHaveLength(10);
    expect(incrementalReads.slice(incrementsAfterWarmup).every((read) =>
      read.anchorRecordCount === 1 && read.appendedRecordCount === 0
    )).toBe(true);
    expect(incrementalReads.some((read) => read.appendedRecordCount === 1)).toBe(true);
  });

  it("AS3.3 SessionRegistry allows one bounded full recovery after an incremental cursor is lost", async () => {
    const authority = await loadOrCreateHostControlAuthority({
      root: await directory("bornagent-as33-recovery-state-"),
    });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root: await directory("bornagent-as33-recovery-repository-"),
    });
    const seed = new SessionRegistry(authority.paths, repositories);
    const created = await seed.create({
      expectedHead: await seed.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    let fullScanCount = 0;
    const recovered = new SessionRegistry(authority.paths, repositories, {
      onRunCatalogFullScan: () => { fullScanCount += 1; },
    });
    await recovered.readRunCancelBarrier(
      repository.registration.repositoryId,
      created.entry.sessionId,
      randomUUID(),
    );
    expect(fullScanCount).toBe(1);
  });

  it("AS3.3 active writer stable reads perform one full projection per critical read", async () => {
    const stateRoot = await directory("bornagent-as33-projection-state-");
    const repositoryRoot = await directory("bornagent-as33-projection-repository-");
    const authority = await loadOrCreateHostControlAuthority({ root: stateRoot });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const sessions = new SessionRegistry(authority.paths, repositories);
    const created = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    let fullProjectionCount = 0;
    const projection = new SessionProjectionService({
      broker: new SessionOwnerBroker(),
      disclosureProfileSha256: "b".repeat(64),
      observation: { onFullProjection: () => { fullProjectionCount += 1; } },
      repositories,
      sessions,
      signer: new SessionLedgerHeadSigner(authority.integrityKey),
    });
    const writer = await V2SessionWriter.createNew(repositoryRoot, created.entry.sessionId);
    try {
      const activeRead = projection.activeReadPort({ entry: created.entry, writer });
      for (let index = 0; index < 4; index += 1) {
        const before = fullProjectionCount;
        await activeRead.readStableSnapshot();
        expect(fullProjectionCount - before).toBe(1);
      }
    } finally {
      await writer.close();
    }
  });
});
