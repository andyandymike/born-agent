import { createHash } from "node:crypto";

import {
  artifactCaptureTruncatedEventDataSchema,
  artifactStoredEventDataSchema,
} from "./artifact-event-schema.js";
import { ArtifactReader } from "./artifact-reader.js";
import {
  reconstructArtifactSessionLedger,
  type ArtifactLedgerReplayEvent,
  type ArtifactSessionLedgerProjection,
} from "./artifact-session-ledger.js";
import {
  ArtifactStore,
  type ArtifactStoreOptions,
} from "./artifact-store.js";
import type {
  ArtifactMediaType,
  ArtifactCaptureTruncatedEventData,
  ArtifactStoredEventData,
  ArtifactStoredReference,
} from "./artifact-types.js";
import {
  ArtifactError,
  MAX_ARTIFACT_CAPTURE_BYTES,
} from "./artifact-types.js";
import {
  OutputMaterializer,
  type OutputMaterialization,
  type OutputMaterializerInput,
} from "./output-materializer.js";

export type ArtifactOutputMaterializationRequest = Omit<
  OutputMaterializerInput,
  "runId"
>;

export interface ArtifactOutputMaterializationPort {
  materialize(
    input: ArtifactOutputMaterializationRequest,
  ): Promise<OutputMaterialization>;
}

export interface ArtifactSessionRuntimeLike
  extends ArtifactOutputMaterializationPort {
  readonly reader: ArtifactReader;
  materializeText(
    input: ArtifactTextMaterializationRequest,
  ): Promise<ArtifactStoredReference>;
}

export interface ArtifactTextMaterializationRequest {
  readonly bytes: Uint8Array;
  readonly expectedSha256?: string;
  readonly mediaType: ArtifactMediaType;
  readonly originEventId: string;
}

export interface DurableArtifactEventAppender {
  // Resolution is the durability boundary. An adapter must not resolve from an
  // in-memory queue because the runtime grants read authority immediately after
  // artifact.stored succeeds.
  appendArtifactEvent(
    runId: string,
    event:
      | {
          readonly data: ArtifactStoredEventData;
          readonly type: "artifact.stored";
        }
      | {
          readonly data: ArtifactCaptureTruncatedEventData;
          readonly type: "artifact.capture.truncated";
        },
  ): Promise<unknown>;
}

export interface ArtifactSessionRuntimeOptions {
  readonly budgets?: ArtifactStoreOptions["budgets"];
  readonly events: readonly ArtifactLedgerReplayEvent[];
  readonly eventAppender: DurableArtifactEventAppender;
  readonly runId: string;
  readonly secrets?: readonly (string | undefined)[];
  readonly sessionId: string;
  readonly workspace: string;
}

export class ArtifactSessionRuntime implements ArtifactSessionRuntimeLike {
  readonly initialLedger: ArtifactSessionLedgerProjection;
  readonly reader: ArtifactReader;
  readonly store: ArtifactStore;
  private readonly eventAppender: DurableArtifactEventAppender;
  private readonly materializer: OutputMaterializer;
  private readonly runId: string;

  private constructor(
    options: ArtifactSessionRuntimeOptions,
    ledger: ArtifactSessionLedgerProjection,
    store: ArtifactStore,
  ) {
    this.eventAppender = options.eventAppender;
    this.initialLedger = ledger;
    this.materializer = new OutputMaterializer(store, options.secrets ?? []);
    this.reader = new ArtifactReader({
      references: ledger.references,
      secrets: options.secrets ?? [],
      sessionId: options.sessionId,
      store,
    });
    this.runId = options.runId;
    this.store = store;
  }

  static async create(
    options: ArtifactSessionRuntimeOptions,
  ): Promise<ArtifactSessionRuntime> {
    const ledger = reconstructArtifactSessionLedger(
      options.events,
      options.sessionId,
    );
    const store = await ArtifactStore.create({
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      initialUsage: ledger.budgetUsage,
      sessionId: options.sessionId,
      workspace: options.workspace,
    });
    return new ArtifactSessionRuntime(options, ledger, store);
  }

