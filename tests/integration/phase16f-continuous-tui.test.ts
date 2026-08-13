import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import type { PiTuiRenderer, PiTuiRendererOptions } from "../../src/tui/pi-tui-renderer.js";
import type { TuiEphemeralState } from "../../src/tui/tui-ephemeral-state.js";
import type { TuiViewState } from "../../src/tui/tui-view-state.js";
import { createPlanToolRegistry } from "../../src/tools/create-plan-tool-registry.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const workspaces: string[] = [];
const execFileAsync = promisify(execFile);
const CRASH_SESSION_ID = "16000000-0000-4000-8000-000000016601";
const CRASH_GOAL_ID = "16000000-0000-4000-8000-000000016602";

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "bornagent-phase16f-tui-"));
  workspaces.push(result);
  await writeFile(join(result, "fixture.txt"), "phase16\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: result });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: result,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 Fixture"], {
    cwd: result,
  });
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: result });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: result,
  });
  return result;
}

class TerminalExitRenderer implements PiTuiRenderer {
  readonly start = vi.fn();
  readonly stop = vi.fn();
  outcomeReportSha256: string | null = null;
  readonly preparedActions: string[] = [];
  private exitQueued = false;
  private readonly reviewedPreparedActionIds = new Set<string>();

  constructor(private readonly onInput: PiTuiRendererOptions["onInput"]) {}

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    this.outcomeReportSha256 =
      view.outcomeReport?.reportSha256 ?? this.outcomeReportSha256;
    const prepared = ephemeral.preparedActionDialog;
    if (
      prepared !== null &&
      !this.reviewedPreparedActionIds.has(prepared.preparedActionId)
    ) {
      this.reviewedPreparedActionIds.add(prepared.preparedActionId);
      this.preparedActions.push(prepared.actionKind);
      queueMicrotask(() => {
        this.onInput?.("\u001b[C");
        this.onInput?.("\r");
      });
      return;
    }
    if (
      this.exitQueued ||
      view.run === null ||
      view.run.status === "running"
    ) {
      return;
    }
    this.exitQueued = true;
    queueMicrotask(() => this.onInput?.("\u0003"));
  }

}

class TwoRunRenderer implements PiTuiRenderer {
  diagnostic: string | null = null;
  readonly start = vi.fn(() => {
    queueMicrotask(() => {
      this.onInput?.("First continuous task");
      this.onInput?.("\r");
    });
  });
  readonly stop = vi.fn();
  private readonly terminalRuns = new Set<string>();
  private failureExitQueued = false;
  private busyObserved = false;
  private busyRetrySubmitted = false;

  constructor(private readonly onInput: PiTuiRendererOptions["onInput"]) {}

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    if (
      this.busyObserved &&
      !this.busyRetrySubmitted &&
      ephemeral.coreDiagnostic === null
    ) {
      this.busyRetrySubmitted = true;
      queueMicrotask(() => this.onInput?.("\r"));
      return;
    }
    if (
      this.terminalRuns.size === 1 &&
      ephemeral.coreDiagnostic !== null &&
      !this.failureExitQueued
    ) {
      if (ephemeral.coreDiagnostic.startsWith("Run active")) {
        this.busyObserved = true;
        return;
      }
      this.diagnostic = ephemeral.coreDiagnostic;
      this.failureExitQueued = true;
      queueMicrotask(() => {
        this.onInput?.("\u0003");
        this.onInput?.("\u0003");
      });
      return;
    }
    if (
      view.run === null ||
      view.run.status === "running" ||
      this.terminalRuns.has(view.run.id)
    ) {
      return;
    }
    this.terminalRuns.add(view.run.id);
    if (this.terminalRuns.size === 1) {
      queueMicrotask(() => {
        this.onInput?.("Second explicit user turn");
        this.onInput?.("\r");
      });
    } else {
      queueMicrotask(() => this.onInput?.("\u0003"));
    }
  }
}

class NewGoalRenderer implements PiTuiRenderer {
  diagnostic: string | null = null;
  readonly start = vi.fn(() => {
    queueMicrotask(() => {
      this.onInput?.("Initial active goal");
      this.onInput?.("\r");
    });
  });
  readonly stop = vi.fn();
  private readonly terminalRuns = new Set<string>();
  private replacementSubmitted = false;
  private retryAfterBusy = false;

  constructor(private readonly onInput: PiTuiRendererOptions["onInput"]) {}

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    if (
      this.retryAfterBusy &&
      ephemeral.coreDiagnostic === null &&
      this.terminalRuns.size === 1
    ) {
      this.retryAfterBusy = false;
      queueMicrotask(() => this.onInput?.("\r"));
      return;
    }
    if (ephemeral.coreDiagnostic?.startsWith("Run active") === true) {
      this.retryAfterBusy = true;
      return;
    }
    if (ephemeral.coreDiagnostic !== null) {
      this.diagnostic = ephemeral.coreDiagnostic;
      queueMicrotask(() => {
        this.onInput?.("\u0003");
        this.onInput?.("\u0003");
      });
      return;
    }
    if (
      view.run === null ||
      view.run.status === "running" ||
      this.terminalRuns.has(view.run.id)
    ) {
      return;
    }
    this.terminalRuns.add(view.run.id);
    if (!this.replacementSubmitted) {
      this.replacementSubmitted = true;
      queueMicrotask(() => {
        this.onInput?.("/new! Replacement active goal");
        this.onInput?.("\r");
      });
      return;
    }
    queueMicrotask(() => this.onInput?.("\u0003"));
  }
}

