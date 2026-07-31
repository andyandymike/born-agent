export interface RunCoordinatorSnapshot {
  readonly sessionId: string | null;
  readonly snapshotSeq: number | null;
}

export type RunCoordinatorState =
  | ({ readonly kind: "idle" } & RunCoordinatorSnapshot)
  | {
      readonly intentId: string;
      readonly kind: "starting";
      readonly sessionId: string | null;
    }
  | {
      readonly abort: AbortController;
      readonly kind: "running";
      readonly runId: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "cancelling";
      readonly runId: string;
      readonly sessionId: string;
    }
  | { readonly kind: "fatal"; readonly message: string };

export function initialRunCoordinatorState(
  snapshot: RunCoordinatorSnapshot = { sessionId: null, snapshotSeq: null },
): RunCoordinatorState {
  if ((snapshot.sessionId === null) !== (snapshot.snapshotSeq === null)) {
    throw new TypeError("idle coordinator snapshot binding is incomplete");
  }
  return Object.freeze({ kind: "idle", ...snapshot });
}

export function isRunCoordinatorActive(state: RunCoordinatorState): boolean {
  return (
    state.kind === "starting" ||
    state.kind === "running" ||
    state.kind === "cancelling"
  );
}