  async materialize(
    input: ArtifactOutputMaterializationRequest,
  ): Promise<OutputMaterialization> {
    const result = await this.materializer.materialize({
      ...input,
      captureBytes:
        input.captureBytes ?? this.store.budgets.perArtifactBytes,
      runId: this.runId,
    });
    if (result.artifact === null || result.artifactEvent === null) {
      if (result.artifact !== null || result.artifactEvent !== null) {
        throw new TypeError("artifact materializer returned a partial reference");
      }
      if (result.captureTruncatedEvent === null) {
        throw new TypeError(
          "artifact materializer omitted exhausted-capture evidence",
        );
      }
      const truncated = artifactCaptureTruncatedEventDataSchema.parse(
        result.captureTruncatedEvent,
      ) as ArtifactCaptureTruncatedEventData;
      await this.eventAppender.appendArtifactEvent(this.runId, {
        data: truncated,
        type: "artifact.capture.truncated",
      });
      return result;
    }

    const stored = artifactStoredEventDataSchema.parse(
      result.artifactEvent,
    ) as ArtifactStoredEventData;
    await this.eventAppender.appendArtifactEvent(this.runId, {
      data: stored,
      type: "artifact.stored",
    });
    // PHASE10: disk presence is not authority. Only the successful durable
    // append above lets this run/session reader admit the new content hash.
    this.reader.recordDurableReference({
      artifactId: result.artifact.artifactId,
      bytes: result.artifact.bytes,
      mediaType: result.artifact.mediaType,
      objectRef: result.artifact.objectRef,
      sha256: result.artifact.sha256,
    });

    if (result.captureTruncatedEvent !== null) {
      const truncated = artifactCaptureTruncatedEventDataSchema.parse(
        result.captureTruncatedEvent,
      ) as ArtifactCaptureTruncatedEventData;
      await this.eventAppender.appendArtifactEvent(this.runId, {
        data: truncated,
        type: "artifact.capture.truncated",
      });
    }
    return result;
  }

  async materializeText(
    input: ArtifactTextMaterializationRequest,
  ): Promise<ArtifactStoredReference> {
    if (
      input.mediaType !== "text/plain; charset=utf-8" &&
      input.mediaType !== "text/markdown; charset=utf-8"
    ) {
      throw new ArtifactError(
        "artifact_not_text",
        "artifact media type must be supported UTF-8 text",
      );
    }
    if (input.bytes.byteLength > MAX_ARTIFACT_CAPTURE_BYTES) {
      throw new ArtifactError(
        "artifact_limit_invalid",
        "text artifact exceeds the 16 MiB physical capture limit",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch (error) {
      throw new ArtifactError(
        "artifact_source_invalid_utf8",
        "text artifact must be valid UTF-8",
        { cause: error },
      );
    }
    if (text.includes("\0")) {
      throw new ArtifactError(
        "artifact_source_binary",
        "text artifact must not contain NUL bytes",
      );
    }
    const actualSha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (
      input.expectedSha256 !== undefined &&
      input.expectedSha256 !== actualSha256
    ) {
      throw new ArtifactError(
        "artifact_reference_invalid",
        "text artifact bytes do not match the expected content hash",
      );
    }
    const requestedBytes = Math.max(1, input.bytes.byteLength);
    if (
      this.store.availableCaptureBytes(this.runId, requestedBytes) <
      input.bytes.byteLength
    ) {
      throw new ArtifactError(
        "artifact_persist_failed",
        "artifact budget cannot preserve this text without truncation",
      );
    }
    const stored = await this.store.storeSanitizedText({
      chunks: [input.bytes],
      maximumBytes: requestedBytes,
      runId: this.runId,
    });
    if (
      stored.artifact === null ||
      stored.captureStatus !== "complete" ||
      stored.captureTruncated ||
      stored.artifact.sha256 !== actualSha256 ||
      stored.artifact.bytes !== input.bytes.byteLength
    ) {
      throw new ArtifactError(
        "artifact_persist_failed",
        "text artifact was not preserved exactly",
      );
    }
    const eventData = artifactStoredEventDataSchema.parse({
      artifact_id: stored.artifact.artifactId,
      bytes: stored.artifact.bytes,
      capture_status: "complete",
      capture_truncated: false,
      media_type: input.mediaType,
      object_ref: stored.artifact.objectRef,
      origin_event_id: input.originEventId,
      sha256: stored.artifact.sha256,
    }) as ArtifactStoredEventData;
    const durableEvent = await this.eventAppender.appendArtifactEvent(this.runId, {
      data: eventData,
      type: "artifact.stored",
    });
    const eventId =
      typeof durableEvent === "object" &&
      durableEvent !== null &&
      "eventId" in durableEvent &&
      typeof durableEvent.eventId === "string"
        ? durableEvent.eventId
        : undefined;
    const reference: ArtifactStoredReference = Object.freeze({
      artifactId: stored.artifact.artifactId,
      bytes: stored.artifact.bytes,
      captureStatus: "complete",
      captureTruncated: false,
      ...(eventId === undefined ? {} : { eventId }),
      mediaType: input.mediaType,
      objectRef: stored.artifact.objectRef,
      originEventId: input.originEventId,
      sha256: stored.artifact.sha256,
    });
    this.reader.recordDurableReference(reference);
    return reference;
  }
}
