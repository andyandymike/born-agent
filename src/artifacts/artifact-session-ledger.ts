import {
  artifactCaptureTruncatedEventDataSchema,
  artifactStoredEventDataSchema,
} from "./artifact-event-schema.js";
import {
  DEFAULT_RUN_ARTIFACT_BYTES,
  DEFAULT_SESSION_ARTIFACT_BYTES,
  type ArtifactBudgetUsage,
  type ArtifactLedgerReference,
  type ArtifactStoredEventData,
} from "./artifact-types.js";

export interface ArtifactLedgerReplayEvent {
  readonly data: unknown;
  readonly eventId: string;
  readonly runId?: string;
  readonly scope: "run" | "session";
  readonly sessionId: string;
  readonly sessionSeq: number;
  readonly type: string;
}

export interface ArtifactStoredReferenceFact {
  readonly authorityState: "authorized" | "pending_origin";
  readonly artifactId: string;
  readonly bytes: number;
  readonly captureStatus: ArtifactStoredEventData["capture_status"];
  readonly captureTruncated: boolean;
  readonly eventId: string;
  readonly mediaType: ArtifactStoredEventData["media_type"];
  readonly objectRef: string;
  readonly originEventId: string;
  readonly runId: string;
  readonly sessionSeq: number;
  readonly sha256: string;
}

export interface ArtifactObjectFact {
  readonly authorizedReferenceCount: number;
  readonly artifactId: ArtifactLedgerReference["artifactId"];
  readonly bytes: number;
  readonly firstSessionSeq: number;
  readonly lastSessionSeq: number;
  readonly mediaTypes: readonly ArtifactStoredEventData["media_type"][];
  readonly objectRef: string;
  readonly referenceCount: number;
  readonly runIds: readonly string[];
  readonly sha256: string;
  readonly wasCaptureTruncated: boolean;
}

export interface ArtifactSessionLedgerProjection {
  readonly authorizedReferenceCount: number;
  readonly budgetUsage: ArtifactBudgetUsage;
  readonly objects: readonly ArtifactObjectFact[];
  readonly orphanedReferenceCount: number;
  readonly references: readonly ArtifactLedgerReference[];
  readonly sessionId: string;
  readonly storedReferenceCount: number;
  readonly storedReferences: readonly ArtifactStoredReferenceFact[];
  readonly truncatedCaptureEventCount: number;
  readonly uniqueObjectBytes: number;
}

export type ArtifactSessionLedgerErrorCode =
  | "artifact_budget_exceeded"
  | "artifact_event_invalid"
  | "artifact_event_sequence"
  | "artifact_identity_conflict"
  | "artifact_origin_invalid"
  | "artifact_origin_unknown"
  | "artifact_session_mismatch"
  | "artifact_truncation_invalid";

export class ArtifactSessionLedgerError extends Error {
  override readonly name = "ArtifactSessionLedgerError";

  constructor(
    readonly code: ArtifactSessionLedgerErrorCode,
    message: string,
    readonly sessionSeq: number,
  ) {
    super(`${message} at session_seq ${sessionSeq}`);
  }
}

interface MutableObjectFact {
  readonly authorizedMediaTypes: Set<ArtifactStoredEventData["media_type"]>;
  authorizedReferenceCount: number;
  readonly identity: Omit<ArtifactLedgerReference, "mediaType">;
  firstSessionSeq: number;
  lastSessionSeq: number;
  readonly mediaTypes: Set<ArtifactStoredEventData["media_type"]>;
  referenceCount: number;
  readonly runIds: Set<string>;
  wasCaptureTruncated: boolean;
}

function fail(
  event: ArtifactLedgerReplayEvent,
  code: ArtifactSessionLedgerErrorCode,
  message: string,
): never {
  throw new ArtifactSessionLedgerError(code, message, event.sessionSeq);
}

function canonicalRunId(event: ArtifactLedgerReplayEvent): string {
  if (
    event.scope !== "run" ||
    event.runId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      event.runId,
    )
  ) {
    fail(event, "artifact_event_invalid", "artifact event must be run-scoped");
  }
  return event.runId;
}

function truncationReasonForStatus(
  status: ArtifactStoredEventData["capture_status"],
): "artifact_limit" | "run_budget" | "session_budget" | undefined {
  switch (status) {
    case "complete":
      return undefined;
    case "truncated_artifact_limit":
      return "artifact_limit";
    case "truncated_run_budget":
      return "run_budget";
    case "truncated_session_budget":
      return "session_budget";
  }
}

