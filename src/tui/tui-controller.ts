import { randomUUID } from "node:crypto";

import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";

import {
  RunCoordinator,
  RunCoordinatorPortError,
  type RunCoordinatorDispatchResult,
  type RunCoordinatorRunStarted,
} from "../coordination/run-coordinator.js";
import type { RunCoordinatorSnapshot } from "../coordination/run-coordinator-state.js";
import type { PlanRevisionProjection } from "../coordination/task-state-types.js";
import type { GoalProjection } from "../goals/goal-schema.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import { reducePersistedEvent } from "./tui-event-reducer.js";
import {
  createInitialTuiEphemeralState,
  closePlanDecisionDialog,
  enterApprovalDecision,
  openApprovalDialog,
  openPlanDecisionDialog,
  setApprovalFocus,
  setCoreDiagnostic,
  setDraftInput,
  setPlanDecisionFocus,
  type TuiEphemeralState,
  type TuiPlanDecisionDialog,
} from "./tui-ephemeral-state.js";
import { Phase16TuiProjector } from "./phase16-tui-projector.js";
import { sanitizeTerminalText } from "./terminal-sanitizer.js";
import type { ApprovalController } from "./approval-controller.js";
import type { PersistedEventSource } from "./persisted-event-source.js";
import type {
  PiTuiInputListenerResult,
  PiTuiRenderer,
} from "./pi-tui-renderer.js";
import {
  createInitialTuiViewState,
  isActiveRun,
  type TuiViewState,
} from "./tui-view-state.js";
import type {
  Phase16MutationIntent,
  Phase16StartIntent,
} from "./phase16-user-intent.js";

export interface TuiCorePort {
  cancelActiveRun(): void;
  loadSession(sessionId: string): Promise<readonly TuiPersistedEvent[]>;
  mutateIntent?(intent: Phase16MutationIntent): Promise<TuiCoreRunResult>;
  resumeSession(
    sessionId: string,
    message?: string,
  ): Promise<TuiCoreRunResult>;
  startTask(task: string): Promise<TuiCoreRunResult>;
  startIntent?(
    intent: Phase16StartIntent,
    selectedMode: "build" | "plan",
    modeSource: "explicit_tui" | "tui_default",
  ): Promise<TuiCoreRunResult>;
}

export interface TuiCoreRunResult {
  readonly diagnostic: string | null;
  readonly exitCode: number;
}

export interface TuiControllerOptions {
  readonly approvalController: ApprovalController;
  readonly core: TuiCorePort;
  readonly createIntentId?: () => string;
  readonly initialMode?: "build" | "plan";
  readonly initialModeSource?: "explicit_tui" | "tui_default";
  readonly renderer: PiTuiRenderer;
  readonly source: PersistedEventSource;
}

