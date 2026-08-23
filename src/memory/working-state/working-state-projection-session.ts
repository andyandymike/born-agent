import {
  AgentContextRuntime,
  type AgentContextPlanningInput,
  type AgentContextProjectionResult,
  type AgentContextRuntimeOptions,
} from "../../context/agent-context-runtime.js";
import type { IncrementalContextProjectionObservationV1 } from "../../context/incremental-context-projector.js";
import type { ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import type { SessionLedgerHeadSigner } from "../../control-plane/session-ledger-head.js";
import type { TaskStateProjection } from "../../coordination/task-state-types.js";
import { buildWorkingStateSnapshotV1 } from "./working-state-builder.js";
import type {
  WorkingSnapshotPointerV1,
  WorkingStateSnapshotV1,
} from "./working-state-schema.js";
import type {
  WorkingStateStore,
  WorkingStateRebuildReasonV1,
} from "./working-state-store.js";

export interface WorkingStateProjectionSessionResultV1 {
  readonly observation: Readonly<{
    readonly mode: "cold" | "incremental";
    readonly projectionVersion: "agent-memory-working-context-v1";
    readonly sourceEventCount: number;
    readonly sourceEventsApplied: number;
  }>;
  readonly pointer: WorkingSnapshotPointerV1;
  readonly projection: AgentContextProjectionResult;
  readonly sidecarRebuildReason: WorkingStateRebuildReasonV1 | null;
  readonly snapshot: WorkingStateSnapshotV1;
}

/**
 * AM1's opt-in owner couples one process-local suffix cursor to the durable,
 * derived working sidecar. A new process may cold replay even when the sidecar
 * is valid; the sidecar never substitutes for exact session bytes. Once the
 * cursor is established, every publication binds its snapshot to the exact
 * source head re-read under the store's per-session writer lock.
 */
export class WorkingStateProjectionSession {
  private lastObservation: WorkingStateProjectionSessionResultV1["observation"] | null = null;
  private readonly runtime: AgentContextRuntime;

  constructor(private readonly options: Readonly<{
    readonly observation?: IncrementalContextProjectionObservationV1;
    readonly readLatestEvidence: () => Promise<ExactSessionEvidenceV1>;
    readonly runtime: Omit<AgentContextRuntimeOptions, "workingState">;
    readonly signer: SessionLedgerHeadSigner;
    readonly store: WorkingStateStore;
  }>) {
    this.runtime = new AgentContextRuntime({
      ...options.runtime,
      workingState: {
        mode: "working",
        observation: {
          onProjection: (value) => {
            this.lastObservation = value;
            options.observation?.onProjection?.(value);
          },
        },
      },
    });
  }

  async projectAndPublish(input: Readonly<{
    readonly evidence: ExactSessionEvidenceV1;
    readonly planning: Omit<AgentContextPlanningInput, "events">;
    readonly taskState: TaskStateProjection;
  }>): Promise<WorkingStateProjectionSessionResultV1> {
    if (input.evidence.sessionId !== this.options.store.sessionId) {
      throw new TypeError("working projection evidence belongs to another session");
    }
    const sidecar = await this.options.store.readCurrent({
      evidence: input.evidence,
      signer: this.options.signer,
    });
    this.lastObservation = null;
    const projection = this.runtime.project({
      ...input.planning,
      events: input.evidence.events,
    });
    const observation = this.lastObservation;
    if (observation === null) {
      throw new TypeError("working projection emitted no work observation");
    }
    const snapshot = buildWorkingStateSnapshotV1({
      context: projection.state,
      evidence: input.evidence,
      signer: this.options.signer,
      taskState: input.taskState,
    });
    const pointer = await this.options.store.publish({
      readSourceHead: async () => {
        const latest = await this.options.readLatestEvidence();
        return latest.headAt(latest.events, this.options.signer);
      },
      snapshot,
    });
    return Object.freeze({
      observation,
      pointer,
      projection,
      sidecarRebuildReason: sidecar.rebuildReason,
      snapshot,
    });
  }
}
