import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  reconstructArtifactSessionLedger,
  type ArtifactSessionLedgerError,
  type ArtifactLedgerReplayEvent,
} from "../../src/artifacts/artifact-session-ledger.js";
import {
  ArtifactSessionRuntime,
  type DurableArtifactEventAppender,
} from "../../src/artifacts/artifact-session-runtime.js";
import type { Phase10ArtifactEvent } from "../../src/artifacts/artifact-types.js";
import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000031";
const OTHER_SESSION_ID = "10000000-0000-4000-8000-000000000032";
const RUN_ID = "20000000-0000-4000-8000-000000000031";
const OTHER_RUN_ID = "20000000-0000-4000-8000-000000000032";
const ORIGIN_EVENT_ID = "30000000-0000-4000-8000-000000000031";
const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase10-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

function replayEvent(input: {
  readonly data?: unknown;
  readonly eventId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionSeq: number;
  readonly type: string;
}): ArtifactLedgerReplayEvent {
  return {
    data: input.data ?? {},
    eventId: input.eventId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    scope: input.runId === undefined ? "session" : "run",
    sessionId: input.sessionId ?? SESSION_ID,
    sessionSeq: input.sessionSeq,
    type: input.type,
  };
}

function storedData(input: {
  readonly bytes?: number;
  readonly captureStatus?:
    | "complete"
    | "truncated_artifact_limit"
    | "truncated_run_budget"
    | "truncated_session_budget";
  readonly captureTruncated?: boolean;
  readonly mediaType?:
    | "text/markdown; charset=utf-8"
    | "text/plain; charset=utf-8";
  readonly objectSessionId?: string;
  readonly originEventId?: string;
  readonly sha256?: string;
} = {}) {
  const sha256 = input.sha256 ?? "a".repeat(64);
  return {
    artifact_id: `sha256:${sha256}`,
    bytes: input.bytes ?? 4,
    capture_status: input.captureStatus ?? "complete",
    capture_truncated: input.captureTruncated ?? false,
    media_type: input.mediaType ?? "text/plain; charset=utf-8",
    object_ref: `artifacts/${input.objectSessionId ?? SESSION_ID}/objects/${sha256}`,
    origin_event_id: input.originEventId ?? ORIGIN_EVENT_ID,
    sha256,
  };
}

class RecordingAppender implements DurableArtifactEventAppender {
  readonly events: Phase10ArtifactEvent[] = [];

  constructor(private readonly failType?: Phase10ArtifactEvent["type"]) {}

