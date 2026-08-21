import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { DEFAULT_IGNORED_DIRECTORY_NAMES } from "./source-inventory-policy.js";
import {
  repositoryCacheCurrentRelativePath,
  repositoryCacheIndexLockRelativePath,
} from "./repository-cache-version.js";

export interface RepositoryInvalidation {
  readonly kind: "cache" | "rules" | "source" | "unknown";
  readonly relativePath: string | null;
}

export interface RepositoryInvalidationWatchPort {
  start(
    root: string,
    onEvent: (eventType: "change" | "rename", filename: Buffer | string | null) => void,
    onError: (error: Error) => void,
  ): RepositoryInvalidationWatchHandle;
}

export interface RepositoryInvalidationWatchHandle {
  close(): void;
}

export interface RepositoryInvalidationWatcherOptions {
  readonly debounceMs?: number;
  readonly onError?: (error: Error) => void;
  readonly port?: RepositoryInvalidationWatchPort;
}

const PRIORITY: Readonly<Record<RepositoryInvalidation["kind"], number>> = Object.freeze({
  cache: 1,
  rules: 3,
  source: 2,
  unknown: 4,
});
const ignoredDirectories = new Set<string>(DEFAULT_IGNORED_DIRECTORY_NAMES);
const cacheAuthorityPaths = new Set<string>([
  // The selected production paths drive live invalidation. v1 remains
  // classified as cache churn for old-binary compatibility during rollback.
  repositoryCacheCurrentRelativePath(),
  repositoryCacheIndexLockRelativePath(),
  repositoryCacheCurrentRelativePath("v1"),
  repositoryCacheIndexLockRelativePath("v1"),
]);

class NodeRepositoryInvalidationWatchPort implements RepositoryInvalidationWatchPort {
  start(
    root: string,
    onEvent: (eventType: "change" | "rename", filename: Buffer | string | null) => void,
    onError: (error: Error) => void,
  ): FSWatcher {
    const watcher = watch(
      root,
      { encoding: "buffer", persistent: false, recursive: true },
      (eventType, filename) => onEvent(eventType, filename),
    );
    watcher.on("error", onError);
    return watcher;
  }
}

function canonicalRelativePath(value: Buffer | string | null): string | null {
  if (value === null) return null;
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
  const normalized = text.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return normalized;
}

function classify(eventType: "change" | "rename", filename: Buffer | string | null): RepositoryInvalidation | null {
  // PHASE17: platform watch bytes are only invalidation hints. Rename, overflow-like
  // missing names, and malformed paths force a later full authoritative rescan.
  const relativePath = canonicalRelativePath(filename);
  if (relativePath !== null && cacheAuthorityPaths.has(relativePath)) {
    // Atomic publication commonly reports a rename for these exact internal
    // paths. Preserve the cache classification so the coordinator can verify
    // the authoritative pointer instead of invalidating its own generation.
    return Object.freeze({ kind: "cache", relativePath });
  }
  if (eventType === "rename" || relativePath === null) {
    return Object.freeze({ kind: "unknown", relativePath: null });
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => ignoredDirectories.has(part))) return null;
  if (parts.at(-1) === "AGENTS.md") {
    return Object.freeze({ kind: "rules", relativePath });
  }
  return Object.freeze({ kind: "source", relativePath });
}

export class RepositoryInvalidationWatcher {
  private handle: RepositoryInvalidationWatchHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: RepositoryInvalidation | null = null;
  private stopped = false;

  private constructor(
    private readonly workspace: string,
    private readonly onInvalidation: (invalidation: RepositoryInvalidation) => void,
    private readonly debounceMs: number,
    private readonly port: RepositoryInvalidationWatchPort,
    private readonly onError: ((error: Error) => void) | undefined,
  ) {}

  static async create(
    workspace: string,
    onInvalidation: (invalidation: RepositoryInvalidation) => void,
    options: RepositoryInvalidationWatcherOptions = {},
  ): Promise<RepositoryInvalidationWatcher> {
    const debounceMs = options.debounceMs ?? 50;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 1_000) {
      throw new RangeError("repository watcher debounce must be from 0 to 1000 milliseconds");
    }
    const resolved = resolve(workspace);
    const requestedMetadata = await lstat(resolved);
    if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
      throw new Error("repository watcher workspace must be a plain directory");
    }
    const canonical = await realpath(resolved);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("repository watcher workspace must be a canonical plain directory");
    }
    return new RepositoryInvalidationWatcher(
      canonical,
      onInvalidation,
      debounceMs,
      options.port ?? new NodeRepositoryInvalidationWatchPort(),
      options.onError,
    );
  }

  start(): "available" | "unavailable" {
    if (this.stopped) throw new Error("repository watcher has already stopped");
    if (this.handle !== null) return "available";
    try {
      this.handle = this.port.start(
        this.workspace,
        (eventType, filename) => {
          if (this.stopped) return;
          const invalidation = classify(eventType, filename);
          if (invalidation !== null) this.enqueue(invalidation);
        },
        (error) => this.fail(error),
      );
      // PHASE17: installation precedes the initial unknown hint, closing the
      // load-before-watch race without treating watcher bytes as source facts.
      this.enqueue(Object.freeze({ kind: "unknown", relativePath: null }));
      return "available";
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("repository watch unavailable"));
      return "unavailable";
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.handle?.close();
    this.handle = null;
  }

  private enqueue(invalidation: RepositoryInvalidation): void {
    if (this.stopped) return;
    if (this.pending === null || PRIORITY[invalidation.kind] > PRIORITY[this.pending.kind]) {
      this.pending = invalidation;
    } else if (
      PRIORITY[invalidation.kind] === PRIORITY[this.pending.kind] &&
      invalidation.relativePath !== this.pending.relativePath
    ) {
      this.pending = Object.freeze({ kind: invalidation.kind, relativePath: null });
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = null;
      if (!this.stopped && pending !== null) this.onInvalidation(pending);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.handle?.close();
    this.handle = null;
    this.onError?.(error);
  }
}
