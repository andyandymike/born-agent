export const DEFAULT_ARTIFACT_CAPTURE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RUN_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SESSION_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_READ_BYTES = 64 * 1024;

export type ArtifactId = `sha256:${string}`;
export type ArtifactMediaType =
  | "text/markdown; charset=utf-8"
  | "text/plain; charset=utf-8";

export interface ArtifactObjectMetadata {
  readonly bytes: number;
  readonly schema_version: 1;
  readonly sha256: string;
}

export interface StoredArtifactObject {
  readonly artifactId: ArtifactId;
  readonly bytes: number;
  readonly deduplicated: boolean;
  readonly objectRef: string;
  readonly sha256: string;
}

export type ArtifactCaptureStatus =
  | "complete"
  | "truncated_artifact_limit"
  | "truncated_run_budget"
  | "truncated_session_budget"
  | "budget_exhausted";
export type ArtifactStoredCaptureStatus = Exclude<
  ArtifactCaptureStatus,
  "budget_exhausted"
>;

export interface ArtifactStoreCaptureResult {
  readonly artifact: StoredArtifactObject | null;
  readonly captureStatus: ArtifactCaptureStatus;
  readonly captureTruncated: boolean;
  readonly capturedBytes: number;
}

export interface ArtifactStoredReference {
  readonly artifactId: ArtifactId;
  readonly bytes: number;
  readonly captureStatus: ArtifactStoredCaptureStatus;
  readonly captureTruncated: boolean;
  readonly eventId?: string;
  readonly mediaType: ArtifactMediaType;
  readonly objectRef: string;
  readonly originEventId: string;
  readonly sha256: string;
}

export interface ArtifactLedgerReference {
  readonly artifactId: ArtifactId;
  readonly bytes: number;
  readonly mediaType: ArtifactMediaType;
  readonly objectRef: string;
  readonly sha256: string;
}

export interface ArtifactBudgets {
  readonly perArtifactBytes: number;
  readonly perRunBytes: number;
  readonly perSessionBytes: number;
}

export interface ArtifactBudgetUsage {
  readonly runBytes?: Readonly<Record<string, number>>;
  readonly sessionBytes?: number;
}

export interface ArtifactStoredEventData {
  readonly artifact_id: ArtifactId;
  readonly bytes: number;
  readonly capture_status: ArtifactStoredCaptureStatus;
  readonly capture_truncated: boolean;
  readonly media_type: ArtifactMediaType;
  readonly object_ref: string;
  readonly origin_event_id: string;
  readonly sha256: string;
}

export interface ArtifactCaptureTruncatedEventData {
  readonly artifact_id?: ArtifactId;
  readonly captured_bytes: number;
  readonly limit_bytes: number;
  readonly reason:
    | "artifact_limit"
    | "run_budget"
    | "session_budget";
}

export type Phase10ArtifactEvent =
  | {
      readonly data: ArtifactStoredEventData;
      readonly type: "artifact.stored";
    }
  | {
      readonly data: ArtifactCaptureTruncatedEventData;
      readonly type: "artifact.capture.truncated";
    };

export type ArtifactErrorCode =
  | "artifact_budget_invalid"
  | "artifact_corrupt"
  | "artifact_id_invalid"
  | "artifact_limit_invalid"
  | "artifact_metadata_corrupt"
  | "artifact_missing"
  | "artifact_not_allowlisted"
  | "artifact_not_text"
  | "artifact_offset_invalid"
  | "artifact_offset_not_utf8_boundary"
  | "artifact_path_unsafe"
  | "artifact_persist_failed"
  | "artifact_reference_invalid"
  | "artifact_source_binary"
  | "artifact_source_invalid_utf8";

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ArtifactError";
  }
}

export function parseArtifactId(value: string): {
  readonly artifactId: ArtifactId;
  readonly sha256: string;
} {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(value);
  if (match?.[1] === undefined) {
    throw new ArtifactError(
      "artifact_id_invalid",
      "artifact id must be sha256 followed by 64 lowercase hex characters",
    );
  }
  return { artifactId: value as ArtifactId, sha256: match[1] };
}
