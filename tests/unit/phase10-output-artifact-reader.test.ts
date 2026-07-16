import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactReader } from "../../src/artifacts/artifact-reader.js";
import { phase10ArtifactEventSchema } from "../../src/artifacts/artifact-event-schema.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import type {
  ArtifactLedgerReference,
  ArtifactStoredReference,
} from "../../src/artifacts/artifact-types.js";
import { OutputMaterializer } from "../../src/artifacts/output-materializer.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000011";
const RUN_ID = "20000000-0000-4000-8000-000000000011";
const ORIGIN_EVENT_ID = "30000000-0000-4000-8000-000000000011";
const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase10-materializer-"));
  temporaryDirectories.push(path);
  return path;
}

async function* chunks(
  ...values: readonly (string | Uint8Array)[]
): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield typeof value === "string" ? Buffer.from(value, "utf8") : value;
  }
}

function ledgerReference(
  artifact: ArtifactStoredReference,
): ArtifactLedgerReference {
  return {
    artifactId: artifact.artifactId,
    bytes: artifact.bytes,
    mediaType: artifact.mediaType,
    objectRef: artifact.objectRef,
    sha256: artifact.sha256,
  };
}

function objectPath(workspace: string, sha256: string): string {
  return join(
    workspace,
    ".bornagent",
    "artifacts",
    SESSION_ID,
    "objects",
    sha256,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 10 output materializer", () => {
  it("redacts and sanitizes the physical capture before storage", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const secret = "paid-provider-secret";
    const materializer = new OutputMaterializer(store, [secret]);
    const result = await materializer.materialize({
      captureBytes: 1024,
      modelObservationBytes: 12,
      originEventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      source: chunks(
        `before:${secret.slice(0, 8)}`,
        `${secret.slice(8)}\u001b[31m:after\rTAIL`,
      ),
    });

    expect(result.modelObservation).toBe("before:[reda");
    expect(result.modelObservationTruncated).toBe(true);
    expect(result.artifactEvent).toMatchObject({
      artifact_id: result.artifact?.artifactId,
      capture_status: "complete",
      capture_truncated: false,
      origin_event_id: ORIGIN_EVENT_ID,
    });
    expect(result.captureTruncatedEvent).toBeNull();
    expect(
      phase10ArtifactEventSchema.parse({
        data: result.artifactEvent,
        type: "artifact.stored",
      }),
    ).toEqual({ data: result.artifactEvent, type: "artifact.stored" });
    const verified = await store.readVerified(result.artifact!.artifactId);
    expect(verified.bytes.toString("utf8")).toBe(
      "before:[redacted]:after\nTAIL",
    );
    expect(verified.bytes.toString("utf8")).not.toContain(secret);
    expect(verified.bytes.toString("utf8")).not.toContain("\u001b");
    expect(JSON.stringify(result.artifactEvent)).not.toContain(secret);
  });

  it("backs off a truncated UTF-8 tail but rejects truly invalid UTF-8 and NUL", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const materializer = new OutputMaterializer(store);
    const bounded = await materializer.materialize({
      captureBytes: 4,
      modelObservationBytes: 4,
      originEventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      source: chunks("a😀z"),
    });

    expect(bounded).toMatchObject({
      artifact: {
        bytes: 1,
        captureStatus: "truncated_artifact_limit",
        captureTruncated: true,
      },
      captureTruncatedEvent: {
        captured_bytes: 1,
        limit_bytes: 4,
        reason: "artifact_limit",
      },
      modelObservation: "a",
      modelObservationTruncated: true,
    });
    expect(
      phase10ArtifactEventSchema.safeParse({
        data: bounded.captureTruncatedEvent,
        type: "artifact.capture.truncated",
      }).success,
    ).toBe(true);
    expect(
      phase10ArtifactEventSchema.safeParse({
        data: { ...bounded.artifactEvent, sha256: "f".repeat(64) },
        type: "artifact.stored",
      }).success,
    ).toBe(false);

    await expect(
      materializer.materialize({
        captureBytes: 32,
        modelObservationBytes: 32,
        originEventId: ORIGIN_EVENT_ID,
        runId: RUN_ID,
        source: chunks(Uint8Array.from([0xff, 0x61])),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "artifact_source_invalid_utf8" }),
    );
    await expect(
      materializer.materialize({
        captureBytes: 32,
        modelObservationBytes: 32,
        originEventId: ORIGIN_EVENT_ID,
        runId: RUN_ID,
        source: chunks(Uint8Array.from([0x61, 0, 0x62])),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_source_binary" }));
  });

  it("keeps collection bounded even for arbitrarily many tiny chunks", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({
      budgets: { perArtifactBytes: 5, perRunBytes: 10, perSessionBytes: 20 },
      sessionId: SESSION_ID,
      workspace,
    });
    const materializer = new OutputMaterializer(store);
    let pulls = 0;
    async function* source(): AsyncIterable<Uint8Array> {
      while (pulls < 1_000) {
        pulls += 1;
        yield Buffer.from("x");
      }
    }
    const result = await materializer.materialize({
      captureBytes: 5,
      modelObservationBytes: 5,
      originEventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      source: source(),
    });

    expect(pulls).toBe(6);
    expect(result).toMatchObject({
      artifact: { bytes: 5, captureTruncated: true },
      modelObservation: "xxxxx",
      modelObservationTruncated: true,
      physicalCaptureBytes: 5,
    });
  });
});

