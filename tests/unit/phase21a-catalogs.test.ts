import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { SessionRegistry, sessionZeroHeadSha256 } from "../../src/control-plane/session-registry.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function registries() {
  const authority = await loadOrCreateHostControlAuthority({
    root: await directory("bornagent-phase21a-state-"),
  });
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
  return {
    repositories,
    sessions: new SessionRegistry(authority.paths, repositories),
  };
}

describe("Phase 21A repository and session catalogs", () => {
  it("uses revision/hash CAS and deduplicates one canonical repository root", async () => {
    const { repositories } = await registries();
    const root = await directory("bornagent-phase21a-repo-");
    const empty = await repositories.head();
    expect(empty).toMatchObject({ lastRecordId: null, revision: 0 });
    const first = await repositories.register({ expectedHead: empty, operationId: randomUUID(), root });
    expect(first.created).toBe(true);
    expect(first.head.revision).toBe(1);
    const duplicate = await repositories.register({
      expectedHead: first.head,
      operationId: randomUUID(),
      root,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.registration.repositoryId).toBe(first.registration.repositoryId);
    expect((await repositories.publicView(first.registration.repositoryId))?.label).toBeTruthy();
    expect(JSON.stringify(await repositories.publicView(first.registration.repositoryId))).not.toContain(root);
  });

  it("does not let a stale same-root operation claim another operation's registration", async () => {
    const { repositories } = await registries();
    const root = await directory("bornagent-phase21a-same-root-race-");
    const staleHead = await repositories.head();
    const winner = await repositories.register({
      expectedHead: staleHead,
      operationId: randomUUID(),
      root,
    });

    await expect(repositories.register({
      expectedHead: staleHead,
      operationId: randomUUID(),
      root,
    })).rejects.toMatchObject({ code: "control_catalog_conflict" });
    expect(await repositories.list()).toEqual([winner.registration]);
  });

  it("serializes competing catalog writers without losing a revision", async () => {
    const { repositories } = await registries();
    const leftRoot = await directory("bornagent-phase21a-left-");
    const rightRoot = await directory("bornagent-phase21a-right-");
    const expectedHead = await repositories.head();
    const results = await Promise.allSettled([
      repositories.register({ expectedHead, operationId: randomUUID(), root: leftRoot }),
      repositories.register({ expectedHead, operationId: randomUUID(), root: rightRoot }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await repositories.list()).toHaveLength(1);
    expect((await repositories.head()).revision).toBe(1);
  });

  it("creates a catalog-only zero-head session and persists materialization barriers", async () => {
    const { repositories, sessions } = await registries();
    const repositoryRoot = await directory("bornagent-phase21a-session-repo-");
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const session = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    expect(session.entry.initialLedgerHead).toMatchObject({ sequence: 0, eventId: null });
    await expect(access(join(repositoryRoot, ".bornagent", "sessions", `${session.entry.sessionId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });

    const intentContent = {
      expectedZeroHeadSha256: sessionZeroHeadSha256(session.entry.initialLedgerHead),
      intendedStorageIdentitySha256: sha256Canonical({ repositoryRoot, sessionId: session.entry.sessionId }),
      materializationIntentId: randomUUID(),
      operationId: randomUUID(),
      preparedActionSha256: "a".repeat(64),
      repositoryId: repository.registration.repositoryId,
      sessionId: session.entry.sessionId,
    };
    const intent = await sessions.appendMaterializationIntent({
      expectedHead: session.head,
      intent: intentContent,
    });
    await expect(sessions.appendMaterializationIntent({
      expectedHead: intent.head,
      intent: { ...intentContent, materializationIntentId: randomUUID(), operationId: randomUUID() },
    })).rejects.toThrow(/already has a materialization intent/u);
    const projection = await sessions.project(repository.registration.repositoryId);
    expect(projection.entries).toHaveLength(1);
    expect(projection.intents).toHaveLength(1);
    expect(projection.materializations).toHaveLength(0);
  });
});
