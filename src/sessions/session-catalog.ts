import { lstat, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import {
  reconstructMultiRunSession,
  type ReconstructedMultiRunSession,
} from "./reconstruct-multi-run-session.js";
import { readStoredSession } from "./read-stored-session.js";
import { SessionLock, SessionLockError } from "./session-lock.js";
import {
  assertCanonicalSessionId,
  SessionPathPolicy,
} from "./session-path-policy.js";

const SESSION_FILE =
  /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/u;
export const MAX_SESSION_CATALOG_FILES = 2_000;

export type CatalogResumeStatus =
  | "canonical_confirmation_required"
  | "exact"
  | "message_required"
  | "not_resumable"
  | "pending_effect_blocked";

export interface SessionCatalogEntry {
  readonly changedCount: number;
  readonly error?: string;
  readonly lastTimestamp: string | null;
  readonly model: string | null;
  readonly path: string;
  readonly provider: string | null;
  readonly resumeStatus: CatalogResumeStatus;
  readonly sessionId: string;
  readonly status: string;
  readonly taskSummary: string;
}

export interface SessionCatalogResult {
  readonly diagnostics: {
    readonly bytes: number;
    readonly durationMs: number;
    readonly filesDiscovered: number;
    readonly filesScanned: number;
    readonly truncated: boolean;
  };
  readonly entries: readonly SessionCatalogEntry[];
}

export class SessionCatalogError extends Error {
  constructor(
    readonly code: "active_session_writer",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SessionCatalogError";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function lockFileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function safeSummary(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 117)}...`;
}

function lastBackend(events: readonly DecodedRunEvent[]) {
  return [...events].reverse().find((event) => event.type === "backend.selected");
}

function hasPendingEffect(events: readonly DecodedRunEvent[]): boolean {
  const pendingCommands = new Set<string>();
  const pendingPatches = new Set<string>();
  for (const event of events) {
    if (event.type === "command.execution.requested") {
      pendingCommands.add(event.data.execution_id);
    } else if (event.type === "command.completed") {
      pendingCommands.delete(event.data.execution_id);
    } else if (event.type === "patch.apply.started") {
      pendingPatches.add(event.data.plan_id);
    } else if (event.type === "patch.apply.completed") {
      pendingPatches.delete(event.data.plan_id);
    }
  }
  return pendingCommands.size > 0 || pendingPatches.size > 0;
}

function resumeStatus(session: ReconstructedMultiRunSession): CatalogResumeStatus {
  if (session.lastRun === null) return "not_resumable";
  if (hasPendingEffect(session.lastRun.events)) return "pending_effect_blocked";
  if (session.status === "completed") return "message_required";
  const capability = lastBackend(session.lastRun.events)?.data.resume_capability;
  if (capability === "exact_checkpoint") return "exact";
  if (capability === "canonical_only") {
    return "canonical_confirmation_required";
  }
  return "not_resumable";
}

function changedCount(session: ReconstructedMultiRunSession): number {
  const paths = new Set<string>();
  for (const run of session.runs) {
    for (const event of run.events) {
      if (event.type === "patch.apply.completed") {
        for (const file of event.data.files) paths.add(file.path);
      }
    }
  }
  return paths.size;
}

function entryFromProjection(
  path: string,
  session: ReconstructedMultiRunSession,
): SessionCatalogEntry {
  const last = session.events.at(-1);
  const activeGoal = session.taskState.goals.find(
    (goal) => goal.content.goalId === session.taskState.activeGoalId,
  );
  return {
    changedCount: changedCount(session),
    lastTimestamp: last?.timestamp ?? null,
    model: session.lastRun?.started.data.model ?? null,
    path,
    provider: session.lastRun?.started.data.provider ?? null,
    resumeStatus: resumeStatus(session),
    sessionId: session.sessionId,
    status: session.status,
    taskSummary: safeSummary(
      session.lastRun?.started.data.input.text ?? activeGoal?.content.objective ?? "",
    ),
  };
}

function errorEntry(path: string, sessionId: string, error: unknown): SessionCatalogEntry {
  return {
    changedCount: 0,
    error: error instanceof Error ? error.message : "unknown session read error",
    lastTimestamp: null,
    model: null,
    path,
    provider: null,
    resumeStatus: "not_resumable",
    sessionId,
    status: "invalid",
    taskSummary: "",
  };
}

export class SessionCatalog {
  constructor(private readonly workspace: string) {}

  async scan(limit = 50): Promise<SessionCatalogResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("session list limit must be between 1 and 200");
    }
    const started = performance.now();
    const policy = await SessionPathPolicy.create(this.workspace);
    let directory: string;
    try {
      directory = await policy.inspectSessionDirectory();
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return {
          diagnostics: {
            bytes: 0,
            durationMs: performance.now() - started,
            filesDiscovered: 0,
            filesScanned: 0,
            truncated: false,
          },
          entries: [],
        };
      }
      throw error;
    }
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => SESSION_FILE.test(name));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          diagnostics: {
            bytes: 0,
            durationMs: performance.now() - started,
            filesDiscovered: 0,
            filesScanned: 0,
            truncated: false,
          },
          entries: [],
        };
      }
      throw error;
    }
    names.sort();
    const selected = names.slice(0, MAX_SESSION_CATALOG_FILES);
    let bytes = 0;
    const entries: SessionCatalogEntry[] = [];
    for (const name of selected) {
      const match = SESSION_FILE.exec(name);
      const sessionId = match?.groups?.id;
      if (sessionId === undefined) continue;
      assertCanonicalSessionId(sessionId);
      const fallbackPath = `${directory}/${name}`;
      try {
        const paths = await policy.inspectExistingSession(sessionId);
        if (await lockFileExists(paths.lockFilePath)) {
          throw new SessionCatalogError(
            "active_session_writer",
            "session has an active or unresolved writer lock",
          );
        }
        const metadata = await lstat(paths.sessionFilePath);
        bytes += metadata.size;
        entries.push(
          entryFromProjection(
            paths.sessionFilePath,
            reconstructMultiRunSession(
              await readStoredSession(paths.sessionFilePath),
            ),
          ),
        );
      } catch (error) {
        entries.push(errorEntry(fallbackPath, sessionId, error));
      }
    }
    entries.sort((left, right) => {
      if (left.lastTimestamp === right.lastTimestamp) {
        return left.sessionId.localeCompare(right.sessionId);
      }
      if (left.lastTimestamp === null) return 1;
      if (right.lastTimestamp === null) return -1;
      return right.lastTimestamp.localeCompare(left.lastTimestamp);
    });
    return {
      diagnostics: {
        bytes,
        durationMs: performance.now() - started,
        filesDiscovered: names.length,
        filesScanned: selected.length,
        truncated: names.length > selected.length,
      },
      entries: entries.slice(0, limit),
    };
  }

  async read(sessionId: string): Promise<ReconstructedMultiRunSession> {
    assertCanonicalSessionId(sessionId);
    const policy = await SessionPathPolicy.create(this.workspace);
    const paths = await policy.inspectExistingSession(sessionId);
    let snapshotLock: SessionLock;
    try {
      // PHASE9: show takes the same exclusive sibling lock as the writer. A
      // preflight existence check alone has a TOCTOU window where a writer can
      // start before readFile; holding this lock makes the replay one stable
      // snapshot and refuses active, stale, or unprovable owners by default.
      snapshotLock = await SessionLock.acquire(policy, sessionId, {
        allowStaleRecovery: false,
      });
    } catch (error) {
      if (
        error instanceof SessionLockError &&
        error.code === "active_session_lock"
      ) {
        throw new SessionCatalogError(
          "active_session_writer",
          "session cannot be shown while its writer lock is present",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return reconstructMultiRunSession(
        await readStoredSession(paths.sessionFilePath),
      );
    } finally {
      await snapshotLock.release();
    }
  }
}
