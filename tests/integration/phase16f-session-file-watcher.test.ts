import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionFileWatcher } from "../../src/tui/session-file-watcher.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

function deadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("session watch timed out")),
      2_000,
    );
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("Phase 16F session file watcher", () => {
  it("turns a real JSONL file change into a debounced invalidation signal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-session-watch-"));
    workspaces.push(workspace);
    const directory = join(workspace, ".bornagent", "sessions");
    const sessionPath = join(directory, `${SESSION_ID}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");

    const notices: Array<"lock" | "session"> = [];
    let resolveInitial!: () => void;
    let resolveChanged!: () => void;
    const initial = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const watcher = new SessionFileWatcher(workspace, { debounceMs: 5 });
    const stop = await watcher.watch(SESSION_ID, {
      onChange: (kind) => {
        notices.push(kind);
        if (notices.length === 1) resolveInitial();
        if (notices.length === 2) resolveChanged();
      },
      onError: (error) => {
        throw error;
      },
    });

    await deadline(initial);
    await appendFile(sessionPath, "{}\n", "utf8");
    await deadline(changed);
    expect(notices).toEqual(["session", "session"]);

    stop();
    stop();
  });
});
