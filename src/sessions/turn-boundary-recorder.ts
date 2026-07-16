import { randomUUID } from "node:crypto";

import { CheckpointStore } from "../checkpoints/checkpoint-store.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  BackendContinuation,
  ModelBackend,
} from "../model/model-backend.js";
import { buildCanonicalTranscript } from "./canonical-transcript.js";
import type { SessionWriter } from "./jsonl-session-writer.js";
import { V2SessionWriter } from "./v2-session-writer.js";

export interface TurnBoundaryInput {
  readonly continuation: BackendContinuation;
  readonly pendingCall: boolean;
  readonly runId: string;
  readonly sessionId: string;
  readonly turn: number;
}

export type TurnBoundaryRecorder = (
  input: TurnBoundaryInput,
) => Promise<void>;

export interface TurnBoundaryRecorderOptions {
  readonly createCheckpointId?: () => string;
  readonly createCheckpointStore?: (
    workspace: string,
  ) => Promise<CheckpointStore>;
}

export function createTurnBoundaryRecorder(
  writer: SessionWriter,
  backend: ModelBackend,
  workspace: string,
  options: TurnBoundaryRecorderOptions = {},
): TurnBoundaryRecorder | undefined {
  if (!(writer instanceof V2SessionWriter) || backend.resume.capability === "none") {
    return undefined;
  }
  if (backend.resume.capability === "canonical_only") {
    return async (input) => {
      const transcriptSha256 = sha256Canonical(
        buildCanonicalTranscript(writer.events),
      );
      // PHASE9: canonical-only persistence records an explainable closed
      // transcript boundary. It never serializes or pretends to recreate the
      // provider-private continuation supplied alongside this call.
      await writer.appendRunEvent(
        input.runId,
        "backend.canonical_boundary.created",
        {
          pending_call: input.pendingCall,
          transcript_sha256: transcriptSha256,
          turn: input.turn,
        },
      );
    };
  }

  const exactResume = backend.resume;
  return async (input) => {
    const checkpointId = (options.createCheckpointId ?? randomUUID)();
    const store = await (
      options.createCheckpointStore ?? CheckpointStore.create
    )(workspace);
    const reference = await writer.withOwnedLock((lock) =>
      store.writeExact(
        {
          codec: exactResume.checkpointCodec,
          context: {
            checkpointId,
            runId: input.runId,
            sessionId: input.sessionId,
            turnNumber: input.turn,
          },
          continuation: input.continuation,
          identity: backend.identity,
        },
        lock,
      ),
    );
    await writer.appendRunEvent(input.runId, "backend.checkpoint.created", {
      adapter: reference.adapter,
      adapter_version: reference.adapterVersion,
      bytes: reference.bytes,
      checkpoint_id: reference.checkpointId,
      codec_version: reference.codecVersion,
      model: reference.model,
      provider: reference.provider,
      ref: reference.relativeRef,
      sha256: reference.sha256,
      turn: reference.turnNumber,
    });
  };
}
