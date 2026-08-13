import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { runCli } from "../../src/cli/run-cli.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { CredentialResolver } from "../../src/security/credential-resolver.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import { phase8NetworkActivityReport } from "../setup-network-tripwire.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A zero-listener and zero-credential boundary", () => {
  it("runs ordinary catalog control and queries without network, discovery, or credential access", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const connect = vi.spyOn(Socket.prototype, "connect");
    const lookup = vi.spyOn(dns, "lookup");
    const promisesLookup = vi.spyOn(dns.promises, "lookup");
    const fetch = globalThis.fetch === undefined ? null : vi.spyOn(globalThis, "fetch");
    const credentials = vi.spyOn(CredentialResolver.prototype, "resolve");
    const launches: unknown[] = [];

    const stateRoot = await directory("bornagent-phase21a-zero-transport-state-");
    const repositoryRoot = await directory("bornagent-phase21a-zero-transport-repo-");
    const plane = await createPhase21ALocalControlPlane({
      launcher: {
        launch: async (input) => {
          launches.push(input);
          throw new Error("catalog-only control must not launch an Agent");
        },
      },
      stateRoot,
    });
    const context = plane.context("cli", randomUUID());

    const repositoryPayload = { root: repositoryRoot };
    const repositoryHead = await plane.repositories.head();
    const repositoryPrepared = await plane.actions.prepare(context, {
      actionKind: "repository.register",
      payload: repositoryPayload,
      payloadSha256: sha256Canonical(repositoryPayload),
      prepareIdempotencyKey: "zero-network-repository-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: plane.repositories.resourceScope,
        expectedCatalogVersion: {
          kind: "revision",
          revision: repositoryHead.revision,
          sha256: repositoryHead.catalogSha256,
        },
        kind: "new_repository",
      },
    });
    expect(repositoryPrepared.status).toBe("ok");
    const repositoryCommitted = await plane.actions.commit(context, {
      idempotencyKey: "zero-network-repository-commit",
      preparedActionId: repositoryPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: repositoryPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(repositoryCommitted.status).toBe("ok");
    const repositoryId = repositoryCommitted.resourceScope?.kind === "repository"
      ? repositoryCommitted.resourceScope.repositoryId
      : "";

    const sessionPayload = {};
    const sessionCatalogHead = await plane.sessions.head(repositoryId);
    const sessionPrepared = await plane.actions.prepare(context, {
      actionKind: "session.create",
      payload: sessionPayload,
      payloadSha256: sha256Canonical(sessionPayload),
      prepareIdempotencyKey: "zero-network-session-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: plane.sessions.resourceScope(repositoryId),
        expectedCatalogVersion: {
          kind: "revision",
          revision: sessionCatalogHead.revision,
          sha256: sessionCatalogHead.catalogSha256,
        },
        kind: "new_session",
      },
    });
    expect(sessionPrepared.status).toBe("ok");
    const sessionCommitted = await plane.actions.commit(context, {
      idempotencyKey: "zero-network-session-commit",
      preparedActionId: sessionPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: sessionPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(sessionCommitted).toMatchObject({ status: "ok", ledgerHead: { sequence: 0 } });

    const listPayload = { limit: 200 };
    const listed = await plane.queries.query(context, {
      atVersion: null,
      pageCursor: null,
      payload: listPayload,
      queryKind: "repository.list",
      requestId: randomUUID(),
      resourceScope: plane.repositories.resourceScope,
      schemaVersion: 1,
    });
    expect(listed).toMatchObject({
      status: "ok",
      result: { value: { repositories: [{ repositoryId }] } },
    });

    expect(launches).toEqual([]);
    expect(credentials).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(promisesLookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(phase8NetworkActivityReport()).toMatchObject({
      billableRequestCount: 0,
      blockedRemoteAttemptCount: 0,
      openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 0,
      remoteProviderRequestCount: 0,
      remoteSocketAttemptCount: 0,
    });
  });

  it("keeps the default real CLI Agent adapter credential-free and listener-free", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const connect = vi.spyOn(Socket.prototype, "connect");
    const lookup = vi.spyOn(dns, "lookup");
    const promisesLookup = vi.spyOn(dns.promises, "lookup");
    const fetch = globalThis.fetch === undefined ? null : vi.spyOn(globalThis, "fetch");
    const credentials = vi.spyOn(CredentialResolver.prototype, "resolve");
    let ambientCredentialReads = 0;
    const environment = new Proxy<Record<string, string | undefined>>({}, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS"].includes(property)
        ) {
          ambientCredentialReads += 1;
          throw new Error(`unexpected ambient credential read: ${property}`);
        }
        return Reflect.get(target, property, receiver) as string | undefined;
      },
    });
    const cwd = await directory("bornagent-phase21a-default-cli-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-default-cli-state-");
    const memory = createMemoryIO();
    const exit = await runCli(
      ["agent", "inspect the bounded local fixture", "--task-profile", "read-only", "--max-steps", "1"],
      memory.io,
      createRuntime({ controlPlaneStateRoot, cwd, env: environment }),
    );

    expect(exit, memory.readStderr()).toBe(0);
    expect(ambientCredentialReads).toBe(0);
    expect(credentials).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(promisesLookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(phase8NetworkActivityReport()).toMatchObject({
      billableRequestCount: 0,
      blockedRemoteAttemptCount: 0,
      openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 0,
      remoteProviderRequestCount: 0,
      remoteSocketAttemptCount: 0,
    });
  });
});
