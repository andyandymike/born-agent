import { z } from "zod";

import {
  idleBindingOf,
  parsePhase16UserIntent,
  type Phase16MutationIntent,
  type Phase16StartIntent,
  type Phase16UserIntent,
} from "./phase16-user-intent.js";
import {
  initialRunCoordinatorState,
  isRunCoordinatorActive,
  type RunCoordinatorSnapshot,
  type RunCoordinatorState,
} from "./run-coordinator-state.js";

const uuidSchema = z.string().uuid();

export type RunCoordinatorPortErrorCode =
  | "fatal_invariant"
  | "operation_failed"
  | "precondition_failed"
  | "session_busy"
  | "stale_snapshot";

export class RunCoordinatorPortError extends Error {
  override readonly name = "RunCoordinatorPortError";

  constructor(
    readonly code: RunCoordinatorPortErrorCode,
    message: string,
    readonly currentSnapshot?: RunCoordinatorSnapshot,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RunCoordinatorRunStarted {
  readonly runId: string;
  readonly sessionId: string;
}

export interface RunCoordinatorRunResult {
  readonly exitCode: number;
  readonly snapshot: RunCoordinatorSnapshot;
}

export interface RunCoordinatorPort {
  mutate(intent: Phase16MutationIntent): Promise<RunCoordinatorSnapshot>;
  refresh(sessionId: string | null): Promise<RunCoordinatorSnapshot>;
  start(
    intent: Phase16StartIntent,
    context: {
      readonly onStarted: (started: RunCoordinatorRunStarted) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<RunCoordinatorRunResult>;
}

export type RunCoordinatorDispatchResult =
  | { readonly status: "busy"; readonly draftRetained: boolean }
  | { readonly status: "cancel_requested" }
  | { readonly status: "exit_requested" }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "fatal"; readonly message: string }
  | { readonly status: "mode_selected"; readonly mode: "build" | "plan" }
  | { readonly status: "mutated"; readonly snapshot: RunCoordinatorSnapshot }
  | { readonly status: "refreshed"; readonly snapshot: RunCoordinatorSnapshot }
  | { readonly status: "run_finished"; readonly exitCode: number; readonly snapshot: RunCoordinatorSnapshot }
  | { readonly status: "selected"; readonly snapshot: RunCoordinatorSnapshot }
  | { readonly status: "stale"; readonly snapshot: RunCoordinatorSnapshot };

export interface RunCoordinatorOptions {
  readonly createIntentId: () => string;
  readonly port: RunCoordinatorPort;
  readonly snapshot?: RunCoordinatorSnapshot;
}

function isStartIntent(intent: Phase16UserIntent): intent is Phase16StartIntent {
  return (
    intent.type === "start_new_goal" ||
    intent.type === "start_run_without_message" ||
    intent.type === "submit_idle_message"
  );
}

function isMutationIntent(
  intent: Phase16UserIntent,
): intent is Phase16MutationIntent {
  return (
    intent.type === "abandon_goal" ||
    intent.type === "approve_plan" ||
    intent.type === "reject_plan" ||
    intent.type === "replace_plan_from_file" ||
    intent.type === "revise_goal"
  );
}

function sameSnapshot(
  left: RunCoordinatorSnapshot,
  right: RunCoordinatorSnapshot,
): boolean {
  return left.sessionId === right.sessionId && left.snapshotSeq === right.snapshotSeq;
}

function validateSnapshot(snapshot: RunCoordinatorSnapshot): RunCoordinatorSnapshot {
  if ((snapshot.sessionId === null) !== (snapshot.snapshotSeq === null)) {
    throw new RunCoordinatorPortError(
      "fatal_invariant",
      "coordinator port returned an incomplete snapshot binding",
    );
  }
  if (snapshot.sessionId !== null) {
    assertUuid(snapshot.sessionId, "coordinator port returned an invalid session id");
  }
  if (
    snapshot.snapshotSeq !== null &&
    (!Number.isSafeInteger(snapshot.snapshotSeq) || snapshot.snapshotSeq < 0)
  ) {
    throw new RunCoordinatorPortError(
      "fatal_invariant",
      "coordinator port returned an invalid session sequence",
    );
  }
  return Object.freeze({ ...snapshot });
}

function assertUuid(value: string, message: string): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new RunCoordinatorPortError("fatal_invariant", message);
  }
  return value;
}

function activeSessionId(state: RunCoordinatorState): string | null {
  return state.kind === "running" || state.kind === "cancelling"
    ? state.sessionId
    : null;
}

export class RunCoordinator {
  #activeAbort: AbortController | null = null;
  #lastIdleSnapshot: RunCoordinatorSnapshot;
  #state: RunCoordinatorState;

