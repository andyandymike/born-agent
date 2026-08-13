import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptLegacySessionThroughApplicationService,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A authenticated legacy session adoption", () => {
  it("binds catalog ownership to the control operation without rewriting legacy history", async () => {
    const root = await directory("bornagent-phase21a-legacy-repo-");
    const stateRoot = await directory("bornagent-phase21a-legacy-state-");
    const sessionId = randomUUID();
    const writer = await V2SessionWriter.createNew(root, sessionId);
    const first = await writer.appendTaskEvent("goal.created", {
      goal_id: randomUUID(),
      objective: "Preserve the historical legacy event exactly",
      origin: { input_surface: "cli", kind: "user" },
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    await writer.close();
    const sessionPath = join(root, ".bornagent", "sessions", `${sessionId}.jsonl`);
    const before = await readFile(sessionPath);
    const io = createMemoryIO();
    const runtime = createRuntime({ controlPlaneStateRoot: stateRoot, cwd: root });
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("legacy adoption must not launch an Agent"); } },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root,
    });
    const context = plane.context("cli", runtime.randomUUID());

    const adopted = await adoptLegacySessionThroughApplicationService(
      plane,
      context,
      runtime,
      repository.registration.repositoryId,
      sessionId,
      io.io,
    );
    expect(adopted).toEqual({ sessionId });
    const operation = (await plane.operations.list()).find((candidate) => candidate.actionKind === "session.adopt_legacy");
    expect(operation).toMatchObject({ state: "completed" });
    const catalog = await plane.sessions.project(repository.registration.repositoryId);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      createdOperationId: operation!.operationId,
      legacyAdoption: { firstEventId: first.eventId },
      sessionId,
    });
    expect(catalog.entries[0]!.createdOperationId).not.toBe(first.eventId);

    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId,
    });
    expect(snapshot.eventMetadata[0]).toMatchObject({
      eventId: first.eventId,
      userActionOrigin: {
        auditAvailability: "not_available_legacy",
        authenticationId: null,
        inputSurface: "cli",
        kind: "legacy_surface",
        operationId: null,
        principalId: "legacy_local_owner",
        requestId: null,
      },
    });
    expect(await readFile(sessionPath)).toEqual(before);
    expect(io.readStderr()).toBe("");
  });
});
