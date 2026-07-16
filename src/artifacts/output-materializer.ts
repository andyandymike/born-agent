import { redactSensitiveText } from "../security/redact.js";
import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import {
  ArtifactError,
  DEFAULT_ARTIFACT_CAPTURE_BYTES,
  MAX_ARTIFACT_CAPTURE_BYTES,
  type ArtifactCaptureStatus,
  type ArtifactCaptureTruncatedEventData,
  type ArtifactStoredCaptureStatus,
  type ArtifactStoredEventData,
  type ArtifactStoredReference,
} from "./artifact-types.js";
import type { ArtifactStore } from "./artifact-store.js";

export type MaterializedOutputSource =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

export interface OutputMaterializerInput {
  readonly captureBytes?: number;
  readonly modelObservationBytes: number;
  readonly originEventId: string;
  readonly runId: string;
  readonly source: MaterializedOutputSource;
}

export interface OutputMaterialization {
  readonly artifact: ArtifactStoredReference | null;
  readonly artifactEvent: ArtifactStoredEventData | null;
  readonly captureTruncatedEvent: ArtifactCaptureTruncatedEventData | null;
  readonly modelObservation: string;
  readonly modelObservationTruncated: boolean;
  readonly physicalCaptureBytes: number;
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly bytes: number;
  readonly text: string;
  readonly truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) {
    return { bytes: encoded.byteLength, text: value, truncated: false };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maximumBytes;
  while (end > 0) {
    try {
      const text = decoder.decode(encoded.subarray(0, end));
      return { bytes: end, text, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { bytes: 0, text: "", truncated: true };
}

export function sanitizeTerminalText(value: string): string {
  let mode: "csi" | "escape" | "normal" | "osc" | "osc_escape" = "normal";
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (mode === "escape") {
      mode = character === "[" ? "csi" : character === "]" ? "osc" : "normal";
      continue;
    }
    if (mode === "csi") {
      if (code >= 0x40 && code <= 0x7e) mode = "normal";
      continue;
    }
    if (mode === "osc") {
      if (character === "\u0007") mode = "normal";
      else if (character === "\u001b") mode = "osc_escape";
      continue;
    }
    if (mode === "osc_escape") {
      mode = character === "\\" ? "normal" : "osc";
      continue;
    }
    if (character === "\u001b") {
      mode = "escape";
    } else if (character === "\r") {
      result += "\n";
    } else if (
      character === "\n" ||
      character === "\t" ||
      (code >= 0x20 &&
        !(code >= 0x7f && code <= 0x9f) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069))
    ) {
      result += character;
    }
  }
  return result;
}

async function collectBounded(
  source: MaterializedOutputSource,
  maximumBytes: number,
): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
  const bounded = Buffer.allocUnsafe(maximumBytes);
  let accepted = 0;
  let truncated = false;
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    const remaining = maximumBytes - accepted;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const selectedLength = Math.min(remaining, chunk.byteLength);
    bounded.set(chunk.subarray(0, selectedLength), accepted);
    accepted += selectedLength;
    if (selectedLength < chunk.byteLength) {
      truncated = true;
      break;
    }
  }
  return { bytes: bounded.subarray(0, accepted), truncated };
}

function trailingIncompleteUtf8Bytes(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let leadIndex = bytes.byteLength - 1;
  while (
    leadIndex >= 0 &&
    (bytes[leadIndex]! & 0xc0) === 0x80 &&
    bytes.byteLength - leadIndex <= 3
  ) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return 0;
  const lead = bytes[leadIndex]!;
  const present = bytes.byteLength - leadIndex;
  const expected =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  if (expected === 0 || present >= expected) return 0;
  for (let index = leadIndex + 1; index < bytes.byteLength; index += 1) {
    const value = bytes[index]!;
    if ((value & 0xc0) !== 0x80) return 0;
    if (index === leadIndex + 1) {
      if (lead === 0xe0 && value < 0xa0) return 0;
      if (lead === 0xed && value > 0x9f) return 0;
      if (lead === 0xf0 && value < 0x90) return 0;
      if (lead === 0xf4 && value > 0x8f) return 0;
    }
  }
  return present;
}