  async appendArtifactEvent(
    _runId: string,
    event: Phase10ArtifactEvent,
  ): Promise<void> {
    if (event.type === this.failType) throw new Error("durable append failed");
    this.events.push(event);
  }
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

describe("Phase 10 artifact session ledger", () => {
  it("reconstructs unique allowlist refs and per-run/session capture usage", () => {
    const events = [
      replayEvent({
        eventId: ORIGIN_EVENT_ID,
        runId: RUN_ID,
        sessionSeq: 1,
        type: "tool.call.requested",
      }),
      replayEvent({
        data: storedData(),
        eventId: "30000000-0000-4000-8000-000000000032",
        runId: RUN_ID,
        sessionSeq: 2,
        type: "artifact.stored",
      }),
      replayEvent({
        eventId: "30000000-0000-4000-8000-000000000033",
        runId: OTHER_RUN_ID,
        sessionSeq: 3,
        type: "tool.call.requested",
      }),
      replayEvent({
        data: storedData({
          captureStatus: "truncated_run_budget",
          captureTruncated: true,
          mediaType: "text/markdown; charset=utf-8",
          originEventId: "30000000-0000-4000-8000-000000000033",
        }),
        eventId: "30000000-0000-4000-8000-000000000034",
        runId: OTHER_RUN_ID,
        sessionSeq: 4,
        type: "artifact.stored",
      }),
      replayEvent({
        data: {
          artifact_id: `sha256:${"a".repeat(64)}`,
          captured_bytes: 4,
          limit_bytes: 4,
          reason: "run_budget",
        },
        eventId: "30000000-0000-4000-8000-000000000035",
        runId: OTHER_RUN_ID,
        sessionSeq: 5,
        type: "artifact.capture.truncated",
      }),
    ];

    const ledger = reconstructArtifactSessionLedger(events, SESSION_ID);
    expect(ledger).toMatchObject({
      budgetUsage: {
        runBytes: { [OTHER_RUN_ID]: 4, [RUN_ID]: 4 },
        sessionBytes: 8,
      },
      storedReferenceCount: 2,
      truncatedCaptureEventCount: 1,
      uniqueObjectBytes: 4,
    });
    expect(ledger.references).toHaveLength(1);
    expect(ledger.objects).toEqual([
      expect.objectContaining({
        mediaTypes: [
          "text/markdown; charset=utf-8",
          "text/plain; charset=utf-8",
        ],
        referenceCount: 2,
        runIds: [RUN_ID, OTHER_RUN_ID],
        wasCaptureTruncated: true,
      }),
    ]);
  });

  it("rejects cross-session refs, cross-run origins, and conflicting identities", () => {
    const origin = replayEvent({
      eventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      sessionSeq: 1,
      type: "tool.call.requested",
    });
    const invalidCases: readonly {
      readonly code: ArtifactSessionLedgerError["code"];
      readonly events: readonly ArtifactLedgerReplayEvent[];
    }[] = [
      {
        code: "artifact_session_mismatch",
        events: [
          origin,
          replayEvent({
            data: storedData({ objectSessionId: OTHER_SESSION_ID }),
            eventId: "30000000-0000-4000-8000-000000000042",
            runId: RUN_ID,
            sessionSeq: 2,
            type: "artifact.stored",
          }),
        ],
      },
      {
        code: "artifact_origin_invalid",
        events: [
          origin,
          replayEvent({
            eventId: "30000000-0000-4000-8000-000000000098",
            runId: OTHER_RUN_ID,
            sessionSeq: 2,
            type: "tool.call.requested",
          }),
          replayEvent({
            data: storedData({
              originEventId: "30000000-0000-4000-8000-000000000098",
            }),
            eventId: "30000000-0000-4000-8000-000000000097",
            runId: RUN_ID,
            sessionSeq: 3,
            type: "artifact.stored",
          }),
        ],
      },
      {
        code: "artifact_identity_conflict",
        events: [
          origin,
          replayEvent({
            data: storedData(),
            eventId: "30000000-0000-4000-8000-000000000043",
            runId: RUN_ID,
            sessionSeq: 2,
            type: "artifact.stored",
          }),
          replayEvent({
            data: storedData({ bytes: 3 }),
            eventId: "30000000-0000-4000-8000-000000000044",
            runId: RUN_ID,
            sessionSeq: 3,
            type: "artifact.stored",
          }),
        ],
      },
    ];

    for (const fixture of invalidCases) {
      expect(() => reconstructArtifactSessionLedger(fixture.events, SESSION_ID)).toThrow(
        expect.objectContaining({ code: fixture.code }),
      );
    }
  });

  it("accepts a forward origin only when the referenced event exists in-session", () => {
    const futureOrigin = "30000000-0000-4000-8000-000000000045";
    const ledger = reconstructArtifactSessionLedger(
      [
        replayEvent({
          data: storedData({ originEventId: futureOrigin }),
          eventId: "30000000-0000-4000-8000-000000000046",
          runId: RUN_ID,
          sessionSeq: 1,
          type: "artifact.stored",
        }),
        replayEvent({
          data: {
            artifact_id: `sha256:${"a".repeat(64)}`,
            bytes: 4,
            content_sha256: "a".repeat(64),
            object_ref: `artifacts/${SESSION_ID}/objects/${"a".repeat(64)}`,
            relative_path: "AGENTS.md",
            state: "loaded",
          },
          eventId: futureOrigin,
          runId: RUN_ID,
          sessionSeq: 2,
          type: "repository.rules.loaded",
        }),
      ],
      SESSION_ID,
    );

    expect(ledger.storedReferences[0]?.originEventId).toBe(futureOrigin);
    expect(ledger).toMatchObject({
      authorizedReferenceCount: 1,
      orphanedReferenceCount: 0,
    });
  });

  it("keeps a crash-window capture as a budgeted orphan without read authority", async () => {
    const workspace = await temporaryWorkspace();
    const missingFutureOrigin = "30000000-0000-4000-8000-000000000099";
    const event = replayEvent({
      data: storedData({ originEventId: missingFutureOrigin }),
      eventId: "30000000-0000-4000-8000-000000000041",
      runId: RUN_ID,
      sessionSeq: 1,
      type: "artifact.stored",
    });
    const runtime = await ArtifactSessionRuntime.create({
      eventAppender: new RecordingAppender(),
      events: [event],
      runId: OTHER_RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });

    expect(runtime.initialLedger).toMatchObject({
      authorizedReferenceCount: 0,
      budgetUsage: { runBytes: { [RUN_ID]: 4 }, sessionBytes: 4 },
      orphanedReferenceCount: 1,
      storedReferenceCount: 1,
    });
    expect(runtime.initialLedger.references).toEqual([]);
    expect(runtime.initialLedger.storedReferences[0]).toMatchObject({
      authorityState: "pending_origin",
      originEventId: missingFutureOrigin,
    });
    await expect(
      runtime.reader.read({
        artifactId: `sha256:${"a".repeat(64)}`,
        maxBytes: 4,
        offsetBytes: 0,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_not_allowlisted" }));
  });

  it("rejects orphan/mismatched truncation facts and hard run-budget overflow", () => {
    const origin = replayEvent({
      eventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      sessionSeq: 1,
      type: "tool.call.requested",
    });
    expect(() =>
      reconstructArtifactSessionLedger(
        [
          origin,
          replayEvent({
            data: {
              captured_bytes: 1,
              limit_bytes: 1,
              reason: "artifact_limit",
            },
            eventId: "30000000-0000-4000-8000-000000000051",
            runId: RUN_ID,
            sessionSeq: 2,
            type: "artifact.capture.truncated",
          }),
        ],
        SESSION_ID,
      ),
    ).toThrow(expect.objectContaining({ code: "artifact_truncation_invalid" }));

    const largeEvents: ArtifactLedgerReplayEvent[] = [origin];
    for (let index = 0; index < 3; index += 1) {
      const sha256 = String(index + 1).repeat(64);
      largeEvents.push(
        replayEvent({
          data: storedData({
            bytes: index < 2 ? 16 * 1024 * 1024 : 1,
            sha256,
          }),
          eventId: `30000000-0000-4000-8000-${String(60 + index).padStart(12, "0")}`,
          runId: RUN_ID,
          sessionSeq: index + 2,
          type: "artifact.stored",
        }),
      );
    }
    expect(() => reconstructArtifactSessionLedger(largeEvents, SESSION_ID)).toThrow(
      expect.objectContaining({ code: "artifact_budget_exceeded" }),
    );
  });
});

describe("Phase 10 artifact session runtime and registry bridge", () => {
  it("uses the configured per-artifact capture default above 4 MiB", async () => {
    const workspace = await temporaryWorkspace();
    const appender = new RecordingAppender();
    const configuredBytes = 5 * 1024 * 1024;
    const runtime = await ArtifactSessionRuntime.create({
      budgets: { perArtifactBytes: configuredBytes },
      eventAppender: appender,
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "tool.call.requested",
        }),
      ],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const sourceBytes = 4 * 1024 * 1024 + 17;
    const result = await runtime.materialize({
      modelObservationBytes: 64,
      originEventId: ORIGIN_EVENT_ID,
      source: [Buffer.alloc(sourceBytes, 0x78)],
    });

    expect(runtime.store.budgets).toEqual({
      perArtifactBytes: configuredBytes,
      perRunBytes: 32 * 1024 * 1024,
      perSessionBytes: 256 * 1024 * 1024,
    });
    expect(result.physicalCaptureBytes).toBe(sourceBytes);
    expect(result.artifact?.captureStatus).toBe("complete");
    expect(appender.events.map(({ type }) => type)).toEqual([
      "artifact.stored",
    ]);
  });

  it("persists artifact facts before granting read authority", async () => {
    const workspace = await temporaryWorkspace();
    const appender = new RecordingAppender();
    const runtime = await ArtifactSessionRuntime.create({
      budgets: { perArtifactBytes: 5, perRunBytes: 10, perSessionBytes: 20 },
      eventAppender: appender,
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "tool.call.requested",
        }),
      ],
      runId: RUN_ID,
      secrets: ["private-secret"],
      sessionId: SESSION_ID,
      workspace,
    });
    const result = await runtime.materialize({
      captureBytes: 5,
      modelObservationBytes: 64,
      originEventId: ORIGIN_EVENT_ID,
      source: chunks("abcprivate-secret"),
    });

    expect(appender.events.map(({ type }) => type)).toEqual([
      "artifact.stored",
      "artifact.capture.truncated",
    ]);
    await expect(
      runtime.reader.read({
        artifactId: result.artifact!.artifactId,
        maxBytes: 64,
        offsetBytes: 0,
      }),
    ).resolves.toMatchObject({ content: "abc[r", eof: true });
  });

  it("does not allowlist an object when artifact.stored durability fails", async () => {
    const workspace = await temporaryWorkspace();
    const runtime = await ArtifactSessionRuntime.create({
      eventAppender: new RecordingAppender("artifact.stored"),
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "tool.call.requested",
        }),
      ],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const content = "orphan-object";
    const artifactId = `sha256:${createHash("sha256").update(content).digest("hex")}`;

    await expect(
      runtime.materialize({
        captureBytes: 128,
        modelObservationBytes: 128,
        originEventId: ORIGIN_EVENT_ID,
        source: chunks(content),
      }),
    ).rejects.toThrow("durable append failed");
    await expect(
      runtime.reader.read({ artifactId, maxBytes: 32, offsetBytes: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_not_allowlisted" }));
  });

  it("preserves exact markdown text behind a durable artifact event", async () => {
    const workspace = await temporaryWorkspace();
    const appender = new RecordingAppender();
    const runtime = await ArtifactSessionRuntime.create({
      eventAppender: appender,
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "repository.rules.loaded",
        }),
      ],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const bytes = Buffer.from("# Repository rules\n\nUse tests.\n", "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const reference = await runtime.materializeText({
      bytes,
      expectedSha256,
      mediaType: "text/markdown; charset=utf-8",
      originEventId: ORIGIN_EVENT_ID,
    });

    expect(appender.events).toEqual([
      {
        data: expect.objectContaining({
          artifact_id: `sha256:${expectedSha256}`,
          media_type: "text/markdown; charset=utf-8",
          origin_event_id: ORIGIN_EVENT_ID,
        }),
        type: "artifact.stored",
      },
    ]);
    await expect(
      runtime.reader.read({
        artifactId: reference.artifactId,
        maxBytes: 64,
        offsetBytes: 0,
      }),
    ).resolves.toMatchObject({
      content: "# Repository rules\n\nUse tests.\n",
      mediaType: "text/markdown; charset=utf-8",
    });
  });

  it("deduplicates identical plain and markdown captures without changing object identity", async () => {
    const workspace = await temporaryWorkspace();
    const appender = new RecordingAppender();
    const origin = replayEvent({
      eventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      sessionSeq: 1,
      type: "tool.call.requested",
    });
    const runtime = await ArtifactSessionRuntime.create({
      eventAppender: appender,
      events: [origin],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const bytes = Buffer.from("same text bytes", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const first = await runtime.materializeText({
      bytes,
      mediaType: "text/markdown; charset=utf-8",
      originEventId: ORIGIN_EVENT_ID,
    });
    const second = await runtime.materializeText({
      bytes,
      mediaType: "text/plain; charset=utf-8",
      originEventId: ORIGIN_EVENT_ID,
    });

    expect(second.artifactId).toBe(first.artifactId);
    await expect(
      runtime.reader.read({
        artifactId: first.artifactId,
        maxBytes: 64,
        offsetBytes: 0,
      }),
    ).resolves.toMatchObject({
      content: "same text bytes",
      mediaType: "text/plain; charset=utf-8",
    });
    const ledger = reconstructArtifactSessionLedger(
      [
        origin,
        ...appender.events.map((event, index) =>
          replayEvent({
            data: event.data,
            eventId: `30000000-0000-4000-8000-${String(80 + index).padStart(12, "0")}`,
            runId: RUN_ID,
            sessionSeq: index + 2,
            type: event.type,
          }),
        ),
      ],
      SESSION_ID,
    );
    expect(ledger.objects).toEqual([
      expect.objectContaining({
        artifactId: `sha256:${sha256}`,
        mediaTypes: [
          "text/markdown; charset=utf-8",
          "text/plain; charset=utf-8",
        ],
        referenceCount: 2,
      }),
    ]);
  });

  it("replays the session allowlist into read_artifact without exposing paths", async () => {
    const workspace = await temporaryWorkspace();
    const firstAppender = new RecordingAppender();
    const first = await ArtifactSessionRuntime.create({
      eventAppender: firstAppender,
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "tool.call.requested",
        }),
      ],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const materialized = await first.materialize({
      captureBytes: 128,
      modelObservationBytes: 128,
      originEventId: ORIGIN_EVENT_ID,
      source: chunks("replayed artifact"),
    });
    const persisted = firstAppender.events.map((event, index) =>
      replayEvent({
        data: event.data,
        eventId: `30000000-0000-4000-8000-${String(70 + index).padStart(12, "0")}`,
        runId: RUN_ID,
        sessionSeq: index + 2,
        type: event.type,
      }),
    );
    const resumed = await ArtifactSessionRuntime.create({
      eventAppender: new RecordingAppender(),
      events: [
        replayEvent({
          eventId: ORIGIN_EVENT_ID,
          runId: RUN_ID,
          sessionSeq: 1,
          type: "tool.call.requested",
        }),
        ...persisted,
      ],
      runId: OTHER_RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const registry = await createReadonlyToolRegistry(workspace, [], resumed);
    const execution = await registry.execute(
      {
        argumentsJson: JSON.stringify({
          artifact_id: materialized.artifact!.artifactId,
          max_bytes: 64,
          offset_bytes: 0,
        }),
        callId: "read_replayed_artifact",
        name: "read_artifact",
        step: 1,
      },
      new AbortController().signal,
    );

    expect(registry.artifactOutput).toBe(resumed);
    expect(registry.modelDefinitions.map(({ name }) => name)).toContain(
      "read_artifact",
    );
    expect(execution).toMatchObject({ ok: true });
    expect(execution.output).toContain("replayed artifact");
    expect(execution.output).not.toContain(workspace);
  });
});