class InvalidRetryRenderer implements PiTuiRenderer {
  diagnostic: string | null = null;
  readonly start = vi.fn(() => {
    queueMicrotask(() => {
      this.onInput?.("Goal with one completed run attempt");
      this.onInput?.("\r");
    });
  });
  readonly stop = vi.fn();
  private terminalRunId: string | null = null;
  private retrySubmitted = false;
  private retryAfterBusy = false;

  constructor(private readonly onInput: PiTuiRendererOptions["onInput"]) {}

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    if (
      this.retryAfterBusy &&
      ephemeral.coreDiagnostic === null &&
      this.terminalRunId !== null
    ) {
      this.retryAfterBusy = false;
      queueMicrotask(() => this.onInput?.("\r"));
      return;
    }
    if (ephemeral.coreDiagnostic?.startsWith("Run active") === true) {
      this.retryAfterBusy = true;
      return;
    }
    if (ephemeral.coreDiagnostic?.includes("retry_goal_start_invalid") === true) {
      this.diagnostic = ephemeral.coreDiagnostic;
      queueMicrotask(() => {
        this.onInput?.("\u0003");
        this.onInput?.("\u0003");
      });
      return;
    }
    if (
      this.retrySubmitted ||
      view.run === null ||
      view.run.status === "running"
    ) {
      return;
    }
    this.terminalRunId = view.run.id;
    this.retrySubmitted = true;
    queueMicrotask(() => {
      this.onInput?.("/retry");
      this.onInput?.("\r");
    });
  }
}

