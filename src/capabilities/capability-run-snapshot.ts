import { canonicalJson } from "../completion/canonical-json.js";
import { artifactStoredEventDataSchema } from "../artifacts/artifact-event-schema.js";
import { reconstructArtifactSessionLedger } from "../artifacts/artifact-session-ledger.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ArtifactStoredEventData } from "../artifacts/artifact-types.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { CapabilityError } from "./capability-errors.js";
import {
  persistCapabilitySnapshotBinding,
} from "./capability-snapshot.js";
import type {
  CapabilitySnapshotV1,
  PersistedCapabilitySnapshotBindingV1,
} from "./capability-types.js";

export interface PreparedCapabilityRunSnapshot {
  readonly binding: PersistedCapabilitySnapshotBindingV1;
  readonly snapshot: CapabilitySnapshotV1;
}

export async function prepareCapabilityRunSnapshot(input: {
  readonly existingEvents: readonly DecodedStoredEvent[];
  readonly runId: string;
  readonly sessionId: string;
  readonly snapshot: CapabilitySnapshotV1;
  readonly workspace: string;
}): Promise<PreparedCapabilityRunSnapshot> {
  const bytes = Buffer.from(`${canonicalJson(input.snapshot)}\n`, "utf8");
  const usage = reconstructArtifactSessionLedger(
    input.existingEvents,
    input.sessionId,
  ).budgetUsage;
  const store = await ArtifactStore.create({
    initialUsage: usage,
    sessionId: input.sessionId,
    workspace: input.workspace,
  });
  const stored = await store.storeSanitizedText({
    chunks: [bytes],
    maximumBytes: bytes.byteLength,
    runId: input.runId,
  });
  if (
    stored.artifact === null ||
    stored.captureStatus !== "complete" ||
    stored.captureTruncated ||
    stored.artifact.bytes !== bytes.byteLength
  ) {
    throw new CapabilityError(
      "capability_artifact_integrity_failed",
      "capability snapshot artifact was not preserved exactly",
    );
  }
  const componentCount = input.snapshot.plugins.reduce(
    (total, plugin) => total + plugin.components.length,
    0,
  );
  const binding = persistCapabilitySnapshotBinding({
    artifact_id: stored.artifact.artifactId,
    bytes: stored.artifact.bytes,
    capability_schema_sha256: input.snapshot.capabilitySchemaSha256,
    component_count: componentCount,
    eligible_plugin_count: input.snapshot.plugins.length,
    enablement_revision: input.snapshot.enablementRevision,
    object_ref: stored.artifact.objectRef,
    schema_version: 1,
    sha256: stored.artifact.sha256,
    snapshot_id: input.snapshot.snapshotId,
    source_revisions: input.snapshot.sourceRevisions,
  });
  return Object.freeze({ binding, snapshot: input.snapshot });
}

export async function appendPreparedCapabilitySnapshotArtifact(input: {
  readonly originEventId: string;
  readonly prepared: PreparedCapabilityRunSnapshot;
  readonly runId: string;
  readonly writer: SessionWriter;
}): Promise<void> {
  if (
    input.writer.appendArtifactEvent === undefined &&
    input.writer.appendCapabilitySnapshotArtifact === undefined
  ) {
    throw new CapabilityError(
      "capability_artifact_integrity_failed",
      "session writer cannot persist capability snapshot artifact authority",
    );
  }
  const binding = input.prepared.binding;
  const data = artifactStoredEventDataSchema.parse({
    artifact_id: binding.artifact_id,
    bytes: binding.bytes,
    capture_status: "complete",
    capture_truncated: false,
    media_type: "text/plain; charset=utf-8",
    object_ref: binding.object_ref,
    origin_event_id: input.originEventId,
    sha256: binding.sha256,
  }) as ArtifactStoredEventData;
  const event = {
    data,
    type: "artifact.stored",
  } as const;
  if (input.writer.appendCapabilitySnapshotArtifact !== undefined) {
    await input.writer.appendCapabilitySnapshotArtifact(input.runId, event);
  } else {
    await input.writer.appendArtifactEvent!(input.runId, event);
  }
}
