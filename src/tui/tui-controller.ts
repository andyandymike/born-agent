import { Key, matchesKey } from "@earendil-works/pi-tui";

import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import { reducePersistedEvent } from "./tui-event-reducer.js";
import {
  createInitialTuiEphemeralState,
  enterApprovalDecision,
  openApprovalDialog,
  setApprovalFocus,
  setDraftInput,
  type TuiEphemeralState,
} from "./tui-ephemeral-state.js";
import {
  beginSingleActiveRun,
  createSingleActiveRunState,
  finishSingleActiveRun,
  resolveCtrlC,
  type SingleActiveRunState,
} from "./single-active-run.js";
import { sanitizeTerminalText } from "./terminal-sanitizer.js";
import type { ApprovalController } from "./approval-controller.js";
import type { PersistedEventSource } from "./persisted-event-source.js";
import type {
  PiTuiInputListenerResult,
  PiTuiRenderer,
} from "./pi-tui-renderer.js";
import {
  createInitialTuiViewState,
  type TuiViewState,
} from "./tui-view-state.js";

export interface TuiCorePort {
  cancelActiveRun(): void;
  loadSession(sessionId: string): Promise<readonly TuiPersistedEvent[]>;
  resumeSession(sessionId: string, message?: string): Promise<number>;
  startTask(task: string): Promise<number>;
}

export interface TuiControllerOptions {
  readonly approvalController: ApprovalController;
  readonly core: TuiCorePort;
  readonly renderer: PiTuiRenderer;
  readonly source: PersistedEventSource;
}

type AppExitCode = 0 | 1;

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SESSION_COMMAND = /^\/session\s+(\S+)\s*$/u;
const RESUME_COMMAND = /^\/resume\s+(\S+)(?:\s+([\s\S]+))?$/u;

function printableInput(data: string): string | null {
  if (data.length === 0) return null;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return sanitizeTerminalText(data);
}

function bracketedPaste(data: string): string | undefined {
  return data.startsWith(BRACKETED_PASTE_START) &&
    data.endsWith(BRACKETED_PASTE_END)
    ? data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
    : undefined;
}

export class TuiController {
  private viewState = createInitialTuiViewState();
  private ephemeralState = createInitialTuiEphemeralState();
  private runState: SingleActiveRunState = createSingleActiveRunState();
  private renderScheduled = false;
  private started = false;
  private stopped = false;
  private fatal = false;
  private activeCoreRun: Promise<number> | null = null;
  private readonly exitPromise: Promise<AppExitCode>;
  private resolveExit!: (code: AppExitCode) => void;

  public constructor(private readonly options: TuiControllerOptions) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  public get view(): TuiViewState {
    return this.viewState;
  }

  public get ephemeral(): TuiEphemeralState {
    return this.ephemeralState;
  }

  public start(snapshot: readonly TuiPersistedEvent[] = []): void {
    if (this.started) throw new Error("TUI controller can only be started once");
    this.started = true;
    this.options.source.resetWhileIdle({ snapshot });
    this.options.renderer.start(this.viewState, this.ephemeralState);
  }

  public waitForExit(): Promise<AppExitCode> {
    return this.exitPromise;
  }

  public async runInitial(input: {
    readonly resumeSessionId?: string;
    readonly task?: string;
  }): Promise<void> {
    if (input.resumeSessionId !== undefined) {
      if (this.viewState.session.id !== input.resumeSessionId) {
        await this.selectSession(input.resumeSessionId);
      }
      await this.startCoreRun(() =>
        this.options.core.resumeSession(input.resumeSessionId!),
      );
      return;
    }
    if (input.task !== undefined) {
      await this.startCoreRun(() => this.options.core.startTask(input.task!));
    }
  }

  public handleRawInput(data: string): PiTuiInputListenerResult {
    if (!this.started || this.stopped) return undefined;
    if (matchesKey(data, Key.ctrl("c"))) {
      const resolution = resolveCtrlC(
        this.viewState,
        this.ephemeralState,
        this.runState,
      );
      this.ephemeralState = resolution.ephemeral;
      this.runState = resolution.runState;
      if (resolution.intent?.type === "cancel_active_run") {
        this.options.core.cancelActiveRun();
      } else if (resolution.intent?.type === "exit") {
        this.finishApp(0);
      }
      this.scheduleRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (
        this.runState.activeRunId === null &&
        this.ephemeralState.draftInput.length === 0
      ) {
        this.finishApp(0);
      }
      return { consume: true };
    }

    const approval = this.viewState.approval;
    if (approval?.expiresState.status === "active") {
      if (matchesKey(data, Key.left)) {
        this.ephemeralState = setApprovalFocus(this.ephemeralState, "deny");
      } else if (matchesKey(data, Key.right)) {
        this.ephemeralState = setApprovalFocus(this.ephemeralState, "allow");
      } else if (matchesKey(data, Key.tab)) {
        this.ephemeralState = setApprovalFocus(
          this.ephemeralState,
          this.ephemeralState.approvalFocus === "deny" ? "allow" : "deny",
        );
      } else if (matchesKey(data, Key.escape)) {
        void this.decideApproval("deny");
      } else if (matchesKey(data, Key.enter)) {
        void this.decideApproval();
      } else {
        return undefined;
      }
      this.scheduleRender();
      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      void this.submitDraft();
      return { consume: true };
    }
    if (matchesKey(data, Key.backspace)) {
      this.ephemeralState = setDraftInput(
        this.ephemeralState,
        [...this.ephemeralState.draftInput].slice(0, -1).join(""),
      );
      this.scheduleRender();
      return { consume: true };
    }
    const pasted = bracketedPaste(data);
    const text =
      pasted === undefined
        ? printableInput(data)
        : sanitizeTerminalText(pasted, { replacement: "" });
    if (text === null) return undefined;
    this.ephemeralState = setDraftInput(
      this.ephemeralState,
      this.ephemeralState.draftInput + text,
    );
    this.scheduleRender();
    return { consume: true };
  }

