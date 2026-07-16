import type {
  BackendContinuation,
  BackendIdentity,
  ProviderId,
} from "./model-backend.js";

export type ResumeCapability =
  | "exact_checkpoint"
  | "canonical_only"
  | "none";

export interface BackendCheckpointCodec {
  readonly codecVersion: string;
  readonly provider: ProviderId;

  // PHASE9: exact continuation state can contain provider-private bytes and
  // reasoning signatures. Only an explicitly versioned backend codec may turn
  // that opaque state into an artifact; canonical-only backends must never
  // pretend a transcript is an exact checkpoint.
  encode(continuation: BackendContinuation): Promise<Uint8Array>;
  decode(
    bytes: Uint8Array,
    identity: BackendIdentity,
  ): Promise<BackendContinuation>;
}

export type BackendResumeDeclaration =
  | {
      readonly capability: "exact_checkpoint";
      readonly checkpointCodec: BackendCheckpointCodec;
      readonly supportsCanonicalDegradedResume: boolean;
    }
  | {
      readonly capability: "canonical_only";
      readonly supportsCanonicalDegradedResume: true;
    }
  | {
      readonly capability: "none";
      readonly supportsCanonicalDegradedResume: false;
    };

export class BackendCheckpointCompatibilityError extends Error {
  constructor(
    readonly code:
      | "checkpoint_codec_mismatch"
      | "checkpoint_model_mismatch"
      | "checkpoint_provider_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "BackendCheckpointCompatibilityError";
  }
}

export interface CheckpointBackendIdentity {
  readonly codecVersion: string;
  readonly model: string;
  readonly provider: ProviderId;
}

export function assertCheckpointBackendCompatibility(
  checkpoint: CheckpointBackendIdentity,
  current: BackendIdentity,
  codec: BackendCheckpointCodec,
): void {
  if (checkpoint.provider !== current.provider || codec.provider !== current.provider) {
    throw new BackendCheckpointCompatibilityError(
      "checkpoint_provider_mismatch",
      "checkpoint provider does not match the selected backend",
    );
  }
  if (checkpoint.model !== current.model) {
    throw new BackendCheckpointCompatibilityError(
      "checkpoint_model_mismatch",
      "checkpoint model does not match the selected backend",
    );
  }
  if (checkpoint.codecVersion !== codec.codecVersion) {
    throw new BackendCheckpointCompatibilityError(
      "checkpoint_codec_mismatch",
      "checkpoint codec version is not compatible with the selected backend",
    );
  }
}