function immutableReference(data: ArtifactStoredEventData): ArtifactLedgerReference {
  return Object.freeze({
    artifactId: data.artifact_id,
    bytes: data.bytes,
    mediaType: data.media_type,
    objectRef: data.object_ref,
    sha256: data.sha256,
  });
}

function hasArtifactOriginAuthority(
  event: ArtifactLedgerReplayEvent,
  runId: string,
  data: ArtifactStoredEventData,
  eventsById: ReadonlyMap<string, ArtifactLedgerReplayEvent>,
): boolean {
  const origin = eventsById.get(data.origin_event_id);
  if (origin === undefined) {
    // PHASE10: artifact.stored is durable before the forward repository-rules
    // event. A crash in that window leaves physical evidence, but never read
    // authority; replay keeps it as a budgeted orphan until a matching origin
    // is present in the same immutable session history.
    return false;
  }
  if (origin.scope !== "run" || origin.runId !== runId) {
    fail(
      event,
      "artifact_origin_invalid",
      "artifact origin event must belong to the same run",
    );
  }
  if (
    origin.type === "tool.call.requested" ||
    origin.type === "resume.pending_call.adopted" ||
    origin.type === "skill.activation.requested" ||
    origin.type === "hook.invocation.requested" ||
    origin.type === "mcp.resource.read.requested" ||
    origin.type === "mcp.prompt.get.requested"
  ) {
    if (origin.sessionSeq >= event.sessionSeq) {
      fail(
        event,
        "artifact_origin_invalid",
        "tool artifact origin must be durable before artifact capture",
      );
    }
    return true;
  }
  if (
    origin.type === "skill.resource.read" ||
    origin.type === "mcp.server.negotiated" ||
    origin.type === "mcp.resource.cataloged" ||
    origin.type === "mcp.prompt.cataloged"
  ) {
    const originData =
      origin.data !== null && typeof origin.data === "object" && !Array.isArray(origin.data)
        ? origin.data as Readonly<Record<string, unknown>>
        : {};
    const boundArtifactId = origin.type === "skill.resource.read"
      ? originData.content_artifact_id
      : origin.type === "mcp.server.negotiated"
        ? originData.instructions_artifact_id
        : originData.catalog_artifact_id;
    if (origin.sessionSeq <= event.sessionSeq || boundArtifactId !== data.artifact_id) {
      fail(
        event,
        "artifact_origin_invalid",
        "forward capability artifact must match its later binding event",
      );
    }
    return true;
  }
  if (origin.type === "patch.plan.created") {
    if (origin.sessionSeq >= event.sessionSeq) {
      fail(
        event,
        "artifact_origin_invalid",
        "patch-plan artifact origin must be durable before capture",
      );
    }
    return true;
  }
  if (origin.type === "run.started") {
    const originData =
      origin.data !== null &&
      typeof origin.data === "object" &&
      !Array.isArray(origin.data)
        ? (origin.data as Readonly<Record<string, unknown>>)
        : {};
    const capability =
      originData.capability_snapshot !== null &&
      typeof originData.capability_snapshot === "object" &&
      !Array.isArray(originData.capability_snapshot)
        ? (originData.capability_snapshot as Readonly<Record<string, unknown>>)
        : undefined;
    if (
      origin.sessionSeq >= event.sessionSeq ||
      capability === undefined ||
      capability.artifact_id !== data.artifact_id ||
      capability.bytes !== data.bytes ||
      capability.object_ref !== data.object_ref ||
      capability.sha256 !== data.sha256 ||
      data.media_type !== "text/plain; charset=utf-8"
    ) {
      fail(
        event,
        "artifact_origin_invalid",
        "capability snapshot artifact must exact-match its earlier run.started binding",
      );
    }
    return true;
  }
  if (origin.type === "repository.rules.loaded") {
    const originData =
      origin.data !== null &&
      typeof origin.data === "object" &&
      !Array.isArray(origin.data)
        ? (origin.data as Readonly<Record<string, unknown>>)
        : {};
    if (
      origin.sessionSeq <= event.sessionSeq ||
      originData.state !== "loaded" ||
      originData.artifact_id !== data.artifact_id ||
      originData.bytes !== data.bytes ||
      originData.content_sha256 !== data.sha256 ||
      originData.object_ref !== data.object_ref
    ) {
      fail(
        event,
        "artifact_origin_invalid",
        "repository-rules artifact must pair with its later loaded event",
      );
    }
    return true;
  }
  if (origin.type === "repository.rules.manifest.loaded") {
    const originData =
      origin.data !== null &&
      typeof origin.data === "object" &&
      !Array.isArray(origin.data)
        ? (origin.data as Readonly<Record<string, unknown>>)
        : {};
    const isManifestDescriptor = data.media_type === "text/plain; charset=utf-8";
    if (
      origin.sessionSeq <= event.sessionSeq ||
      (isManifestDescriptor &&
        (originData.manifest_artifact_id !== data.artifact_id ||
          originData.manifest_sha256 !== data.sha256 ||
          originData.manifest_object_ref !== data.object_ref)) ||
      (!isManifestDescriptor && data.media_type !== "text/markdown; charset=utf-8")
    ) {
      fail(
        event,
        "artifact_origin_invalid",
        "nested repository rule artifact does not match its frozen manifest origin",
      );
    }
    return true;
  }
  fail(
    event,
    "artifact_origin_invalid",
    "artifact origin type is not an allowed capture authority",
  );
}

