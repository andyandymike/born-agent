import {
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { BornAgentViewComponent } from "../../src/tui/components/bornagent-view.js";
import {
  createPiTuiRenderer,
  type PiTuiInputListenerResult,
  type PiTuiSurface,
} from "../../src/tui/pi-tui-renderer.js";
import {
  createInitialTuiEphemeralState,
  type TuiEphemeralState,
} from "../../src/tui/tui-ephemeral-state.js";
import {
  createInitialTuiViewState,
  type TuiViewState,
} from "../../src/tui/tui-view-state.js";

class RecordingSurface implements PiTuiSurface {
  component: Component | null = null;
  listener: ((data: string) => PiTuiInputListenerResult) | null = null;
  readonly calls: string[] = [];

  addChild(component: Component): void {
    this.calls.push("addChild");
    this.component = component;
  }

  addInputListener(
    listener: (data: string) => PiTuiInputListenerResult,
  ): () => void {
    this.calls.push("addInputListener");
    this.listener = listener;
    return () => {
      this.calls.push("removeInputListener");
      this.listener = null;
    };
  }

  removeChild(component: Component): void {
    expect(component).toBe(this.component);
    this.calls.push("removeChild");
    this.component = null;
  }

  requestRender(): void {
    this.calls.push("requestRender");
  }

  start(): void {
    this.calls.push("start");
  }

  stop(): void {
    this.calls.push("stop");
  }
}

class RecordingTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly calls: string[] = [];

  start(): void {
    this.calls.push("start");
  }

  stop(): void {
    this.calls.push("stop");
  }

  drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this.calls.push(`write:${JSON.stringify(data)}`);
  }

  moveBy(lines: number): void {
    this.calls.push(`moveBy:${lines}`);
  }

  hideCursor(): void {
    this.calls.push("hideCursor");
  }

  showCursor(): void {
    this.calls.push("showCursor");
  }

  clearLine(): void {
    this.calls.push("clearLine");
  }

  clearFromCursor(): void {
    this.calls.push("clearFromCursor");
  }

  clearScreen(): void {
    this.calls.push("clearScreen");
  }

  setTitle(title: string): void {
    this.calls.push(`setTitle:${title}`);
  }

  setProgress(active: boolean): void {
    this.calls.push(`setProgress:${active}`);
  }
}

function populatedView(): TuiViewState {
  return {
    ...createInitialTuiViewState(),
    approval: {
      actionKind: "run_command",
      actionSha256: "action",
      callId: "call-1",
      decision: null,
      expiresState: { status: "active" },
      preview: "echo safe\u001b]0;owned-title\u0007",
      previewSha256: "preview",
      previewTruncated: false,
      requestId: "approval-1",
      runId: "run-1",
      sessionId: "session-1",
    },
    run: {
      acceptedCompletionCallId: null,
      acceptedCompletionStep: null,
      command: "agent",
      completionProof: "none",
      currentStep: 1,
      id: "run-1",
      model: "mock-model",
      provider: "fake\u001b[2J",
      runExitCode: null,
      status: "running",
      taskProfile: "coding",
      workspace: "D:/workspace",
    },
    session: {
      actionBlocked: false,
      fatalReason: null,
      id: "session-1",
      lastSessionSeq: 7,
      resumeBlocked: false,
    },
    transcript: [
      {
        callId: "call-1",
        id: "tool-1",
        kind: "tool",
        output: "secret-value\u001b]52;c;YQ==\u0007",
        runId: "run-1",
        status: "success",
        toolName: "read_file",
        truncated: false,
      },
      {
        addedLines: 2,
        id: "patch-1",
        kind: "patch",
        planId: "plan-1",
        preview: "+ safe",
        removedLines: 1,
        runId: "run-1",
        status: "awaiting_approval",
        truncated: false,
      },
      {
        artifactId: null,
        bytes: 12,
        executionId: "exec-1",
        id: "command-1",
        kind: "command",
        output: "ok",
        runId: "run-1",
        status: "completed",
        termination: "exit_code",
        truncated: false,
      },
      {
        generation: 2,
        id: "verification-1",
        kind: "verification",
        runId: "run-1",
        stale: false,
        status: "passed",
        verificationId: "verify-1",
      },
    ],
  };
}

function ephemeral(
  overrides: Partial<TuiEphemeralState> = {},
): TuiEphemeralState {
  return { ...createInitialTuiEphemeralState(), ...overrides };
}

