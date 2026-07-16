import type {
  CompletionEvidence,
  CompletionState,
  FinishTaskInput,
  IncompleteEvidence,
  IncompleteReason,
} from "./completion-types.js";
import {
  persistedCompletionEvidenceSchema,
  type PersistedCompletionEvidence,
} from "./completion-evidence-schema.js";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableClone<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

export class EvidenceLedger {
  private readonly current: Readonly<CompletionEvidence | IncompleteEvidence>;

  private constructor(evidence: CompletionEvidence | IncompleteEvidence) {
    this.current = immutableClone(evidence);
  }

  static fromPersistedProjection(
    projection: PersistedCompletionEvidence,
  ): EvidenceLedger {
    // PHASE7: Parsing the exact completion.evidence payload rechecks both the
    // evidence hash and the deterministic report. A boolean reconstructable flag
    // can never manufacture a ledger from transient process state.
    const persisted = persistedCompletionEvidenceSchema.parse(projection);
    return new EvidenceLedger(persisted.evidence);
  }

  snapshot(): Readonly<CompletionEvidence | IncompleteEvidence> {
    return this.current;
  }
}

export function createIncompleteEvidence(
  state: CompletionState,
  candidate: FinishTaskInput,
  reason: IncompleteReason,
): Readonly<IncompleteEvidence> {
  return immutableClone({
    changedByRun: state.changedByRun,
    diffCheck: state.diffCheck,
    finalSnapshot: state.finalSnapshot,
    modelEvidence: state.modelEvidence,
    modelNarrative: candidate.summary,
    preExistingDirtyPaths: state.preExistingDirtyPaths,
    reason,
    runId: state.runId,
    sessionId: state.sessionId,
    verifications: state.verifications,
  });
}