function canonicalMediaType(
  values: ReadonlySet<ArtifactStoredEventData["media_type"]>,
): ArtifactStoredEventData["media_type"] {
  return values.has("text/plain; charset=utf-8")
    ? "text/plain; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

export function reconstructArtifactSessionLedger(
  events: readonly ArtifactLedgerReplayEvent[],
  expectedSessionId: string,
): ArtifactSessionLedgerProjection {
  const eventsById = new Map<string, ArtifactLedgerReplayEvent>();
  const seenEventIds = new Set<string>();
  const objects = new Map<string, MutableObjectFact>();
  const runBytes = new Map<string, number>();
  const lastStoredByRun = new Map<string, ArtifactStoredReferenceFact>();
  const storedReferences: ArtifactStoredReferenceFact[] = [];
  let authorizedReferenceCount = 0;
  let orphanedReferenceCount = 0;
  let previousSessionSeq = 0;
  let sessionBytes = 0;
  let truncatedCaptureEventCount = 0;

  for (const event of events) {
    if (event.sessionId !== expectedSessionId) {
      fail(
        event,
        "artifact_session_mismatch",
        "artifact ledger event belongs to a different session",
      );
    }
    if (
      !Number.isSafeInteger(event.sessionSeq) ||
      event.sessionSeq <= previousSessionSeq ||
      seenEventIds.has(event.eventId)
    ) {
      fail(
        event,
        "artifact_event_sequence",
        "artifact ledger input is not in unique session order",
      );
    }
    previousSessionSeq = event.sessionSeq;
    seenEventIds.add(event.eventId);
    eventsById.set(event.eventId, event);
  }

  for (const event of events) {
    if (event.type === "artifact.stored") {
      const runId = canonicalRunId(event);
      const parsed = artifactStoredEventDataSchema.safeParse(event.data);
      if (!parsed.success) {
        fail(
          event,
          "artifact_event_invalid",
          "artifact.stored data failed strict validation",
        );
      }
      const data = parsed.data;
      if (data.object_ref !== `artifacts/${expectedSessionId}/objects/${data.sha256}`) {
        fail(
          event,
          "artifact_session_mismatch",
          "artifact object reference does not belong to the event session",
        );
      }
      const hasAuthority = hasArtifactOriginAuthority(
        event,
        runId,
        data as ArtifactStoredEventData,
        eventsById,
      );
      const reference = immutableReference(data as ArtifactStoredEventData);
      const existing = objects.get(reference.artifactId);
      if (
        existing !== undefined &&
        (existing.identity.bytes !== reference.bytes ||
          existing.identity.objectRef !== reference.objectRef ||
          existing.identity.sha256 !== reference.sha256)
      ) {
        fail(
          event,
          "artifact_identity_conflict",
          "content-addressed artifact has conflicting intrinsic facts",
        );
      }

      sessionBytes += reference.bytes;
      const nextRunBytes = (runBytes.get(runId) ?? 0) + reference.bytes;
      if (
        !Number.isSafeInteger(sessionBytes) ||
        !Number.isSafeInteger(nextRunBytes) ||
        sessionBytes > DEFAULT_SESSION_ARTIFACT_BYTES ||
        nextRunBytes > DEFAULT_RUN_ARTIFACT_BYTES
      ) {
        fail(
          event,
          "artifact_budget_exceeded",
          "persisted artifact references exceed the session/run budget",
        );
      }
      runBytes.set(runId, nextRunBytes);

      const fact: ArtifactStoredReferenceFact = Object.freeze({
        authorityState: hasAuthority ? "authorized" : "pending_origin",
        artifactId: reference.artifactId,
        bytes: reference.bytes,
        captureStatus: data.capture_status,
        captureTruncated: data.capture_truncated,
        eventId: event.eventId,
        mediaType: reference.mediaType,
        objectRef: reference.objectRef,
        originEventId: data.origin_event_id,
        runId,
        sessionSeq: event.sessionSeq,
        sha256: reference.sha256,
      });
      storedReferences.push(fact);
      if (hasAuthority) {
        authorizedReferenceCount += 1;
      } else {
        orphanedReferenceCount += 1;
      }
      lastStoredByRun.set(runId, fact);
      if (existing === undefined) {
        objects.set(reference.artifactId, {
          authorizedMediaTypes: new Set(
            hasAuthority ? [reference.mediaType] : [],
          ),
          authorizedReferenceCount: hasAuthority ? 1 : 0,
          firstSessionSeq: event.sessionSeq,
          identity: {
            artifactId: reference.artifactId,
            bytes: reference.bytes,
            objectRef: reference.objectRef,
            sha256: reference.sha256,
          },
          lastSessionSeq: event.sessionSeq,
          mediaTypes: new Set([reference.mediaType]),
          referenceCount: 1,
          runIds: new Set([runId]),
          wasCaptureTruncated: data.capture_truncated,
        });
      } else {
        if (hasAuthority) {
          existing.authorizedMediaTypes.add(reference.mediaType);
          existing.authorizedReferenceCount += 1;
        }
        existing.lastSessionSeq = event.sessionSeq;
        existing.mediaTypes.add(reference.mediaType);
        existing.referenceCount += 1;
        existing.runIds.add(runId);
        existing.wasCaptureTruncated ||= data.capture_truncated;
      }
    } else if (event.type === "artifact.capture.truncated") {
      const runId = canonicalRunId(event);
      const parsed = artifactCaptureTruncatedEventDataSchema.safeParse(event.data);
      if (!parsed.success) {
        fail(
          event,
          "artifact_event_invalid",
          "artifact.capture.truncated data failed strict validation",
        );
      }
      const data = parsed.data;
      truncatedCaptureEventCount += 1;
      if (data.artifact_id === undefined) {
        if (data.captured_bytes !== 0 || data.limit_bytes !== 0) {
          fail(
            event,
            "artifact_truncation_invalid",
            "a truncation without an artifact must report zero captured/limit bytes",
          );
        }
      } else {
        const stored = lastStoredByRun.get(runId);
        if (
          stored === undefined ||
          stored.artifactId !== data.artifact_id ||
          stored.bytes !== data.captured_bytes ||
          truncationReasonForStatus(stored.captureStatus) !== data.reason
        ) {
          fail(
            event,
            "artifact_truncation_invalid",
            "truncation event does not match the preceding stored artifact fact",
          );
        }
      }
    }
  }

  const objectFacts = [...objects.values()].map(
    (fact): ArtifactObjectFact =>
      Object.freeze({
        ...fact.identity,
        authorizedReferenceCount: fact.authorizedReferenceCount,
        firstSessionSeq: fact.firstSessionSeq,
        lastSessionSeq: fact.lastSessionSeq,
        mediaTypes: Object.freeze([...fact.mediaTypes].sort()),
        referenceCount: fact.referenceCount,
        runIds: Object.freeze([...fact.runIds].sort()),
        wasCaptureTruncated: fact.wasCaptureTruncated,
      }),
  );
  return Object.freeze({
    authorizedReferenceCount,
    budgetUsage: Object.freeze({
      runBytes: Object.freeze(Object.fromEntries(runBytes)),
      sessionBytes,
    }),
    objects: Object.freeze(objectFacts),
    references: Object.freeze(
      [...objects.values()]
        .filter((fact) => fact.authorizedReferenceCount > 0)
        .map((fact) =>
          Object.freeze({
            artifactId: fact.identity.artifactId,
            bytes: fact.identity.bytes,
            mediaType: canonicalMediaType(fact.authorizedMediaTypes),
            objectRef: fact.identity.objectRef,
            sha256: fact.identity.sha256,
          }),
        ),
    ),
    orphanedReferenceCount,
    sessionId: expectedSessionId,
    storedReferenceCount: storedReferences.length,
    storedReferences: Object.freeze(storedReferences),
    truncatedCaptureEventCount,
    uniqueObjectBytes: objectFacts.reduce((sum, fact) => sum + fact.bytes, 0),
  });
}