  public acceptPersistedEvent(event: TuiPersistedEvent): void {
    if (this.stopped) return;
    this.viewState = reducePersistedEvent(this.viewState, event);
    if (event.scope === "run" && event.type === "run.started") {
      this.runState = {
        activeRunId: event.runId ?? null,
        cancellationRequested: false,
      };
    }
    if (
      event.scope === "run" &&
      (event.type === "run.budget_exceeded" ||
        event.type === "run.cancelled" ||
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.incomplete")
    ) {
      this.runState = finishSingleActiveRun(
        this.runState,
        event.runId ?? this.runState.activeRunId ?? "",
      );
    }
    const approval = this.viewState.approval;
    if (approval?.expiresState.status === "active") {
      if (this.ephemeralState.approvalRequestId !== approval.requestId) {
        this.ephemeralState = openApprovalDialog(
          this.ephemeralState,
          approval.requestId,
        );
      }
    } else if (this.ephemeralState.approvalRequestId !== null) {
      this.ephemeralState = {
        ...this.ephemeralState,
        approvalFocus: "deny",
        approvalRequestId: null,
      };
    }
    if (this.viewState.session.fatalReason !== null) {
      void this.failFatal();
    } else {
      this.scheduleRender();
    }
  }

  public handleSourceFatal(): void {
    void this.failFatal();
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.source.close();
    this.options.renderer.stop();
  }

  private async decideApproval(force?: "deny"): Promise<void> {
    const approval = this.viewState.approval;
    if (approval === null) return;
    const intent = enterApprovalDecision(
      force === "deny"
        ? setApprovalFocus(this.ephemeralState, "deny")
        : this.ephemeralState,
      approval.requestId,
      approval.actionSha256,
    );
    const result = await this.options.approvalController.decide(intent);
    if (result.status === "failed") await this.failFatal();
  }

  private async submitDraft(): Promise<void> {
    const text = this.ephemeralState.draftInput.trim();
    if (text.length === 0) return;
    this.ephemeralState = setDraftInput(this.ephemeralState, "");
    this.scheduleRender();
    if (text === "exit") {
      if (this.runState.activeRunId === null) this.finishApp(0);
      return;
    }
    const session = SESSION_COMMAND.exec(text);
    if (session?.[1] !== undefined) {
      await this.selectSession(session[1]);
      return;
    }
    const resume = RESUME_COMMAND.exec(text);
    if (resume?.[1] !== undefined) {
      await this.selectSession(resume[1]);
      await this.startCoreRun(() =>
        this.options.core.resumeSession(resume[1]!, resume[2]),
      );
      return;
    }
    await this.startCoreRun(() => this.options.core.startTask(text));
  }

  private async selectSession(sessionId: string): Promise<void> {
    if (this.runState.activeRunId !== null) return;
    try {
      const snapshot = await this.options.core.loadSession(sessionId);
      this.viewState = createInitialTuiViewState();
      this.ephemeralState = createInitialTuiEphemeralState();
      this.options.source.resetWhileIdle({ snapshot });
      this.scheduleRender();
    } catch {
      await this.failFatal();
    }
  }

  private async startCoreRun(run: () => Promise<number>): Promise<void> {
    const begun = beginSingleActiveRun(this.runState, "pending");
    if (begun.status === "busy") return;
    this.runState = begun.state;
    const promise = run();
    this.activeCoreRun = promise;
    try {
      await promise;
    } catch {
      await this.failFatal();
    } finally {
      if (this.activeCoreRun === promise) this.activeCoreRun = null;
      if (this.runState.activeRunId === "pending") {
        this.runState = finishSingleActiveRun(this.runState, "pending");
      }
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled || this.stopped) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (this.stopped) return;
      try {
        // PHASE11: every durable fact is reduced synchronously, while repeated
        // invalidations may coalesce so a slow terminal never drops core facts.
        this.options.renderer.update(this.viewState, this.ephemeralState);
      } catch {
        void this.failFatal();
      }
    });
  }

  private async failFatal(): Promise<void> {
    if (this.fatal) return;
    this.fatal = true;
    this.options.core.cancelActiveRun();
    const active = this.activeCoreRun;
    if (active !== null) await active.catch(() => undefined);
    this.finishApp(1);
  }

  private finishApp(code: AppExitCode): void {
    if (this.stopped) return;
    this.resolveExit(code);
  }
}