describe("Phase 16F continuous TUI", () => {
  // These are full application-control/TUI lifecycles with real durable
  // catalog, operation-journal, projection, and renderer boundaries. The
  // default 5s unit-test budget is too narrow under the full parallel suite.
  const lifecycleTimeoutMs = 20_000;

  it("reopens a Goal-committed/run-not-started crash prefix without duplicating the Goal", async () => {
    const cwd = await workspace();
    const writer = await V2SessionWriter.createNew(cwd, CRASH_SESSION_ID);
    await writer.appendTaskEvent("goal.created", {
      goal_id: CRASH_GOAL_ID,
      objective: "Resume after the Goal commit window",
      origin: { input_surface: "tui", kind: "user" },
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    await writer.close();

    const backend = new FakeStreamingChatClient(
      fixedStream(["The recovered Goal needs one bounded clarification."]),
      { model: "qwen3:1.7b", provider: "ollama" },
    );
    let renderer: TerminalExitRenderer | undefined;
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "tui",
        "--resume",
        CRASH_SESSION_ID,
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
        supportsPhase16TaskState: true,
        tuiHost: {
          createRenderer: (options) => {
            renderer = new TerminalExitRenderer(options.onInput);
            return renderer;
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(0);
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", `${CRASH_SESSION_ID}.jsonl`),
    );
    expect(events.filter((event) => event.type === "goal.created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.started")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ goal_id: CRASH_GOAL_ID }),
      }),
    ]);
    expect(backend.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      data: { reason: "clarification_required" },
      type: "run.incomplete",
    });
    expect(renderer?.stop).toHaveBeenCalledOnce();
  }, lifecycleTimeoutMs);

  it("starts a default-Plan run with durable tui provenance and returns to idle", async () => {
    const cwd = await workspace();
    const controlPlaneStateRoot = await mkdtemp(
      join(tmpdir(), "bornagent-phase21a-tui-state-"),
    );
    workspaces.push(controlPlaneStateRoot);
    const backend = new FakeStreamingChatClient(
      fixedStream(["I need one bounded clarification."]),
      { model: "qwen3:1.7b", provider: "ollama" },
    );
    let renderer: TerminalExitRenderer | undefined;
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "tui",
        "Investigate the next safe slice",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        controlPlaneStateRoot,
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
        supportsPhase16TaskState: true,
        tuiHost: {
          createRenderer: (options) => {
            renderer = new TerminalExitRenderer(options.onInput);
            return renderer;
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(0);
    expect(renderer?.preparedActions).toEqual([
      "repository.register",
      "session.message.submit",
    ]);
    expect(renderer?.start).toHaveBeenCalledOnce();
    expect(renderer?.stop).toHaveBeenCalledOnce();
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    );
    expect(file).toBeDefined();
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file!),
    );
    expect(events[0]).toMatchObject({
      data: {
        origin: {
          application_commit: {
            action_kind: "session.message.submit",
            principal_id: "local_owner",
          },
          kind: "authenticated_surface",
          surface: "tui",
        },
      },
      type: "goal.created",
    });
    expect(events[1]).toMatchObject({
      data: {
        agent_mode: "plan",
        agent_mode_source: "tui_default",
        application_commit: {
          action_kind: "session.message.submit",
          principal_id: "local_owner",
        },
      },
      type: "run.started",
    });
    expect(events.at(-1)).toMatchObject({
      data: { reason: "clarification_required" },
      type: "run.incomplete",
    });
    expect(backend.calls).toHaveLength(1);

    const show = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "show", events[0]!.sessionId, "--json"],
        show.io,
        createRuntime({ controlPlaneStateRoot, cwd, env: {} }),
      ),
      show.readStderr(),
    ).toBe(0);
    const shown = JSON.parse(show.readStdout()) as {
      readonly outcomeReport: { readonly reportSha256: string };
    };
    expect(shown.outcomeReport.reportSha256).toBe(
      renderer?.outcomeReportSha256,
    );
  }, lifecycleTimeoutMs);

  it("runs two explicit turns in one session without /resume or a hidden queue", async () => {
    const cwd = await workspace();
    const backends = [
      new FakeStreamingChatClient(fixedStream(["First clarification."]), {
        model: "qwen3:1.7b",
        provider: "ollama",
      }),
      new FakeStreamingChatClient(fixedStream(["Second clarification."]), {
        model: "qwen3:1.7b",
        provider: "ollama",
      }),
    ];
    let backendIndex = 0;
    let renderer: TwoRunRenderer | undefined;
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "tui",
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => {
          const backend = backends[backendIndex];
          backendIndex += 1;
          if (backend === undefined) throw new Error("unexpected backend request");
          return backend;
        },
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
        supportsPhase16TaskState: true,
        tuiHost: {
          createRenderer: (options) => {
            renderer = new TwoRunRenderer(options.onInput);
            return renderer;
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );

    expect(exitCode, renderer?.diagnostic ?? memory.readStderr()).toBe(0);
    expect(renderer?.diagnostic).toBeNull();
    expect(renderer?.stop).toHaveBeenCalledOnce();
    const files = (await readdir(join(cwd, ".bornagent", "sessions"))).filter(
      (name) => name.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", files[0]!),
    );
    expect(events.filter((event) => event.type === "goal.created")).toHaveLength(1);
    const starts = events.filter((event) => event.type === "run.started");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((event) => event.runId)).size).toBe(2);
    expect(
      events.filter((event) => event.type === "session.resume.requested"),
    ).toHaveLength(1);
    expect(backends.map((backend) => backend.calls.length)).toEqual([1, 1]);
  }, lifecycleTimeoutMs);

  it("replaces an active Goal explicitly and starts its run in the same session", async () => {
    const cwd = await workspace();
    const backends = [
      new FakeStreamingChatClient(fixedStream(["First Goal needs clarification."]), {
        model: "qwen3:1.7b",
        provider: "ollama",
      }),
      new FakeStreamingChatClient(fixedStream(["Replacement Goal needs clarification."]), {
        model: "qwen3:1.7b",
        provider: "ollama",
      }),
    ];
    let backendIndex = 0;
    let renderer: NewGoalRenderer | undefined;
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "tui",
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => {
          const backend = backends[backendIndex];
          backendIndex += 1;
          if (backend === undefined) throw new Error("unexpected backend request");
          return backend;
        },
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
        supportsPhase16TaskState: true,
        tuiHost: {
          createRenderer: (options) => {
            renderer = new NewGoalRenderer(options.onInput);
            return renderer;
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );

    expect(exitCode, renderer?.diagnostic ?? memory.readStderr()).toBe(0);
    expect(renderer?.diagnostic).toBeNull();
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    );
    expect(file).toBeDefined();
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file!),
    );
    const goals = events.filter((event) => event.type === "goal.created");
    expect(goals).toHaveLength(2);
    expect(goals[1]).toMatchObject({
      data: {
        objective: "Replacement active goal",
        replaces_active_goal: {
          goal_id: (goals[0]!.data as { readonly goal_id: string }).goal_id,
          revision: 1,
        },
      },
    });
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(2);
    expect(backends.map((backend) => backend.calls.length)).toEqual([1, 1]);
  }, lifecycleTimeoutMs);

  it("rejects /retry after a Goal already has a durable run without creating another run", async () => {
    const cwd = await workspace();
    const backend = new FakeStreamingChatClient(
      fixedStream(["This run ends with a clarification."]),
      { model: "qwen3:1.7b", provider: "ollama" },
    );
    let renderer: InvalidRetryRenderer | undefined;
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["tui", "--provider", "ollama", "--model", "qwen3:1.7b"],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
        supportsPhase16TaskState: true,
        tuiHost: {
          createRenderer: (options) => {
            renderer = new InvalidRetryRenderer(options.onInput);
            return renderer;
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(0);
    expect(renderer?.diagnostic).toContain("retry_goal_start_invalid");
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    );
    expect(file).toBeDefined();
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file!),
    );
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "session.resume.requested"),
    ).toHaveLength(0);
    expect(backend.calls).toHaveLength(1);
  }, lifecycleTimeoutMs);
});
