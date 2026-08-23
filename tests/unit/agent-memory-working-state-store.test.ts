import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import { ContextProjector } from "../../src/context/context-projector.js";
import { DeterministicTokenEstimator } from "../../src/context/token-estimator.js";
import {
  ExactSessionEvidenceReader,
  ExactSessionEvidenceV1,
} from "../../src/control-plane/exact-session-evidence-reader.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";
import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { buildWorkingStateSnapshotV1 } from "../../src/memory/working-state/working-state-builder.js";
import { createWorkingStateSnapshotV1 } from "../../src/memory/working-state/working-state-schema.js";
import { WorkingStateStore } from "../../src/memory/working-state/working-state-store.js";
import { WorkingStateProjectionSession } from "../../src/memory/working-state/working-state-projection-session.js";
import { resolveContextBudget } from "../../src/context/token-estimator.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-am1-session-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-am1-state-"));
  temporary.push(workspace, stateRoot);
  const sessionId = randomUUID();
  const runId = randomUUID();
  const writer = await V2SessionWriter.createNew(workspace, sessionId);
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId,
    sessionId,
    timestamp: () => "2026-08-23T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "agent",
      input: { role: "user", text: "Build a bounded working snapshot." },
      max_duration_ms: 60_000,
      max_steps: 2,
      max_tokens: 4_000,
      max_tool_output_bytes: 262_144,
      model: "am1-model",
      provider: "fake",
      request_timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "deterministic-fake",
      adapter_version: "am1-v1",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "a".repeat(64),
      model: "am1-model",
      provider: "fake",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
  const signer = new SessionLedgerHeadSigner(Buffer.alloc(32, 17));
  const estimator = new DeterministicTokenEstimator({
    bytesPerToken: 3,
    itemOverheadTokens: 8,
    model: "am1-model",
    provider: "offline-fixture",
    tokenizer: "utf8-deterministic-upper-bound",
    version: "am1-v1",
  });
  const snapshot = async () => {
    const evidence = await new ExactSessionEvidenceReader().read({ sessionId, workspace });
    const context = new ContextProjector(estimator).project({
      epoch: 0,
      events: evidence.events,
      systemInstructions: [{
        id: "am1-system",
        text: "AM1 deterministic fixture.",
        version: "v1",
      }],
    });
    return {
      evidence,
      snapshot: buildWorkingStateSnapshotV1({
        context,
        evidence,
        signer,
        taskState: TaskStateMachine.project(evidence.events),
      }),
    };
  };
  return {
    estimator,
    publisher,
    runId,
    sessionId,
    signer,
    snapshot,
    stateRoot,
    workspace,
    writer,
  };
}

function sessionRoot(stateRoot: string, sessionId: string): string {
  const sessionKey = sha256Canonical({
    domain: "bornagent.working-state-session.v1",
    sessionId,
  });
  return join(
    stateRoot,
    "memory",
    "v1",
    "working",
    "sessions",
    sessionKey,
  );
}

function currentPath(stateRoot: string, sessionId: string): string {
  return join(sessionRoot(stateRoot, sessionId), "current.json");
}

function objectsPath(stateRoot: string, sessionId: string): string {
  return join(sessionRoot(stateRoot, sessionId), "objects");
}

async function appendText(
  publisher: EventPublisher,
  delta: string,
): Promise<void> {
  await publisher.publish({
    data: {
      input_kind: "user_task",
      max_steps: 2,
      remaining_duration_ms: 60_000,
      remaining_tokens: 4_000,
      remaining_tool_output_bytes: 262_144,
      step: 1,
    },
    type: "agent.step.started",
  });
  await publisher.publish({
    data: { delta, visibility: "user" },
    type: "text.delta",
  });
}

