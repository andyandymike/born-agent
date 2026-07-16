import type {
  BackendContinuation,
  BackendIdentity,
  ProviderId,
} from "../model/model-backend.js";
import type { BackendCheckpointCodec } from "../model/backend-resume.js";

export type {
  BackendCheckpointCodec,
  ResumeCapability,
} from "../model/backend-resume.js";

export interface CheckpointWriteContext {
  readonly checkpointId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnNumber: number;
}

export interface StoredCheckpointRef extends CheckpointWriteContext {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly bytes: number;
  readonly codecVersion: string;
  readonly configFingerprint: string;
  readonly model: string;
  readonly provider: ProviderId;
  readonly relativeRef: string;
  readonly sha256: string;
}

// PHASE9: Provider-exact continuation may contain private reasoning signatures
// and tool state. A codec turns it into an opaque private artifact; a
// canonical-only backend must emit a transcript boundary instead of pretending
// those provider bytes can be reconstructed.
export interface ExactCheckpointWriteRequest {
  readonly codec: BackendCheckpointCodec;
  readonly context: CheckpointWriteContext;
  readonly continuation: BackendContinuation;
  readonly identity: BackendIdentity;
}

export interface ExactCheckpointReadRequest {
  readonly codec: BackendCheckpointCodec;
  readonly identity: BackendIdentity;
  readonly reference: StoredCheckpointRef;
}