  constructor(private readonly options: RunCoordinatorOptions) {
    const initial = validateSnapshot(
      options.snapshot ?? { sessionId: null, snapshotSeq: null },
    );
    this.#lastIdleSnapshot = initial;
    this.#state = initialRunCoordinatorState(initial);
  }

  get state(): RunCoordinatorState {
    return this.#state;
  }

  async dispatch(rawIntent: Phase16UserIntent): Promise<RunCoordinatorDispatchResult> {
    let intent: Phase16UserIntent;
    try {
      intent = parsePhase16UserIntent(rawIntent);
    } catch {
      return {
        code: "intent_invalid",
        message: "Phase 16 user intent is invalid",
        status: "failed",
      };
    }

    if (intent.type === "cancel_active_run") return this.#cancel();
    if (isRunCoordinatorActive(this.#state)) {
      return { draftRetained: isStartIntent(intent), status: "busy" };
    }
    if (this.#state.kind === "fatal") {
      return { message: this.#state.message, status: "fatal" };
    }

    if (intent.type === "exit") return { status: "exit_requested" };
    if (intent.type === "set_agent_mode") {
      return { mode: intent.mode, status: "mode_selected" };
    }
    if (intent.type === "refresh_session") {
      return this.#refresh(this.#state.sessionId, "refreshed");
    }
    if (intent.type === "select_session") {
      return this.#refresh(intent.sessionId, "selected");
    }
    if (isMutationIntent(intent)) return this.#mutate(intent);
    return this.#start(intent);
  }

  #cancel(): RunCoordinatorDispatchResult {
    if (!isRunCoordinatorActive(this.#state) || this.#activeAbort === null) {
      return {
        code: "no_active_run",
        message: "there is no active run to cancel",
        status: "failed",
      };
    }
    this.#activeAbort.abort();
    if (this.#state.kind === "running") {
      this.#state = Object.freeze({
        kind: "cancelling",
        runId: this.#state.runId,
        sessionId: this.#state.sessionId,
      });
    }
    return { status: "cancel_requested" };
  }

