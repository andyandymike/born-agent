import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendPreparedCapabilitySnapshotArtifact,
  prepareCapabilityRunSnapshot,
} from "../../src/capabilities/capability-run-snapshot.js";
import type { CapabilitySnapshotV1 } from "../../src/capabilities/capability-types.js";
import { StablePackageReader } from "../../src/capabilities/stable-package-reader.js";
import { reconstructArtifactSessionLedger } from "../../src/artifacts/artifact-session-ledger.js";
import { OutcomeReportBuilder } from "../../src/coordination/outcome-report.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { runCli } from "../../src/cli/run-cli.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  createMemoryIO,
  createRuntime,
  FakeToolRegistry,
  InMemorySessionWriter,
} from "../helpers.js";
import {
  createTestCapabilityRoots,
  writeTestCapabilityPackage,
  writeTestSourceIndex,
} from "../phase18a-test-helpers.js";

const temporary: string[] = [];
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const RUN_STARTED_ID = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "bornagent-phase18a-session-"));
  temporary.push(base);
  const roots = await createTestCapabilityRoots(base);
  const packageValue = await writeTestCapabilityPackage(join(roots.userRoot, "review"), {
    includeHook: true,
    includeMcp: true,
  });
  await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 5, [
    { enabled: true, package: packageValue, path: "review" },
  ]);
  return { packageValue, roots };
}

const backendSelected: Extract<RunEvent, { type: "backend.selected" }>["data"] = {
  adapter: "deterministic-fake",
  adapter_version: "phase18a-test-v1",
  capabilities: {
    cancellation: "abort_signal",
    reasoning: "opaque_passthrough",
    streaming: true,
    tools: "strict",
    usage: "complete",
  },
  config_fingerprint: "0".repeat(64),
  model: "qwen3:1.7b",
  provider: "ollama",
  resume_capability: "canonical_only",
};

