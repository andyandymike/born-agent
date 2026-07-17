import { describe, expect, it } from "vitest";

import {
  TerminalLifecycle,
  withTerminalLifecycle,
} from "../../src/tui/terminal-lifecycle.js";
import type {
  CapturedTerminalMode,
  TerminalLifecyclePort,
} from "../../src/tui/terminal-lifecycle.js";

class VirtualTerminal implements TerminalLifecyclePort {
  readonly operations: string[] = [];
  throwAt: string | null = null;

  private record(operation: string): void {
    this.operations.push(operation);
    if (this.throwAt === operation) throw new Error(`virtual ${operation} failed`);
  }

  attachHandlers(): void {
    this.record("attach");
  }

  captureOriginalMode(): CapturedTerminalMode {
    this.record("capture");
    return { rawMode: false };
  }

  detachHandlers(): void {
    this.record("detach");
  }

  enableRawMode(): void {
    this.record("raw:on");
  }

  enterAlternateScreen(): void {
    this.record("alternate:on");
  }

  hideCursor(): void {
    this.record("cursor:hide");
  }

  leaveAlternateScreen(): void {
    this.record("alternate:off");
  }

  restoreCursor(): void {
    this.record("cursor:restore");
  }

  restoreRawMode(mode: CapturedTerminalMode): void {
    this.record(`raw:restore:${String(mode.rawMode)}`);
  }
}

describe("Phase 11 terminal lifecycle", () => {
  it("restores handler, raw mode, alternate screen, and cursor exactly once", () => {
    const terminal = new VirtualTerminal();
    const lifecycle = new TerminalLifecycle(terminal);

    lifecycle.start();
    lifecycle.restore();
    lifecycle.restore();

    expect(terminal.operations).toEqual([
      "capture",
      "alternate:on",
      "raw:on",
      "cursor:hide",
      "attach",
      "detach",
      "raw:restore:false",
      "alternate:off",
      "cursor:restore",
    ]);
  });

  it("cleans up a partially attached virtual terminal", () => {
    const terminal = new VirtualTerminal();
    terminal.throwAt = "attach";

    expect(() => new TerminalLifecycle(terminal).start()).toThrow(
      "virtual attach failed",
    );
    expect(terminal.operations).toEqual([
      "capture",
      "alternate:on",
      "raw:on",
      "cursor:hide",
      "attach",
      "detach",
      "raw:restore:false",
      "alternate:off",
      "cursor:restore",
    ]);
  });

  it("restores in finally after a renderer exception", async () => {
    const terminal = new VirtualTerminal();
    const lifecycle = new TerminalLifecycle(terminal);

    await expect(
      withTerminalLifecycle(lifecycle, async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(terminal.operations.slice(-4)).toEqual([
      "detach",
      "raw:restore:false",
      "alternate:off",
      "cursor:restore",
    ]);
  });
});