type AppExitCode = 0 | 1;

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SESSION_COMMAND = /^\/session\s+(\S+)\s*$/u;
const RESUME_COMMAND = /^\/resume\s+(\S+)(?:\s+([\s\S]+))?$/u;
const MODE_COMMAND = /^\/mode\s+(plan|build)\s*$/u;
const NEW_GOAL_COMMAND = /^\/new(!)?\s+([\s\S]+)$/u;
const GOAL_SET_COMMAND = /^\/goal\s+set\s+([\s\S]+)$/u;
const GOAL_ABANDON_COMMAND = /^\/goal\s+abandon\s+([\s\S]+)$/u;
const PLAN_REJECT_COMMAND = /^\/plan\s+reject\s+([\s\S]+)$/u;
const PLAN_REPLACE_COMMAND = /^\/plan\s+replace\s+([\s\S]+)$/u;

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
  private renderScheduled = false;
  private started = false;
  private stopped = false;
  private fatal = false;
  private exitWhenIdle = false;
  private activeCoreRun: Promise<TuiCoreRunResult> | null = null;
  private coordinator: RunCoordinator | null = null;
  private readonly eventSnapshot: TuiPersistedEvent[] = [];
  private pendingRunStarted:
    | ((started: RunCoordinatorRunStarted) => void)
    | null = null;
  private readonly phase16Projector = new Phase16TuiProjector();
  private readonly exitPromise: Promise<AppExitCode>;
  private resolveExit!: (code: AppExitCode) => void;

  public constructor(private readonly options: TuiControllerOptions) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    if (options.initialMode !== undefined) {
      this.ephemeralState = {
        ...this.ephemeralState,
        selectedAgentMode: options.initialMode,
        selectedAgentModeSource:
          options.initialModeSource ?? "explicit_tui",
      };
    }
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
    this.coordinator = this.createCoordinator({
      sessionId: snapshot.at(-1)?.sessionId ?? null,
      snapshotSeq: snapshot.at(-1)?.sessionSeq ?? null,
    });
    this.phase16Projector.reset();
    this.eventSnapshot.length = 0;
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
      if (
        this.options.core.startIntent === undefined ||
        this.viewState.taskState.trackingMode === "legacy_untracked"
      ) {
        await this.startCoreRun(() =>
          this.options.core.resumeSession(input.resumeSessionId!),
        );
      } else {
        await this.dispatchStart({
          ...this.currentBinding(),
          mode: this.ephemeralState.selectedAgentMode,
          reason: "explicit_continue",
          type: "start_run_without_message",
        });
      }
      return;
    }
    if (input.task !== undefined) {
      if (this.options.core.startIntent === undefined) {
        await this.startCoreRun(() => this.options.core.startTask(input.task!));
      } else {
        await this.dispatchStart({
          ...this.currentBinding(),
          text: input.task,
          type: "submit_idle_message",
        });
      }
    }
  }

  public handleRawInput(data: string): PiTuiInputListenerResult {
    if (!this.started || this.stopped) return undefined;
    // PHASE11: BornAgent receives input through a global pi-tui listener, which
    // runs before pi-tui filters Kitty key-release events for focused widgets.
    // Consuming releases here prevents duplicate submit/cancel/approval intents.
    if (isKeyRelease(data)) return { consume: true };
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.ephemeralState.planDecisionDialog !== null) {
        this.ephemeralState = closePlanDecisionDialog(this.ephemeralState);
        this.scheduleRender();
        return { consume: true };
      }
      const coordinatorActive =
        this.coordinator !== null &&
        (this.coordinator.state.kind === "starting" ||
          this.coordinator.state.kind === "running" ||
          this.coordinator.state.kind === "cancelling");
      const durableRunActive = isActiveRun(this.viewState.run);
      const approvalActive =
        this.viewState.approval?.expiresState.status === "active";
      if (
        !durableRunActive &&
        !approvalActive &&
        (coordinatorActive || this.activeCoreRun !== null)
      ) {
        this.exitWhenIdle = true;
      } else if (
        coordinatorActive ||
        this.activeCoreRun !== null ||
        durableRunActive ||
        approvalActive
      ) {
        if (coordinatorActive) {
          void this.coordinator?.dispatch({ type: "cancel_active_run" });
        } else {
          this.options.core.cancelActiveRun();
        }
      } else if (this.ephemeralState.draftInput.length > 0) {
        this.ephemeralState = setDraftInput(this.ephemeralState, "");
      } else {
        this.finishApp(0);
      }
      this.scheduleRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (
        this.ephemeralState.planDecisionDialog === null &&
        this.activeCoreRun === null &&
        (this.coordinator === null ||
          this.coordinator.state.kind === "idle") &&
        this.ephemeralState.draftInput.length === 0
      ) {
        this.finishApp(0);
      }
      return { consume: true };
    }

    if (this.ephemeralState.planDecisionDialog !== null) {
      if (matchesKey(data, Key.left)) {
        this.ephemeralState = setPlanDecisionFocus(
          this.ephemeralState,
          "cancel",
        );
      } else if (matchesKey(data, Key.right)) {
        this.ephemeralState = setPlanDecisionFocus(
          this.ephemeralState,
          "confirm",
        );
      } else if (matchesKey(data, Key.tab)) {
        this.ephemeralState = setPlanDecisionFocus(
          this.ephemeralState,
          this.ephemeralState.planDecisionFocus === "cancel"
            ? "confirm"
            : "cancel",
        );
      } else if (matchesKey(data, Key.escape)) {
        this.ephemeralState = closePlanDecisionDialog(this.ephemeralState);
      } else if (matchesKey(data, Key.enter)) {
        void this.decidePlanDecision();
      } else {
        return undefined;
      }
      this.scheduleRender();
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
      this.ephemeralState = setCoreDiagnostic(
        setDraftInput(
          this.ephemeralState,
          [...this.ephemeralState.draftInput].slice(0, -1).join(""),
        ),
        null,
      );
      this.scheduleRender();
      return { consume: true };
    }
    const pasted = bracketedPaste(data);
    const text =
      pasted === undefined
        ? // PHASE11: Kitty terminals encode ordinary text as CSI-u. Decode it
          // before printableInput rejects the sequence's ESC control byte.
          (decodeKittyPrintable(data) ?? printableInput(data))
        : sanitizeTerminalText(pasted, { replacement: "" });
    if (text === null) return undefined;
    this.ephemeralState = setCoreDiagnostic(
      setDraftInput(
        this.ephemeralState,
        this.ephemeralState.draftInput + text,
      ),
      null,
    );
    this.scheduleRender();
    return { consume: true };
  }

  public acceptPersistedEvent(event: TuiPersistedEvent): void {
    if (this.stopped) return;
    this.viewState = reducePersistedEvent(this.viewState, event);
    if (this.viewState.session.fatalReason === null) {
      this.eventSnapshot.push(event);
      const projection = this.phase16Projector.accept(event);
      if (projection !== null) {
        this.viewState = {
          ...this.viewState,
          outcomeReport: projection.outcomeReport,
          taskState: projection.taskState,
        };
      }
    }
    if (event.scope === "run" && event.type === "run.started") {
      this.ephemeralState = setCoreDiagnostic(this.ephemeralState, null);
      const acknowledge = this.pendingRunStarted;
      if (acknowledge !== null && event.runId !== undefined) {
        this.pendingRunStarted = null;
        acknowledge({ runId: event.runId, sessionId: event.sessionId });
      }
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

  private async decidePlanDecision(): Promise<void> {
    const dialog = this.ephemeralState.planDecisionDialog;
    if (dialog === null) return;
    const confirmed = this.ephemeralState.planDecisionFocus === "confirm";
    this.ephemeralState = closePlanDecisionDialog(this.ephemeralState);
    if (!confirmed) {
      this.scheduleRender();
      return;
    }

    const current = this.currentBinding();
    if (
      current.sessionId !== dialog.sessionId ||
      current.expectedSessionSeq !== dialog.expectedSessionSeq
    ) {
      this.ephemeralState = setCoreDiagnostic(
        this.ephemeralState,
        "Plan decision became stale; no approval or rejection was written.",
      );
      this.scheduleRender();
      return;
    }

    const binding = {
      expectedSessionSeq: dialog.expectedSessionSeq,
      sessionId: dialog.sessionId,
    } as const;
    const succeeded =
      dialog.action === "reject"
        ? await this.dispatchMutation({
            ...binding,
            goalId: dialog.goalId,
            goalRevision: dialog.goalRevision,
            planId: dialog.planId,
            reason: dialog.reason ?? "Rejected from the TUI",
            revision: dialog.revision,
            sha256: dialog.planSha256,
            type: "reject_plan",
          })
        : await this.dispatchMutation({
            ...binding,
            goalId: dialog.goalId,
            goalRevision: dialog.goalRevision,
            planId: dialog.planId,
            revision: dialog.revision,
            sha256: dialog.planSha256,
            type: "approve_plan",
          });
    if (!succeeded || dialog.action !== "approve_build") return;

    this.ephemeralState = {
      ...this.ephemeralState,
      selectedAgentMode: "build",
      selectedAgentModeSource: "explicit_tui",
    };
    await this.dispatchStart({
      ...this.currentBinding(),
      mode: "build",
      reason: "approved_plan_build",
      type: "start_run_without_message",
    });
  }

  private async submitDraft(): Promise<void> {
    const text = this.ephemeralState.draftInput.trim();
    if (text.length === 0) return;
    if (text === "exit") {
      if (this.coordinator?.state.kind === "idle") this.finishApp(0);
      return;
    }
    if (text === "/refresh") {
      const result = await this.coordinator?.dispatch({
        type: "refresh_session",
      });
      this.renderCoordinatorResult(result);
      return;
    }
    const mode = MODE_COMMAND.exec(text)?.[1] as "build" | "plan" | undefined;
    if (mode !== undefined) {
      const result = await this.coordinator?.dispatch({
        mode,
        type: "set_agent_mode",
      });
      if (result?.status === "mode_selected") {
        this.ephemeralState = {
          ...setDraftInput(this.ephemeralState, ""),
          selectedAgentMode: result.mode,
          selectedAgentModeSource: "explicit_tui",
        };
      }
      this.renderCoordinatorResult(result);
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
        text,
      );
      return;
    }
    if (this.options.core.startIntent === undefined || this.coordinator === null) {
      this.ephemeralState = setDraftInput(this.ephemeralState, "");
      await this.startCoreRun(() => this.options.core.startTask(text), text);
      return;
    }

    const goal = this.activeGoal();
    const draft = this.pendingPlan();
    const newGoal = NEW_GOAL_COMMAND.exec(text);
    if (newGoal?.[2] !== undefined) {
      if (goal !== null && newGoal[1] !== "!") {
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          "Active Goal replacement requires explicit /new! <task> confirmation; workspace bytes are not rolled back.",
        );
        this.scheduleRender();
        return;
      }
      await this.dispatchStart(
        {
          ...this.currentBinding(),
          confirmedAbandon: goal !== null,
          currentGoalId: goal?.content.goalId ?? null,
          currentGoalRevision: goal?.content.revision ?? null,
          text: newGoal[2].trim(),
          type: "start_new_goal",
        },
        text,
      );
      return;
    }
    const goalSet = GOAL_SET_COMMAND.exec(text)?.[1];
    if (goalSet !== undefined) {
      if (goal === null) {
        this.showCommandDiagnostic("No active Goal is available to revise.");
        return;
      }
      await this.dispatchMutation({
        ...this.currentBinding(),
        baseRevision: goal.content.revision,
        goalId: goal.content.goalId,
        objective: goalSet.trim(),
        type: "revise_goal",
      });
      return;
    }
    const goalAbandon = GOAL_ABANDON_COMMAND.exec(text)?.[1];
    if (goalAbandon !== undefined) {
      if (goal === null) {
        this.showCommandDiagnostic("No active Goal is available to abandon.");
        return;
      }
      await this.dispatchMutation({
        ...this.currentBinding(),
        goalId: goal.content.goalId,
        reason: goalAbandon.trim(),
        revision: goal.content.revision,
        type: "abandon_goal",
      });
      return;
    }
    if (text === "/plan approve" || text === "/plan approve-build") {
      if (draft === null) {
        this.showCommandDiagnostic("No pending Plan draft is available for approval.");
        return;
      }
      this.openPlanDecision(
        draft,
        text === "/plan approve-build" ? "approve_build" : "approve",
      );
      return;
    }
    const planReject = PLAN_REJECT_COMMAND.exec(text)?.[1];
    if (planReject !== undefined) {
      if (draft === null) {
        this.showCommandDiagnostic("No pending Plan draft is available for rejection.");
        return;
      }
      this.openPlanDecision(draft, "reject", planReject.trim());
      return;
    }
    const planPath = PLAN_REPLACE_COMMAND.exec(text)?.[1];
    if (planPath !== undefined) {
      if (goal === null) {
        this.showCommandDiagnostic("No active Goal is available for Plan replacement.");
        return;
      }
      const base =
        this.viewState.taskState.pendingDraft ??
        this.viewState.taskState.currentApprovedPlan;
      await this.dispatchMutation({
        ...this.currentBinding(),
        base,
        goalId: goal.content.goalId,
        goalRevision: goal.content.revision,
        path: planPath.trim(),
        type: "replace_plan_from_file",
      });
      return;
    }
    if (text === "/retry" || text === "/continue") {
      if (goal === null) {
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          "No active Goal is available to start.",
        );
        this.scheduleRender();
        return;
      }
      await this.dispatchStart({
        ...this.currentBinding(),
        mode: this.ephemeralState.selectedAgentMode,
        reason: text === "/retry" ? "retry_goal_start" : "explicit_continue",
        type: "start_run_without_message",
      }, text);
      return;
    }
    if (goal === null && this.viewState.taskState.trackingMode === "phase16") {
      await this.dispatchStart(
        {
          ...this.currentBinding(),
          confirmedAbandon: false,
          currentGoalId: null,
          currentGoalRevision: null,
          text,
          type: "start_new_goal",
        },
        text,
      );
      return;
    }
    await this.dispatchStart(
      { ...this.currentBinding(), text, type: "submit_idle_message" },
      text,
    );
  }

  private currentBinding(): {
    readonly expectedSessionSeq: number | null;
    readonly sessionId: string | null;
  } {
    return this.viewState.session.id === null
      ? { expectedSessionSeq: null, sessionId: null }
      : {
          expectedSessionSeq: this.viewState.session.lastSessionSeq,
          sessionId: this.viewState.session.id,
        };
  }

  private currentSnapshot(): RunCoordinatorSnapshot {
    const binding = this.currentBinding();
    return {
      sessionId: binding.sessionId,
      snapshotSeq: binding.expectedSessionSeq,
    };
  }

  private activeGoal(): GoalProjection | null {
    const { activeGoalId, goals } = this.viewState.taskState;
    return (
      goals.find((goal) => goal.content.goalId === activeGoalId) ?? null
    );
  }

  private pendingPlan(): PlanRevisionProjection | null {
    const ref = this.viewState.taskState.pendingDraft;
    if (ref === null) return null;
    return (
      this.viewState.taskState.plans.find(
        (plan) =>
          plan.content.planId === ref.planId &&
          plan.content.revision === ref.revision &&
          plan.planSha256 === ref.planSha256,
      ) ?? null
    );
  }

  private openPlanDecision(
    plan: PlanRevisionProjection,
    action: TuiPlanDecisionDialog["action"],
    reason: string | null = null,
  ): void {
    if (
      this.coordinator?.state.kind !== "idle" ||
      isActiveRun(this.viewState.run)
    ) {
      this.showCommandDiagnostic(
        "Plan decisions are available only while the session is idle; command kept locally.",
      );
      return;
    }
    if (this.viewState.session.actionBlocked) {
      this.showCommandDiagnostic(
        "Plan decisions are disabled until unresolved session effects are reconciled.",
      );
      return;
    }
    const goal = this.viewState.taskState.goals.find(
      (candidate) =>
        candidate.content.goalId === plan.content.goalId &&
        candidate.content.revision === plan.content.goalRevision,
    );
    const binding = this.currentBinding();
    if (
      goal === undefined ||
      binding.sessionId === null ||
      binding.expectedSessionSeq === null
    ) {
      this.ephemeralState = setCoreDiagnostic(
        this.ephemeralState,
        "Plan decision requires an exact durable Goal and session snapshot.",
      );
      this.scheduleRender();
      return;
    }
    this.ephemeralState = openPlanDecisionDialog(this.ephemeralState, {
      action,
      currentApprovedRevision:
        this.viewState.taskState.currentApprovedPlan?.revision ?? null,
      expectedSessionSeq: binding.expectedSessionSeq,
      goalId: goal.content.goalId,
      goalObjective: goal.content.objective,
      goalRevision: goal.content.revision,
      items: plan.content.items.map((item) => ({
        acceptance: item.acceptance,
        itemId: item.id,
        required: item.required,
        title: item.title,
      })),
      planId: plan.content.planId,
      planSha256: plan.planSha256,
      reason,
      revision: plan.content.revision,
      sessionId: binding.sessionId,
    });
    this.scheduleRender();
  }

  private showCommandDiagnostic(message: string): void {
    this.ephemeralState = setCoreDiagnostic(this.ephemeralState, message);
    this.scheduleRender();
  }

  private async dispatchStart(
    intent: Phase16StartIntent,
    draftOnFailure?: string,
  ): Promise<boolean> {
    if (this.coordinator === null) return false;
    const baseline = this.currentSnapshot();
    this.ephemeralState = setCoreDiagnostic(
      setDraftInput(this.ephemeralState, ""),
      null,
    );
    this.scheduleRender();
    const result = await this.coordinator.dispatch(intent);
    const succeeded = result.status === "run_finished";
    const current = this.currentSnapshot();
    const noDurableCommit =
      baseline.sessionId === current.sessionId &&
      baseline.snapshotSeq === current.snapshotSeq;
    if (
      !succeeded &&
      draftOnFailure !== undefined &&
      (noDurableCommit || result.status === "busy" || result.status === "stale")
    ) {
      this.ephemeralState = setDraftInput(
        this.ephemeralState,
        draftOnFailure,
      );
    }
    this.renderCoordinatorResult(result);
    if (this.exitWhenIdle && this.coordinator.state.kind === "idle") {
      this.exitWhenIdle = false;
      this.finishApp(0);
    }
    return succeeded;
  }

  private async dispatchMutation(
    intent: Phase16MutationIntent,
  ): Promise<boolean> {
    if (this.coordinator === null) return false;
    const draft = this.ephemeralState.draftInput;
    this.ephemeralState = setDraftInput(this.ephemeralState, "");
    const result = await this.coordinator.dispatch(intent);
    const succeeded = result.status === "mutated";
    if (!succeeded) {
      this.ephemeralState = setDraftInput(this.ephemeralState, draft);
    }
    this.renderCoordinatorResult(result);
    return succeeded;
  }

  private renderCoordinatorResult(
    result: RunCoordinatorDispatchResult | undefined,
  ): void {
    if (result === undefined) return;
    switch (result.status) {
      case "busy":
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          "Run active — input kept locally; no message or queue item was created.",
        );
        break;
      case "stale":
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          "Session changed externally; view refreshed and the original intent was not rebound.",
        );
        break;
      case "failed":
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          `${result.code}: ${result.message}`,
        );
        break;
      case "fatal":
        this.ephemeralState = setCoreDiagnostic(
          this.ephemeralState,
          result.message,
        );
        void this.failFatal();
        break;
      case "exit_requested":
        this.finishApp(0);
        break;
      case "cancel_requested":
        break;
      case "mode_selected":
      case "mutated":
      case "refreshed":
      case "run_finished":
      case "selected":
        this.ephemeralState = setCoreDiagnostic(this.ephemeralState, null);
        break;
    }
    this.scheduleRender();
  }

  private applySnapshot(snapshot: readonly TuiPersistedEvent[]): void {
    this.viewState = createInitialTuiViewState();
    this.phase16Projector.reset();
    this.eventSnapshot.length = 0;
    this.options.source.resetWhileIdle({ snapshot });
  }

  private createCoordinator(snapshot: RunCoordinatorSnapshot): RunCoordinator {
    return new RunCoordinator({
      createIntentId: this.options.createIntentId ?? randomUUID,
      port: {
        mutate: async (intent) => {
          if (this.options.core.mutateIntent === undefined) {
            throw new RunCoordinatorPortError(
              "precondition_failed",
              "this TUI core does not support Phase 16 mutations",
            );
          }
          const result = await this.options.core.mutateIntent(intent);
          if (result.exitCode !== 0) {
            const diagnostic =
              result.diagnostic ??
              `task mutation failed (exit_code=${String(result.exitCode)})`;
            throw new RunCoordinatorPortError(
              diagnostic.includes("stale_snapshot")
                ? "stale_snapshot"
                : "precondition_failed",
              diagnostic,
              this.currentSnapshot(),
            );
          }
          return this.currentSnapshot();
        },
        refresh: async (sessionId) => {
          const events =
            sessionId === null
              ? []
              : await this.options.core.loadSession(sessionId);
          this.applySnapshot(events);
          return this.currentSnapshot();
        },
        start: async (intent, context) => {
          if (this.pendingRunStarted !== null) {
            throw new RunCoordinatorPortError(
              "fatal_invariant",
              "a run start acknowledgement is already pending",
            );
          }
          this.pendingRunStarted = context.onStarted;
          const cancel = (): void => this.options.core.cancelActiveRun();
          context.signal.addEventListener("abort", cancel, { once: true });
          const run =
            this.options.core.startIntent === undefined
              ? intent.type === "submit_idle_message" && intent.sessionId === null
                ? this.options.core.startTask(intent.text)
                : intent.type === "submit_idle_message" &&
                    intent.sessionId !== null
                  ? this.options.core.resumeSession(intent.sessionId, intent.text)
                  : Promise.resolve({
                      diagnostic: "Phase 16 start intent is unsupported",
                      exitCode: 2,
                    })
              : this.options.core.startIntent(
                  intent,
                  this.ephemeralState.selectedAgentMode,
                  this.ephemeralState.selectedAgentModeSource,
                );
          this.activeCoreRun = run;
          try {
            const result = await run;
            if (this.pendingRunStarted !== null) {
              this.pendingRunStarted = null;
              throw new RunCoordinatorPortError(
                result.diagnostic?.includes("stale_snapshot")
                  ? "stale_snapshot"
                  : "precondition_failed",
                result.diagnostic ??
                  `core exited before run.started (exit_code=${String(result.exitCode)})`,
                this.currentSnapshot(),
              );
            }
            return {
              exitCode: result.exitCode,
              snapshot: this.currentSnapshot(),
            };
          } finally {
            context.signal.removeEventListener("abort", cancel);
            if (this.activeCoreRun === run) this.activeCoreRun = null;
            this.pendingRunStarted = null;
          }
        },
      },
      snapshot,
    });
  }

  private async selectSession(sessionId: string): Promise<void> {
    const result = await this.coordinator?.dispatch({ sessionId, type: "select_session" });
    this.renderCoordinatorResult(result);
  }

  private async startCoreRun(
    run: () => Promise<TuiCoreRunResult>,
    draftOnPreSessionFailure?: string,
  ): Promise<void> {
    if (this.activeCoreRun !== null) return;
    const baselineSessionId = this.viewState.session.id;
    const baselineSessionSeq = this.viewState.session.lastSessionSeq;
    const promise = run();
    this.activeCoreRun = promise;
    try {
      const result = await promise;
      const durableEventObserved =
        this.viewState.session.id !== baselineSessionId ||
        this.viewState.session.lastSessionSeq > baselineSessionSeq;
      if (!durableEventObserved && result.exitCode !== 0) {
        // PHASE11: configuration/storage failures can happen before a session
        // exists, so no durable event can carry them. Keep the bounded message
        // explicitly ephemeral instead of silently clearing the user's draft.
        this.ephemeralState = setCoreDiagnostic(
          draftOnPreSessionFailure === undefined
            ? this.ephemeralState
            : setDraftInput(
                this.ephemeralState,
                draftOnPreSessionFailure,
              ),
          result.diagnostic ??
            `core exited before creating a session (exit_code=${result.exitCode})`,
        );
      }
    } catch {
      await this.failFatal();
    } finally {
      if (this.activeCoreRun === promise) this.activeCoreRun = null;
      if (this.exitWhenIdle) {
        this.exitWhenIdle = false;
        this.finishApp(0);
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
