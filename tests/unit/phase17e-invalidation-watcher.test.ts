import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RepositoryInvalidationWatcher,
  type RepositoryInvalidationWatchHandle,
  type RepositoryInvalidationWatchPort,
} from "../../src/repository-intelligence/repository-invalidation-watcher.js";

class FakeWatchPort implements RepositoryInvalidationWatchPort {
  closed = 0;
  event: ((eventType: "change" | "rename", filename: Buffer | string | null) => void) | null = null;
  error: ((error: Error) => void) | null = null;
  startError: Error | null = null;

  start(
    _root: string,
    onEvent: (eventType: "change" | "rename", filename: Buffer | string | null) => void,
    onError: (error: Error) => void,
  ): RepositoryInvalidationWatchHandle {
    if (this.startError !== null) throw this.startError;
    this.event = onEvent;
    this.error = onError;
    return { close: () => { this.closed += 1; } };
  }
}

const temporary: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase17e-watch-"));
  temporary.push(root);
  return root;
}

describe("Phase 17E repository invalidation watcher", () => {
  it("installs before emitting an initial unknown invalidation", async () => {
    vi.useFakeTimers();
    const port = new FakeWatchPort();
    const invalidations: unknown[] = [];
    const watcher = await RepositoryInvalidationWatcher.create(
      await workspace(),
      (value) => invalidations.push(value),
      { debounceMs: 50, port },
    );

    expect(watcher.start()).toBe("available");
    expect(port.event).not.toBeNull();
    expect(invalidations).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(invalidations).toEqual([{ kind: "unknown", relativePath: null }]);
    watcher.stop();
  });

  it("coalesces by unknown/rules/source/cache priority and ignores derived cache churn", async () => {
    vi.useFakeTimers();
    const port = new FakeWatchPort();
    const invalidations: unknown[] = [];
    const watcher = await RepositoryInvalidationWatcher.create(
      await workspace(),
      (value) => invalidations.push(value),
      { debounceMs: 10, port },
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(10);

    port.event!("change", ".bornagent/cache/repository-intelligence/v1/current.json");
    port.event!("change", "src/a.ts");
    port.event!("change", "packages/core/AGENTS.md");
    port.event!("change", "packages/ui/AGENTS.md");
    port.event!("change", ".bornagent/cache/repository-intelligence/v1/generations/dead/data");
    await vi.advanceTimersByTimeAsync(10);

    expect(invalidations).toEqual([
      { kind: "unknown", relativePath: null },
      { kind: "rules", relativePath: null },
    ]);
    watcher.stop();
  });

  it("maps rename/missing names to unknown, stops after watch error, and stops idempotently", async () => {
    vi.useFakeTimers();
    const port = new FakeWatchPort();
    const invalidations: unknown[] = [];
    const errors: string[] = [];
    const watcher = await RepositoryInvalidationWatcher.create(
      await workspace(),
      (value) => invalidations.push(value),
      { debounceMs: 0, onError: (error) => errors.push(error.message), port },
    );
    watcher.start();
    await vi.runAllTimersAsync();
    port.event!("rename", "src/a.ts");
    await vi.runAllTimersAsync();
    port.event!("change", null);
    await vi.runAllTimersAsync();
    port.error!(new Error("watch failed"));
    port.event!("change", "src/ignored.ts");
    await vi.runAllTimersAsync();
    watcher.stop();
    watcher.stop();

    expect(invalidations).toEqual([
      { kind: "unknown", relativePath: null },
      { kind: "unknown", relativePath: null },
      { kind: "unknown", relativePath: null },
    ]);
    expect(errors).toEqual(["watch failed"]);
    expect(port.closed).toBe(1);
  });

  it("degrades cleanly when recursive watch is unavailable", async () => {
    const port = new FakeWatchPort();
    port.startError = new Error("recursive watch unavailable");
    const errors: string[] = [];
    const watcher = await RepositoryInvalidationWatcher.create(
      await workspace(),
      () => undefined,
      { onError: (error) => errors.push(error.message), port },
    );

    expect(watcher.start()).toBe("unavailable");
    expect(errors).toEqual(["recursive watch unavailable"]);
    watcher.stop();
  });
});