describe("Phase 10 artifact reader", () => {
  it("allows only ledger refs and returns slices on UTF-8 byte boundaries", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const materialized = await new OutputMaterializer(store).materialize({
      captureBytes: 128,
      modelObservationBytes: 128,
      originEventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      source: chunks("A😀BC\n"),
    });
    const reader = new ArtifactReader({
      references: [ledgerReference(materialized.artifact!)],
      sessionId: SESSION_ID,
      store,
    });

    await expect(
      reader.read({
        artifactId: materialized.artifact!.artifactId,
        maxBytes: 2,
        offsetBytes: 0,
      }),
    ).resolves.toMatchObject({
      content: "A",
      contentBytes: 1,
      eof: false,
      nextOffsetBytes: 1,
      offsetBytes: 0,
      sourceBytes: 1,
    });
    await expect(
      reader.read({
        artifactId: materialized.artifact!.artifactId,
        maxBytes: 4,
        offsetBytes: 1,
      }),
    ).resolves.toMatchObject({
      content: "😀",
      contentBytes: 4,
      nextOffsetBytes: 5,
      sourceBytes: 4,
    });
    await expect(
      reader.read({
        artifactId: materialized.artifact!.artifactId,
        maxBytes: 4,
        offsetBytes: 2,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "artifact_offset_not_utf8_boundary" }),
    );
    await expect(
      reader.read({
        artifactId: `sha256:${"f".repeat(64)}`,
        maxBytes: 4,
        offsetBytes: 0,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_not_allowlisted" }));
  });

  it("re-sanitizes/re-redacts and rejects binary text at the read boundary", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const unsafe = await store.storeSanitizedText({
      chunks: chunks("token=sk-12345678\u001b[31m!"),
      runId: RUN_ID,
    });
    const unsafeReference: ArtifactLedgerReference = {
      artifactId: unsafe.artifact!.artifactId,
      bytes: unsafe.artifact!.bytes,
      mediaType: "text/plain; charset=utf-8",
      objectRef: unsafe.artifact!.objectRef,
      sha256: unsafe.artifact!.sha256,
    };
    const reader = new ArtifactReader({
      references: [unsafeReference],
      sessionId: SESSION_ID,
      store,
    });
    const safe = await reader.read({
      artifactId: unsafe.artifact!.artifactId,
      maxBytes: 64,
      offsetBytes: 0,
    });
    expect(safe.content).toBe("token=[redacted]!");
    expect(safe.content).not.toContain("sk-12345678");
    expect(safe.content).not.toContain("\u001b");

    const binary = await store.storeSanitizedText({
      chunks: chunks(Uint8Array.from([0x61, 0, 0x62])),
      runId: RUN_ID,
    });
    const binaryReader = new ArtifactReader({
      references: [
        {
          artifactId: binary.artifact!.artifactId,
          bytes: binary.artifact!.bytes,
          mediaType: "text/plain; charset=utf-8",
          objectRef: binary.artifact!.objectRef,
          sha256: binary.artifact!.sha256,
        },
      ],
      sessionId: SESSION_ID,
      store,
    });
    await expect(
      binaryReader.read({
        artifactId: binary.artifact!.artifactId,
        maxBytes: 16,
        offsetBytes: 0,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_not_text" }));
  });

  it("re-verifies object and metadata on every read", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const materialized = await new OutputMaterializer(store).materialize({
      captureBytes: 128,
      modelObservationBytes: 128,
      originEventId: ORIGIN_EVENT_ID,
      runId: RUN_ID,
      source: chunks("verified-once"),
    });
    const reader = new ArtifactReader({
      references: [ledgerReference(materialized.artifact!)],
      sessionId: SESSION_ID,
      store,
    });
    await reader.read({
      artifactId: materialized.artifact!.artifactId,
      maxBytes: 128,
      offsetBytes: 0,
    });
    await writeFile(
      objectPath(workspace, materialized.artifact!.sha256),
      "tampered-bytes",
      "utf8",
    );
    await expect(
      reader.read({
        artifactId: materialized.artifact!.artifactId,
        maxBytes: 128,
        offsetBytes: 0,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "artifact_corrupt" }));
  });
});
