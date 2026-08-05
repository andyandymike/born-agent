import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";

import { SessionPathPolicy } from "../sessions/session-path-policy.js";

export interface SessionFileWatchCallbacks {
  readonly onChange: (kind: SessionFileChangeKind) => void;
  readonly onError: (error: Error) => void;
}

export type SessionFileChangeKind = "lock" | "session";

export interface SessionFileWatcherOptions {
  readonly debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 25;

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("session file watcher failed", { cause: error });
}

/**
 * PHASE16: Watches only as an invalidation signal. The callback must perform a strict,
 * lock-protected session read; fs.watch bytes are never treated as facts.
 */
export class SessionFileWatcher {
  readonly #debounceMs: number;

  public constructor(
    private readonly workspace: string,
    options: SessionFileWatcherOptions = {},
  ) {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 1_000) {
      throw new TypeError("session watch debounce must be an integer from 0 to 1000");
    }
    this.#debounceMs = debounceMs;
  }

  public async watch(
    sessionId: string,
    callbacks: SessionFileWatchCallbacks,
  ): Promise<() => void> {
    const policy = await SessionPathPolicy.create(this.workspace);
    const paths = await policy.inspectExistingSession(sessionId);
    const lockName = basename(paths.lockFilePath);
    const sessionName = basename(paths.sessionFilePath);
    let closed = false;
    let pendingKind: SessionFileChangeKind | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher;

    const schedule = (kind: SessionFileChangeKind): void => {
      if (closed) return;
      pendingKind = pendingKind === "session" ? "session" : kind;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (closed) return;
        const current = pendingKind;
        pendingKind = null;
        if (current !== null) callbacks.onChange(current);
      }, this.#debounceMs);
      timer.unref?.();
    };

    try {
      watcher = watch(paths.sessionDirectory, { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === sessionName) {
          schedule("session");
        } else if (name.toString() === lockName) {
          schedule("lock");
        }
      });
    } catch (error) {
      throw asError(error);
    }

    const onWatcherError = (error: Error): void => {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        watcher.close();
      } catch {
        // The original watcher error is the useful diagnostic.
      }
      callbacks.onError(asError(error));
    };
    watcher.once("error", onWatcherError);

    // Close the load-before-watch race with one strict refresh after the OS
    // watch is installed. The controller serializes it with user operations.
    schedule("session");

    return () => {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      watcher.off("error", onWatcherError);
      watcher.close();
    };
  }
}