function decodeCollectedUtf8(
  bytes: Buffer,
  sourceTruncated: boolean,
): string {
  const trailing = sourceTruncated ? trailingIncompleteUtf8Bytes(bytes) : 0;
  const candidate =
    trailing === 0 ? bytes : bytes.subarray(0, bytes.byteLength - trailing);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
  } catch (error) {
    throw new ArtifactError(
      "artifact_source_invalid_utf8",
      "output is not valid UTF-8 text",
      { cause: error },
    );
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function truncationReason(
  store: ArtifactStore,
  runId: string,
  requested: number,
  available: number,
): {
  readonly eventReason: ArtifactCaptureTruncatedEventData["reason"];
  readonly status: Exclude<
    ArtifactStoredCaptureStatus,
    "complete"
  >;
} {
  const usage = store.usage();
  const sessionRemaining = store.budgets.perSessionBytes - usage.sessionBytes;
  const runRemaining =
    store.budgets.perRunBytes - (usage.runBytes[runId] ?? 0);
  if (sessionRemaining === available && sessionRemaining < requested) {
    return { eventReason: "session_budget", status: "truncated_session_budget" };
  }
  if (runRemaining === available && runRemaining < requested) {
    return { eventReason: "run_budget", status: "truncated_run_budget" };
  }
  return { eventReason: "artifact_limit", status: "truncated_artifact_limit" };
}

function truncationFromStatus(status: ArtifactCaptureStatus): {
  readonly eventReason: ArtifactCaptureTruncatedEventData["reason"];
  readonly status: Exclude<ArtifactStoredCaptureStatus, "complete">;
} {
  switch (status) {
    case "truncated_artifact_limit":
      return { eventReason: "artifact_limit", status };
    case "truncated_run_budget":
      return { eventReason: "run_budget", status };
    case "truncated_session_budget":
      return { eventReason: "session_budget", status };
    case "budget_exhausted":
    case "complete":
      throw new ArtifactError(
        "artifact_persist_failed",
        "stored artifact returned an inconsistent truncation status",
      );
  }
}

function storedCaptureStatus(
  status: ArtifactCaptureStatus,
): ArtifactStoredCaptureStatus {
  if (status === "budget_exhausted") {
    throw new ArtifactError(
      "artifact_persist_failed",
      "a persisted artifact cannot have exhausted capture status",
    );
  }
  return status;
}

export class OutputMaterializer {
  private readonly secrets: readonly (string | undefined)[];

  constructor(
    private readonly store: ArtifactStore,
    secrets: readonly (string | undefined)[] = [],
  ) {
    this.secrets = Object.freeze([...secrets]);
  }

  async materialize(input: OutputMaterializerInput): Promise<OutputMaterialization> {
    try {
      assertCanonicalSessionId(input.originEventId);
    } catch (error) {
      throw new ArtifactError(
        "artifact_reference_invalid",
        "artifact origin event id must be a canonical UUID",
        { cause: error },
      );
    }
    const captureBytes = input.captureBytes ?? DEFAULT_ARTIFACT_CAPTURE_BYTES;
    if (
      !Number.isSafeInteger(captureBytes) ||
      captureBytes < 1 ||
      captureBytes > MAX_ARTIFACT_CAPTURE_BYTES
    ) {
      throw new ArtifactError(
        "artifact_limit_invalid",
        "artifact capture limit must be between 1 byte and 16 MiB",
      );
    }
    if (
      !Number.isSafeInteger(input.modelObservationBytes) ||
      input.modelObservationBytes < 1 ||
      input.modelObservationBytes > MAX_ARTIFACT_CAPTURE_BYTES
    ) {
      throw new ArtifactError(
        "artifact_limit_invalid",
        "model observation limit must be between 1 byte and 16 MiB",
      );
    }
    const available = this.store.availableCaptureBytes(input.runId, captureBytes);
    const collected = await collectBounded(
      input.source,
      Math.max(available, input.modelObservationBytes),
    );
    if (collected.bytes.includes(0)) {
      throw new ArtifactError(
        "artifact_source_binary",
        "binary output is not eligible for Phase 10 text artifact capture",
      );
    }
    const decoded = decodeCollectedUtf8(collected.bytes, collected.truncated);
    // PHASE10: sanitation and secret redaction happen on the bounded physical
    // capture before the first byte reaches content-addressed storage. Dedupe
    // therefore can never preserve a raw terminal escape or captured secret.
    const safeText = redactSensitiveText(sanitizeTerminalText(decoded), this.secrets);
    const observation = truncateUtf8(safeText, input.modelObservationBytes);

    if (available === 0) {
      return Object.freeze({
        artifact: null,
        artifactEvent: null,
        captureTruncatedEvent: Object.freeze({
          captured_bytes: 0,
          limit_bytes: 0,
          reason: truncationReason(this.store, input.runId, captureBytes, 0)
            .eventReason,
        }),
        // PHASE10: this exact bounded value is the only model observation the
        // caller may persist as tool.call.completed.output. Artifact metadata
        // is additive evidence and never replaces what the model actually saw.
        modelObservation: observation.text,
        modelObservationTruncated: observation.truncated || collected.truncated,
        physicalCaptureBytes: 0,
      });
    }

    const physical = truncateUtf8(safeText, available);
    // Capture capacity is sampled before persistence. Once store accounting is
    // committed, recomputing the reason would compare against post-write budget
    // and could falsely label an artifact/run/session boundary.
    const capacityTruncation = truncationReason(
      this.store,
      input.runId,
      captureBytes,
      available,
    );
    const stored = await this.store.storeSanitizedText({
      chunks: oneChunk(Buffer.from(physical.text, "utf8")),
      maximumBytes: captureBytes,
      runId: input.runId,
    });
    if (stored.artifact === null) {
      throw new ArtifactError(
        "artifact_persist_failed",
        "artifact budget changed before capture could be persisted",
      );
    }
    const captureTruncated =
      collected.truncated || physical.truncated || stored.captureTruncated;
    const truncation = !captureTruncated
      ? undefined
      : stored.captureTruncated
        ? truncationFromStatus(stored.captureStatus)
        : capacityTruncation;
    const captureStatus =
      truncation?.status ?? storedCaptureStatus(stored.captureStatus);
    const artifact: ArtifactStoredReference = Object.freeze({
      artifactId: stored.artifact.artifactId,
      bytes: stored.artifact.bytes,
      captureStatus,
      captureTruncated,
      mediaType: "text/plain; charset=utf-8",
      objectRef: stored.artifact.objectRef,
      originEventId: input.originEventId,
      sha256: stored.artifact.sha256,
    });
    const artifactEvent: ArtifactStoredEventData = Object.freeze({
      artifact_id: artifact.artifactId,
      bytes: artifact.bytes,
      capture_status: artifact.captureStatus,
      capture_truncated: artifact.captureTruncated,
      media_type: artifact.mediaType,
      object_ref: artifact.objectRef,
      origin_event_id: artifact.originEventId,
      sha256: artifact.sha256,
    });
    const truncatedEvent =
      truncation === undefined
        ? null
        : Object.freeze({
            artifact_id: artifact.artifactId,
            captured_bytes: artifact.bytes,
            limit_bytes: available,
            reason: truncation.eventReason,
          });
    return Object.freeze({
      artifact,
      artifactEvent,
      captureTruncatedEvent: truncatedEvent,
      modelObservation: observation.text,
      modelObservationTruncated: observation.truncated || collected.truncated,
      physicalCaptureBytes: artifact.bytes,
    });
  }
}
