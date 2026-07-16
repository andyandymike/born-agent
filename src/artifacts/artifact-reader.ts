import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import { redactSensitiveText } from "../security/redact.js";
import { sanitizeTerminalText } from "./output-materializer.js";
import {
  ArtifactError,
  MAX_ARTIFACT_CAPTURE_BYTES,
  MAX_ARTIFACT_READ_BYTES,
  parseArtifactId,
  type ArtifactId,
  type ArtifactLedgerReference,
  type ArtifactMediaType,
} from "./artifact-types.js";
import type { ArtifactStore } from "./artifact-store.js";

export interface ArtifactReadRequest {
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly offsetBytes: number;
}

export interface ArtifactReadResult {
  readonly artifactId: ArtifactId;
  readonly content: string;
  readonly contentBytes: number;
  readonly eof: boolean;
  readonly mediaType: ArtifactMediaType;
  readonly nextOffsetBytes: number;
  readonly offsetBytes: number;
  readonly sha256: string;
  readonly sourceBytes: number;
}

export interface ArtifactReaderOptions {
  readonly references: readonly ArtifactLedgerReference[];
  readonly secrets?: readonly (string | undefined)[];
  readonly sessionId: string;
  readonly store: ArtifactStore;
}

function decodeBoundarySlice(
  bytes: Uint8Array,
  offset: number,
  maximumBytes: number,
): { readonly end: number; readonly text: string } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(bytes.subarray(0, offset));
  } catch (error) {
    throw new ArtifactError(
      "artifact_offset_not_utf8_boundary",
      "artifact offset must be on a UTF-8 code point boundary",
      { cause: error },
    );
  }
  let end = Math.min(bytes.byteLength, offset + maximumBytes);
  while (end >= offset) {
    try {
      return {
        end,
        text: decoder.decode(bytes.subarray(offset, end)),
      };
    } catch {
      end -= 1;
    }
  }
  throw new ArtifactError(
    "artifact_corrupt",
    "artifact text could not be decoded at a UTF-8 boundary",
  );
}

export class ArtifactReader {
  private readonly references = new Map<ArtifactId, ArtifactLedgerReference>();
  private readonly secrets: readonly (string | undefined)[];
  private readonly store: ArtifactStore;

  constructor(options: ArtifactReaderOptions) {
    assertCanonicalSessionId(options.sessionId);
    if (options.sessionId !== options.store.sessionId) {
      throw new ArtifactError(
        "artifact_not_allowlisted",
        "artifact reader session does not match its store",
      );
    }
    this.store = options.store;
    this.secrets = Object.freeze([...(options.secrets ?? [])]);
    for (const reference of options.references) {
      this.recordDurableReference(reference);
    }
  }

  recordDurableReference(reference: ArtifactLedgerReference): void {
    const parsed = parseArtifactId(reference.artifactId);
    if (
      parsed.sha256 !== reference.sha256 ||
      reference.objectRef !==
        `artifacts/${this.store.sessionId}/objects/${parsed.sha256}` ||
      (reference.mediaType !== "text/plain; charset=utf-8" &&
        reference.mediaType !== "text/markdown; charset=utf-8") ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 0 ||
      reference.bytes > MAX_ARTIFACT_CAPTURE_BYTES
    ) {
      throw new ArtifactError(
        "artifact_not_allowlisted",
        "artifact ledger reference is inconsistent",
      );
    }
    const existing = this.references.get(parsed.artifactId);
    if (
      existing !== undefined &&
      (existing.bytes !== reference.bytes ||
        existing.objectRef !== reference.objectRef ||
        existing.sha256 !== reference.sha256)
    ) {
      throw new ArtifactError(
        "artifact_not_allowlisted",
        "artifact ledger contains conflicting references",
      );
    }
    // PHASE10: callers may extend this allowlist only after artifact.stored is
    // durably appended. Merely having a valid hash/object on disk never grants
    // the model read authority for that content.
    // PHASE10: media type belongs to each artifact.stored reference, not the
    // content-addressed object. The ID-only read tool chooses a deterministic
    // text view when the same bytes were captured as both Markdown and plain
    // text; that must not turn valid deduplication into an identity conflict.
    this.references.set(
      parsed.artifactId,
      Object.freeze({
        ...reference,
        mediaType:
          existing?.mediaType === "text/plain; charset=utf-8" ||
          reference.mediaType === "text/plain; charset=utf-8"
            ? "text/plain; charset=utf-8"
            : "text/markdown; charset=utf-8",
      }),
    );
  }

  async read(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    const parsed = parseArtifactId(request.artifactId);
    if (
      !Number.isSafeInteger(request.offsetBytes) ||
      request.offsetBytes < 0 ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > MAX_ARTIFACT_READ_BYTES
    ) {
      throw new ArtifactError(
        "artifact_offset_invalid",
        "artifact offset/max bytes are outside the supported bounds",
      );
    }
    const reference = this.references.get(parsed.artifactId);
    if (reference === undefined) {
      throw new ArtifactError(
        "artifact_not_allowlisted",
        "artifact is not referenced by the current session ledger",
      );
    }
    if (
      reference.mediaType !== "text/plain; charset=utf-8" &&
      reference.mediaType !== "text/markdown; charset=utf-8"
    ) {
      throw new ArtifactError(
        "artifact_not_text",
        "binary artifacts are not readable in Phase 10",
      );
    }

    // PHASE10: the allowlist is authority only for identity, not integrity.
    // Every read revalidates object metadata, bytes and SHA-256 so a corrupt or
    // replaced object cannot silently become a new model observation.
    const verified = await this.store.readVerified(parsed.artifactId);
    if (
      verified.objectRef !== reference.objectRef ||
      verified.metadata.bytes !== reference.bytes ||
      verified.metadata.sha256 !== reference.sha256
    ) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact bytes no longer match the current-session ledger reference",
      );
    }
    let fullText: string;
    try {
      fullText = new TextDecoder("utf-8", { fatal: true }).decode(verified.bytes);
    } catch (error) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact content is not valid UTF-8",
        { cause: error },
      );
    }
    if (fullText.includes("\0")) {
      throw new ArtifactError(
        "artifact_not_text",
        "artifact contains binary NUL bytes",
      );
    }
    // Sanitize and redact the complete verified text before applying offsets.
    // This prevents a caller from placing a page boundary inside a newly known
    // secret or a terminal escape and observing a fragment that evades defense.
    const safeView = Buffer.from(
      redactSensitiveText(sanitizeTerminalText(fullText), this.secrets),
      "utf8",
    );
    if (safeView.byteLength > MAX_ARTIFACT_CAPTURE_BYTES) {
      throw new ArtifactError(
        "artifact_not_text",
        "artifact safety transformation exceeded the bounded text view",
      );
    }
    if (request.offsetBytes > safeView.byteLength) {
      throw new ArtifactError(
        "artifact_offset_invalid",
        "artifact offset exceeds content length",
      );
    }
    const slice = decodeBoundarySlice(
      safeView,
      request.offsetBytes,
      request.maxBytes,
    );
    return Object.freeze({
      artifactId: parsed.artifactId,
      content: slice.text,
      contentBytes: slice.end - request.offsetBytes,
      eof: slice.end === safeView.byteLength,
      mediaType: reference.mediaType,
      nextOffsetBytes: slice.end,
      offsetBytes: request.offsetBytes,
      sha256: parsed.sha256,
      sourceBytes: slice.end - request.offsetBytes,
    });
  }
}