  async #refresh(
    sessionId: string | null,
    status: "refreshed" | "selected",
  ): Promise<RunCoordinatorDispatchResult> {
    try {
      const snapshot = validateSnapshot(await this.options.port.refresh(sessionId));
      if (sessionId !== null && snapshot.sessionId !== sessionId) {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "refreshed snapshot belongs to another session",
        );
      }
      this.#setIdle(snapshot);
      return { snapshot, status };
    } catch (error) {
      return this.#operationFailure(error);
    }
  }

  async #mutate(
    intent: Phase16MutationIntent,
  ): Promise<RunCoordinatorDispatchResult> {
    const binding = idleBindingOf(intent);
    if (binding.sessionId === null || binding.expectedSessionSeq === null) {
      return this.#fatal("task mutation has no exact durable snapshot binding");
    }
    if (!sameSnapshot(this.#idleSnapshot(), {
      sessionId: binding.sessionId,
      snapshotSeq: binding.expectedSessionSeq,
    })) {
      return { snapshot: this.#idleSnapshot(), status: "stale" };
    }
    try {
      const snapshot = validateSnapshot(await this.options.port.mutate(intent));
      if (
        snapshot.sessionId !== binding.sessionId ||
        snapshot.snapshotSeq === null ||
        snapshot.snapshotSeq <= binding.expectedSessionSeq
      ) {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "successful task mutation returned no advanced durable snapshot",
        );
      }
      this.#setIdle(snapshot);
      return { snapshot, status: "mutated" };
    } catch (error) {
      return this.#operationFailure(error);
    }
  }

  async #start(intent: Phase16StartIntent): Promise<RunCoordinatorDispatchResult> {
    const binding = idleBindingOf(intent);
    if (!sameSnapshot(this.#idleSnapshot(), {
      sessionId: binding.sessionId,
      snapshotSeq: binding.expectedSessionSeq,
    })) {
      return { snapshot: this.#idleSnapshot(), status: "stale" };
    }

    let intentId: string;
    try {
      intentId = uuidSchema.parse(this.options.createIntentId());
    } catch {
      return this.#fatal("coordinator could not allocate a canonical intent id");
    }
    const abort = new AbortController();
    this.#activeAbort = abort;
    this.#state = Object.freeze({
      intentId,
      kind: "starting",
      sessionId: binding.sessionId,
    });
    let started = false;
    let startedIdentity: RunCoordinatorRunStarted | null = null;
    const onStarted = (value: RunCoordinatorRunStarted): void => {
      if (started || this.#state.kind !== "starting") {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "run start acknowledgement was duplicated or out of order",
        );
      }
      const sessionId = assertUuid(
        value.sessionId,
        "run start acknowledgement has an invalid session id",
      );
      const runId = assertUuid(
        value.runId,
        "run start acknowledgement has an invalid run id",
      );
      if (binding.sessionId !== null && binding.sessionId !== sessionId) {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "started run belongs to another session",
        );
      }
      started = true;
      startedIdentity = { runId, sessionId };
      this.#state = Object.freeze({ abort, kind: "running", runId, sessionId });
    };

    try {
      const result = await this.options.port.start(intent, {
        onStarted,
        signal: abort.signal,
      });
      if (!started) {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "coordinator port completed without a durable run start acknowledgement",
        );
      }
      const snapshot = validateSnapshot(result.snapshot);
      if (
        startedIdentity === null ||
        snapshot.sessionId !== activeSessionId(this.#state)
      ) {
        throw new RunCoordinatorPortError(
          "fatal_invariant",
          "terminal snapshot belongs to another session",
        );
      }
      this.#activeAbort = null;
      this.#setIdle(snapshot);
      return { exitCode: result.exitCode, snapshot, status: "run_finished" };
    } catch (error) {
      this.#activeAbort = null;
      return this.#operationFailure(error, started);
    }
  }

  #idleSnapshot(): RunCoordinatorSnapshot {
    if (this.#state.kind !== "idle") {
      throw new Error("coordinator is not idle");
    }
    return {
      sessionId: this.#state.sessionId,
      snapshotSeq: this.#state.snapshotSeq,
    };
  }

  #setIdle(snapshot: RunCoordinatorSnapshot): void {
    this.#lastIdleSnapshot = snapshot;
    this.#state = initialRunCoordinatorState(snapshot);
  }

  #operationFailure(
    error: unknown,
    runStarted = false,
  ): RunCoordinatorDispatchResult {
    if (error instanceof RunCoordinatorPortError) {
      if (error.code === "fatal_invariant") return this.#fatal(error.message);
      const current = error.currentSnapshot;
      if (current !== undefined) {
        try {
          const snapshot = validateSnapshot(current);
          this.#setIdle(snapshot);
          if (error.code === "stale_snapshot") {
            return { snapshot, status: "stale" };
          }
        } catch (snapshotError) {
          return this.#fatal(
            snapshotError instanceof Error
              ? snapshotError.message
              : "coordinator received an invalid failure snapshot",
          );
        }
      } else if (!runStarted) {
        this.#setIdle(this.#lastIdleSnapshot);
      } else {
        return this.#fatal(
          "a started run failed without a consistent terminal snapshot",
        );
      }
      return { code: error.code, message: error.message, status: "failed" };
    }
    if (!runStarted) {
      this.#setIdle(this.#lastIdleSnapshot);
      return {
        code: "operation_failed",
        message: "run coordinator port failed unexpectedly",
        status: "failed",
      };
    }
    return this.#fatal("a started run failed without a consistent terminal snapshot");
  }

  #fatal(message: string): RunCoordinatorDispatchResult {
    this.#activeAbort?.abort();
    this.#activeAbort = null;
    this.#state = Object.freeze({ kind: "fatal", message });
    return { message, status: "fatal" };
  }
}