describe("Phase 18A run snapshot and replay", () => {
  it("binds the physical snapshot before run.started and replays after sources disappear", async () => {
    const { roots } = await fixture();
    const writer = await V2SessionWriter.createNew(roots.workspace, SESSION_ID, {
      timestamp: () => "2026-08-08T00:00:00.000Z",
    });
    const snapshot = await roots.platform.createSnapshot("2026-08-08T00:00:00.000Z");
    const prepared = await prepareCapabilityRunSnapshot({
      existingEvents: [],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      snapshot,
      workspace: roots.workspace,
    });
    const objectPath = join(roots.workspace, ".bornagent", ...prepared.binding.object_ref.split("/"));
    await expect(access(objectPath)).resolves.toBeUndefined();
    expect(writer.readDecodedEvents()).toEqual([]);

    const eventIds = [
      RUN_STARTED_ID,
      "44444444-4444-4444-8444-444444444444",
    ];
    const publisher = new EventPublisher({
      randomUUID: () => eventIds.shift()!,
      renderer: { render: () => undefined },
      runId: RUN_ID,
      sessionId: SESSION_ID,
      timestamp: () => "2026-08-08T00:00:00.000Z",
      writer,
    });
    const runStarted = await publisher.publish({
      data: {
        capability_snapshot: prepared.binding,
        command: "chat",
        input: { role: "user", text: "inspect" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 30_000,
        tools: [],
        tools_enabled: false,
        workspace: roots.workspace,
      },
      type: "run.started",
    });
    await publisher.publish({ data: backendSelected, type: "backend.selected" });
    await appendPreparedCapabilitySnapshotArtifact({
      originEventId: runStarted.event_id,
      prepared,
      runId: RUN_ID,
      writer,
    });
    await writer.close();

    await rm(roots.userRoot, { force: true, recursive: true });
    const events = await readStoredSession(writer.path);
    const session = reconstructMultiRunSession(events);
    expect(session.artifacts).toMatchObject({
      authorizedReferenceCount: 1,
      orphanedReferenceCount: 0,
      storedReferenceCount: 1,
    });
    expect(session.lastRun?.started.data.capability_snapshot).toEqual(prepared.binding);
    expect(new OutcomeReportBuilder().build(session).capabilities).toMatchObject({
      componentCount: 3,
      eligiblePluginCount: 1,
      snapshotId: snapshot.snapshotId,
    });
    const frozen = JSON.parse(await readFile(objectPath, "utf8")) as CapabilitySnapshotV1;
    expect(frozen).toEqual(snapshot);
    expect(frozen.plugins[0]?.components.map((component) => component.identity.kind)).toEqual([
      "hook",
      "mcp_server",
      "skill",
    ]);
  });

  it("leaves only a physical orphan when a crash occurs before run.started", async () => {
    const { roots } = await fixture();
    const writer = await V2SessionWriter.createNew(roots.workspace, SESSION_ID);
    const snapshot = await roots.platform.createSnapshot("2026-08-08T00:00:00.000Z");
    const prepared = await prepareCapabilityRunSnapshot({
      existingEvents: [],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      snapshot,
      workspace: roots.workspace,
    });
    await writer.close();
    const events = await readStoredSession(writer.path);
    expect(events).toEqual([]);
    expect(reconstructArtifactSessionLedger(events, SESSION_ID)).toMatchObject({
      authorizedReferenceCount: 0,
      storedReferenceCount: 0,
    });
    await expect(
      access(join(roots.workspace, ".bornagent", ...prepared.binding.object_ref.split("/"))),
    ).resolves.toBeUndefined();
  });

  it("keeps run.started as the frozen authority if the artifact event is never appended", async () => {
    const { roots } = await fixture();
    const writer = await V2SessionWriter.createNew(roots.workspace, SESSION_ID, {
      timestamp: () => "2026-08-08T00:00:00.000Z",
    });
    const snapshot = await roots.platform.createSnapshot("2026-08-08T00:00:00.000Z");
    const prepared = await prepareCapabilityRunSnapshot({
      existingEvents: [],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      snapshot,
      workspace: roots.workspace,
    });
    const publisher = new EventPublisher({
      randomUUID: () => RUN_STARTED_ID,
      renderer: { render: () => undefined },
      runId: RUN_ID,
      sessionId: SESSION_ID,
      timestamp: () => "2026-08-08T00:00:00.000Z",
      writer,
    });
    await publisher.publish({
      data: {
        capability_snapshot: prepared.binding,
        command: "chat",
        input: { role: "user", text: "inspect" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 30_000,
        tools: [],
        tools_enabled: false,
        workspace: roots.workspace,
      },
      type: "run.started",
    });
    await writer.close();

    const session = reconstructMultiRunSession(await readStoredSession(writer.path));
    expect(session.lastRun?.started.data.capability_snapshot).toEqual(prepared.binding);
    expect(session.artifacts.storedReferenceCount).toBe(0);
    expect(new OutcomeReportBuilder().build(session).capabilities?.snapshotId).toBe(
      snapshot.snapshotId,
    );
  });

  it("freezes before tool construction, adds no Phase 18 tools, and refreshes only for a new run", async () => {
    const { packageValue, roots } = await fixture();
    const writers: InMemorySessionWriter[] = [];
    let constructedRegistry: FakeToolRegistry | undefined;
    const createToolRegistry = vi.fn(async () => {
      const writer = writers.at(-1)!;
      expect(writer.persistedTypes.slice(0, 3)).toEqual([
        "run.started",
        "backend.selected",
        "artifact.stored",
      ]);
      constructedRegistry = new FakeToolRegistry();
      return constructedRegistry;
    });
    const runtime = createRuntime({
      createCapabilityPlatform: () => roots.platform,
      createSessionWriter: async () => {
        const writer = new InMemorySessionWriter();
        writers.push(writer);
        return writer;
      },
      createToolRegistry,
      cwd: roots.workspace,
    });
    const firstIo = createMemoryIO();
    expect(
      await runCli(["chat", "inspect", "--provider", "ollama"], firstIo.io, runtime),
    ).toBe(0);
    const firstStarted = writers[0]!.events.find((event) => event.type === "run.started");
    const firstBinding = firstStarted?.data.capability_snapshot;
    expect(firstBinding?.component_count).toBe(3);
    const definitions = constructedRegistry!.modelDefinitions;
    expect(definitions.map((definition) => definition.name)).toEqual(["read_file"]);
    expect(definitions.map((definition) => definition.name)).not.toContain("skill");
    expect(definitions.map((definition) => definition.name)).not.toContain("mcp");
    expect(definitions.map((definition) => definition.name)).not.toContain("hook");
    expect(createToolRegistry).toHaveBeenCalledOnce();
    await expect(
      access(join(roots.userRoot, "review", "phase18a-executed.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(roots.userRoot, "review", "extra.txt"), "new inventory byte\n", "utf8");
    const refreshed = await StablePackageReader.read(join(roots.userRoot, "review"));
    expect(refreshed.pluginSha256).not.toBe(packageValue.pluginSha256);
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 6, [
      { enabled: true, package: refreshed, path: "review" },
    ]);
    const secondIo = createMemoryIO();
    expect(
      await runCli(["chat", "inspect again", "--provider", "ollama"], secondIo.io, runtime),
    ).toBe(0);
    const secondStarted = writers[1]!.events.find((event) => event.type === "run.started");
    expect(secondStarted?.data.capability_snapshot?.snapshot_id).not.toBe(
      firstBinding?.snapshot_id,
    );
    expect(firstStarted?.data.capability_snapshot).toEqual(firstBinding);
    await expect(
      access(join(roots.userRoot, "review", "phase18a-executed.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