describe("Phase 11 pi-tui renderer", () => {
  it("renders four bounded sections and sanitizes every display boundary", () => {
    const component = new BornAgentViewComponent(
      populatedView(),
      ephemeral({ draftInput: "ask secret-value\u001b[2J" }),
      { secrets: ["secret-value"], transcriptViewportRows: 4 },
    );

    const lines = component.render(48);
    const text = lines.join("\n");

    expect(lines).toHaveLength(11);
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(text).toContain("STATUS");
    expect(text).toContain("TRANSCRIPT");
    expect(text).toContain("[tool:success]");
    expect(text).toContain("[patch:awaiting_approval]");
    expect(text).toContain("[command:completed]");
    expect(text).toContain("[verification:passed]");
    expect(text).toContain("APPROVAL");
    expect(text).toContain("[DENY]  allow");
    expect(text).toContain("INPUT");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("owned-title");
    expect(text).not.toContain("YQ==");
  });

  it("bounds transcript history and rejects stale allow focus", () => {
    const view = populatedView();
    const component = new BornAgentViewComponent(
      {
        ...view,
        transcript: [
          ...view.transcript,
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `context-${index}`,
            kind: "context" as const,
            label: `row ${index}`,
            runId: "run-1",
          })),
        ],
      },
      ephemeral({
        approvalFocus: "allow",
        approvalRequestId: "stale-request",
        scrollOffset: 0,
      }),
      { transcriptViewportRows: 3 },
    );

    const text = component.render(80).join("\n");
    expect(text).toContain("TRANSCRIPT | 22-24/24");
    expect(text).toContain("row 19");
    expect(text).not.toContain("[tool:success]");
    expect(text).toContain("[DENY]  allow");
    expect(text).not.toContain("[ALLOW]");
  });

  it("renders and sanitizes an ephemeral pre-session diagnostic", () => {
    const component = new BornAgentViewComponent(
      createInitialTuiViewState(),
      ephemeral({
        coreDiagnostic:
          "restart with --task-profile read-only\u001b]0;owned-title\u0007",
      }),
    );

    const text = component.render(100).join("\n");
    expect(text).toContain("DIAGNOSTIC | restart with --task-profile read-only");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("owned-title");
  });

  it("exposes a start-update-stop adapter over a recording surface", () => {
    const surface = new RecordingSurface();
    const onInput = vi.fn(() => ({ consume: true } as const));
    const renderer = createPiTuiRenderer({ onInput, surface });

    renderer.start(createInitialTuiViewState(), ephemeral());
    expect(surface.calls).toEqual([
      "addChild",
      "addInputListener",
      "start",
    ]);
    expect(surface.component?.render(40).join("\n")).toContain("run=idle");
    expect(surface.listener?.("x")).toEqual({ consume: true });
    expect(onInput).toHaveBeenCalledWith("x");

    renderer.update(populatedView(), ephemeral());
    expect(surface.calls.at(-1)).toBe("requestRender");
    expect(surface.component?.render(80).join("\n")).toContain("run=running");

    renderer.stop();
    expect(surface.calls.slice(-3)).toEqual([
      "removeInputListener",
      "removeChild",
      "stop",
    ]);
    renderer.stop();
    expect(surface.calls.at(-1)).toBe("stop");
  });

  it("does not silently accept update before start", () => {
    const renderer = createPiTuiRenderer({ surface: new RecordingSurface() });
    expect(() =>
      renderer.update(createInitialTuiViewState(), ephemeral()),
    ).toThrow("must be started before update");
  });

  it("restores the alternate screen and cursor exactly once", () => {
    const terminal = new RecordingTerminal();
    const renderer = createPiTuiRenderer({ terminal });

    renderer.start(createInitialTuiViewState(), ephemeral());
    renderer.stop();
    renderer.stop();

    expect(terminal.calls).toContain("write:\"\\u001b[?1049h\\u001b[H\"");
    expect(terminal.calls).toContain("write:\"\\u001b[?1049l\"");
    expect(terminal.calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(terminal.calls.at(-1)).toBe("showCursor");
  });

  it("attempts surface cleanup when start throws", () => {
    const surface = new RecordingSurface();
    surface.start = () => {
      surface.calls.push("start");
      throw new Error("start failed");
    };
    const renderer = createPiTuiRenderer({ surface });

    expect(() =>
      renderer.start(createInitialTuiViewState(), ephemeral()),
    ).toThrow("start failed");
    expect(surface.calls.slice(-3)).toEqual([
      "start",
      "removeChild",
      "stop",
    ]);
  });
});