describe("AM1 working-state sidecar", () => {
  it("publishes strict current and previous snapshots without becoming session truth", async () => {
    const value = await fixture();
    const store = await WorkingStateStore.create(value);
    const first = await value.snapshot();
    const firstPointer = await store.publish({
      readSourceHead: () => Promise.resolve(first.snapshot.sourceHead),
      snapshot: first.snapshot,
    });
    expect(firstPointer.previous).toBeNull();

    await appendText(value.publisher, "first durable suffix");
    const second = await value.snapshot();
    const secondPointer = await store.publish({
      readSourceHead: () => Promise.resolve(second.snapshot.sourceHead),
      snapshot: second.snapshot,
    });
    const readback = await store.readCurrent({
      evidence: second.evidence,
      signer: value.signer,
    });

    expect(secondPointer.previous?.snapshotSha256).toBe(first.snapshot.snapshotSha256);
    expect(readback.rebuildReason).toBeNull();
    expect(readback.snapshot?.snapshotSha256).toBe(second.snapshot.snapshotSha256);
    expect(value.writer.events).toHaveLength(second.snapshot.sourceHead.sequence);

    await value.publisher.publish({
      data: {
        duration_ms: 1,
        outcome: "final",
        step: 1,
        text_chars: "first durable suffix".length,
      },
      type: "agent.step.completed",
    });
    const third = await value.snapshot();
    const thirdPointer = await store.publish({
      readSourceHead: () => Promise.resolve(third.snapshot.sourceHead),
      snapshot: third.snapshot,
    });
    expect(thirdPointer.previous?.snapshotSha256).toBe(
      second.snapshot.snapshotSha256,
    );
    expect(await readdir(objectsPath(value.stateRoot, value.sessionId))).toHaveLength(2);
    await value.writer.close();
  });

  it("keeps a synced orphan non-authoritative and removes it after exact retry", async () => {
    const value = await fixture();
    const current = await value.snapshot();
    const crashing = await WorkingStateStore.create({
      ...value,
      faults: {
        afterSnapshotSync: () => {
          throw new Error("AM1_FAULT_AFTER_SNAPSHOT_SYNC");
        },
      },
    });
    await expect(crashing.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    })).rejects.toMatchObject({ code: "working_state_publish_failed" });
    const stable = await WorkingStateStore.create(value);
    expect(await stable.readCurrent()).toMatchObject({ rebuildReason: "missing" });
    expect(await readdir(objectsPath(value.stateRoot, value.sessionId))).toHaveLength(1);
    const orphan = `.current.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(
      join(sessionRoot(value.stateRoot, value.sessionId), orphan),
      "orphan pointer bytes",
      "utf8",
    );

    await stable.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    });
    expect(await stable.readCurrent({
      evidence: current.evidence,
      signer: value.signer,
    })).toMatchObject({ rebuildReason: null });
    expect(await readdir(objectsPath(value.stateRoot, value.sessionId))).toHaveLength(1);
    expect(await readdir(sessionRoot(value.stateRoot, value.sessionId))).not.toContain(orphan);
    await value.writer.close();
  });

  it("can lose the entire derived working root without changing cold reconstruction", async () => {
    const value = await fixture();
    const current = await value.snapshot();
    const store = await WorkingStateStore.create(value);
    await store.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    });

    await rm(join(value.stateRoot, "memory", "v1", "working"), {
      force: true,
      recursive: true,
    });
    expect(await store.readCurrent()).toMatchObject({ rebuildReason: "missing" });
    const reopened = await WorkingStateStore.create(value);
    expect(await reopened.readCurrent()).toMatchObject({ rebuildReason: "missing" });
    expect((await value.snapshot()).snapshot.snapshotSha256).toBe(
      current.snapshot.snapshotSha256,
    );
    await value.writer.close();
  });

  it("couples a valid sidecar to suffix-only and zero-work process projections", async () => {
    const value = await fixture();
    const store = await WorkingStateStore.create(value);
    const session = new WorkingStateProjectionSession({
      readLatestEvidence: () => new ExactSessionEvidenceReader().read({
        sessionId: value.sessionId,
        workspace: value.workspace,
      }),
      runtime: {
        budget: resolveContextBudget(
          {
            contextWindowTokens: 32_768,
            maximumOutputTokens: 4_096,
            source: "user_conservative_limit",
          },
          {
            compactionThreshold: 0.75,
            fixedSafetyMarginTokens: 256,
            reservedOutputTokens: 4_096,
          },
        ),
        estimator: value.estimator,
        systemInstructions: "AM1 deterministic fixture.",
      },
      signer: value.signer,
      store,
    });
    const project = async () => {
      const evidence = await new ExactSessionEvidenceReader().read({
        sessionId: value.sessionId,
        workspace: value.workspace,
      });
      return session.projectAndPublish({
        evidence,
        planning: { epoch: 0 },
        taskState: TaskStateMachine.project(evidence.events),
      });
    };

    const first = await project();
    expect(first).toMatchObject({
      observation: { mode: "cold", sourceEventsApplied: 2 },
      sidecarRebuildReason: "missing",
    });
    await appendText(value.publisher, "coordinated suffix");
    const second = await project();
    expect(second).toMatchObject({
      observation: { mode: "incremental", sourceEventsApplied: 2 },
      sidecarRebuildReason: null,
    });
    const noOp = await project();
    expect(noOp).toMatchObject({
      observation: { mode: "incremental", sourceEventsApplied: 0 },
      sidecarRebuildReason: null,
    });
    expect(noOp.snapshot.snapshotSha256).toBe(second.snapshot.snapshotSha256);
    await value.writer.close();
  });

  it("leaves the prior pointer authoritative across snapshot and pointer crash boundaries", async () => {
    const value = await fixture();
    const baseline = await value.snapshot();
    const stable = await WorkingStateStore.create(value);
    await stable.publish({
      readSourceHead: () => Promise.resolve(baseline.snapshot.sourceHead),
      snapshot: baseline.snapshot,
    });
    await appendText(value.publisher, "crash suffix");
    const next = await value.snapshot();
    const crashing = await WorkingStateStore.create({
      ...value,
      faults: {
        beforePointerInstall: () => {
          throw new Error("AM1_FAULT_BEFORE_POINTER");
        },
      },
    });

    await expect(crashing.publish({
      readSourceHead: () => Promise.resolve(next.snapshot.sourceHead),
      snapshot: next.snapshot,
    })).rejects.toMatchObject({ code: "working_state_publish_failed" });
    const afterCrash = await stable.readCurrent({
      evidence: next.evidence,
      signer: value.signer,
    });
    expect(afterCrash.snapshot?.snapshotSha256).toBe(baseline.snapshot.snapshotSha256);

    const recovered = await stable.publish({
      readSourceHead: () => Promise.resolve(next.snapshot.sourceHead),
      snapshot: next.snapshot,
    });
    expect(recovered.current.snapshotSha256).toBe(next.snapshot.snapshotSha256);
    await value.writer.close();
  });

  it("returns a typed cold-rebuild reason for corrupt or future sidecars", async () => {
    const value = await fixture();
    const store = await WorkingStateStore.create(value);
    const current = await value.snapshot();
    await store.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    });
    await writeFile(currentPath(value.stateRoot, value.sessionId), "{\"schemaVersion\":1,\"schemaVersion\":1}\n", "utf8");
    expect(await store.readCurrent()).toMatchObject({
      rebuildReason: "corrupt",
      snapshot: null,
    });

    const repaired = await store.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    });
    expect(repaired.current.snapshotSha256).toBe(current.snapshot.snapshotSha256);
    const shorterEvidence = new ExactSessionEvidenceV1(
      current.evidence.events.slice(0, -1),
      current.evidence.rawSha256,
      value.sessionId,
    );
    expect(await store.readCurrent({
      evidence: shorterEvidence,
      signer: value.signer,
    })).toMatchObject({ rebuildReason: "future_head", snapshot: null });
    const shorterContext = new ContextProjector(value.estimator).project({
      epoch: 0,
      events: shorterEvidence.events,
      systemInstructions: [{
        id: "am1-system",
        text: "AM1 deterministic fixture.",
        version: "v1",
      }],
    });
    const rebuilt = buildWorkingStateSnapshotV1({
      context: shorterContext,
      evidence: shorterEvidence,
      signer: value.signer,
      taskState: TaskStateMachine.project(shorterEvidence.events),
    });
    await store.publish({
      readSourceHead: () => Promise.resolve(rebuilt.sourceHead),
      snapshot: rebuilt,
    });
    expect(await store.readCurrent({
      evidence: shorterEvidence,
      signer: value.signer,
    })).toMatchObject({ rebuildReason: null });
    await value.writer.close();
  });

  it("rejects append races and same-prefix divergent snapshot bytes", async () => {
    const value = await fixture();
    const store = await WorkingStateStore.create(value);
    const current = await value.snapshot();
    const wrongHead = value.signer.create({
      eventId: randomUUID(),
      rawEventSha256: "f".repeat(64),
      sequence: current.snapshot.sourceHead.sequence,
      sessionId: value.sessionId,
    }).publicHead;
    await expect(store.publish({
      readSourceHead: () => Promise.resolve(wrongHead),
      snapshot: current.snapshot,
    })).rejects.toMatchObject({ code: "working_state_busy" });
    expect(await store.readCurrent()).toMatchObject({ rebuildReason: "missing" });

    await store.publish({
      readSourceHead: () => Promise.resolve(current.snapshot.sourceHead),
      snapshot: current.snapshot,
    });
    const { snapshotSha256, ...content } = current.snapshot;
    const divergent = createWorkingStateSnapshotV1({
      ...content,
      hotTailTurnGroupIds: [...content.hotTailTurnGroupIds, "turn:divergent"],
    });
    await expect(store.publish({
      readSourceHead: () => Promise.resolve(divergent.sourceHead),
      snapshot: divergent,
    })).rejects.toMatchObject({ code: "working_state_stale" });
    expect((await readFile(currentPath(value.stateRoot, value.sessionId), "utf8"))).toContain(
      snapshotSha256,
    );
    await value.writer.close();
  });
});
