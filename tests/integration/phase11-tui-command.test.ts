import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import type {
  PiTuiRenderer,
  PiTuiRendererOptions,
} from "../../src/tui/pi-tui-renderer.js";
import type { TuiViewState } from "../../src/tui/tui-view-state.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase11-tui-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function persistedTypes(root: string): Promise<readonly string[]> {
  const directory = join(root, ".bornagent", "sessions");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return (await readStoredSession(join(directory, files[0]!))).map(
    (event) => event.type,
  );
}

class AutoExitRenderer implements PiTuiRenderer {
  readonly start = vi.fn();
  readonly stop = vi.fn();
  private exitQueued = false;

  public constructor(
    private readonly onInput: PiTuiRendererOptions["onInput"],
  ) {}

  public update(view: TuiViewState): void {
    if (
      !this.exitQueued &&
      view.run !== null &&
      view.run.status !== "running"
    ) {
      this.exitQueued = true;
      queueMicrotask(() => this.onInput?.("\u0003"));
    }
  }
}

describe("Phase 11 born tui command boundary", () => {
  it("uses the same durable core event sequence as born agent with a zero-cost fake backend", async () => {
    const tuiWorkspace = await workspace();
    const cliWorkspace = await workspace();
    let renderer: AutoExitRenderer | undefined;
    const tuiRuntime = createRuntime({
      createSessionWriter: V2SessionWriter.create,
      cwd: tuiWorkspace,
      tuiHost: {
        createRenderer: (options) => {
          renderer = new AutoExitRenderer(options.onInput);
          return renderer;
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
    });
    const tuiMemory = createMemoryIO();
    const tuiExit = await runCli(
      ["tui", "answer locally", "--task-profile", "read-only"],
      tuiMemory.io,
      tuiRuntime,
    );

    const cliMemory = createMemoryIO();
    const cliExit = await runCli(
      ["agent", "answer locally", "--task-profile", "read-only"],
      cliMemory.io,
      createRuntime({
        createSessionWriter: V2SessionWriter.create,
        cwd: cliWorkspace,
      }),
    );

    expect(tuiExit).toBe(0);
    expect(cliExit).toBe(0);
    expect(renderer?.start).toHaveBeenCalledOnce();
    expect(renderer?.stop).toHaveBeenCalledOnce();
    expect(await persistedTypes(tuiWorkspace)).toEqual(
      await persistedTypes(cliWorkspace),
    );
  });
});
