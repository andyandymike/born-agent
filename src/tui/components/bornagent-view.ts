import {
  sliceByColumn,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "../terminal-sanitizer.js";
import type { TuiEphemeralState } from "../tui-ephemeral-state.js";
import type {
  TranscriptViewItem,
  TuiViewState,
} from "../tui-view-state.js";
import { renderGoalHeader } from "./goal-header.js";
import { renderOutcomeCard } from "./outcome-card.js";
import { renderPlanPanel } from "./plan-panel.js";
import { renderTodoList } from "./todo-list.js";
import { renderGraphPanel } from "./graph-panel.js";

const DEFAULT_TRANSCRIPT_VIEWPORT_ROWS = 16;
const MAX_TRANSCRIPT_VIEWPORT_ROWS = 100;

export interface BornAgentViewComponentOptions {
  readonly secrets?: readonly (string | undefined)[];
  readonly transcriptViewportRows?: number;
}

function normalizeViewportRows(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSCRIPT_VIEWPORT_ROWS;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("transcript viewport rows must be a positive integer");
  }
  return Math.min(value, MAX_TRANSCRIPT_VIEWPORT_ROWS);
}

function assertNever(value: never): never {
  throw new Error(`unsupported transcript item ${String(value)}`);
}

/**
 * A side-effect-free pi-tui component backed only by replayable and ephemeral
 * view state. It deliberately has no handleInput implementation: controllers
 * own intent parsing and authorization.
 */
export class BornAgentViewComponent implements Component {
  readonly #secrets: readonly (string | undefined)[];
  readonly #transcriptViewportRows: number;
  #ephemeral: TuiEphemeralState;
  #view: TuiViewState;

  constructor(
    view: TuiViewState,
    ephemeral: TuiEphemeralState,
    options: BornAgentViewComponentOptions = {},
  ) {
    this.#view = view;
    this.#ephemeral = ephemeral;
    this.#secrets = options.secrets ?? [];
    this.#transcriptViewportRows = normalizeViewportRows(
      options.transcriptViewportRows,
    );
  }

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    this.#view = view;
    this.#ephemeral = ephemeral;
  }

  invalidate(): void {
    // This component does not cache derived lines.
  }

  render(width: number): string[] {
    if (width <= 0) return [];

    // PHASE11: sanitize again at the final display boundary. Reducers sanitize
    // durable events too, but draft input and caller-built states are not facts.
    const phase16 =
      this.#view.taskState.trackingMode === "phase16"
        ? [
            ...renderGoalHeader(
              this.#view.taskState,
              this.#ephemeral.selectedAgentMode,
            ).map((line) => this.#line(line, width)),
            ...renderPlanPanel(this.#view.taskState).map((line) =>
              this.#line(line, width),
            ),
            ...renderTodoList(this.#view.taskState).map((line) =>
              this.#line(line, width),
            ),
            ...renderOutcomeCard(this.#view.outcomeReport).map((line) =>
              this.#line(line, width),
            ),
          ]
        : [];
    return [
      this.#line(this.#renderStatus(), width),
      ...(this.#view.run?.capabilitySnapshot === undefined
        ? []
        : [this.#line(this.#renderCapabilityStatus(), width)]),
      this.#line(this.#renderRepositoryStatus(), width),
      ...renderGraphPanel(this.#view).map((line) => this.#line(line, width)),
      ...phase16,
      ...this.#renderTranscript(width),
      ...this.#renderPlanDecision(width),
      ...this.#renderApproval(width),
      ...this.#renderDiagnostic(width),
      ...this.#renderInput(width),
    ];
  }

  #line(value: string, width: number): string {
    const sanitized = sanitizeTerminalText(value, { secrets: this.#secrets })
      .replaceAll("\n", " ↵ ");
    if (visibleWidth(sanitized) <= width) return sanitized;
    if (width === 1) return "…";
    return `${sliceByColumn(sanitized, 0, width - 1, true)}…`;
  }

  #renderStatus(): string {
    const { context, run, session } = this.#view;
    const runLabel =
      run === null
        ? "idle"
        : `${run.status}:policy=${run.policyProfile ?? "legacy-unrecorded"}/${run.policyMode ?? "legacy_unrecorded"}:${run.provider}/${run.model}:${run.taskProfile}:${run.executionEnvironment ?? "local; isolation=none"}`;
    const blocked =
      session.actionBlocked || this.#ephemeral.sessionBusy ? " blocked" : "";
    const compacting = context.compacting ? " compacting" : "";
    return (
      `STATUS | session=${session.id ?? "none"} | run=${runLabel}` +
      ` | context=${context.estimatedInputTokens ?? "?"}@${context.epoch}` +
      `${compacting}${blocked}`
    );
  }

  #renderRepositoryStatus(): string {
    const repository = this.#view.repository;
    const phase = repository.buildPhase === null ? "" : `:${repository.buildPhase}`;
    return `REPO | engine=${repository.engineId ?? "none"} | gen=${repository.generationSha256?.slice(0, 8) ?? "none"} | coverage=${repository.coverage ?? "none"} | index=${repository.indexState}${phase}`;
  }

  #renderCapabilityStatus(): string {
    const frozen = this.#view.run?.capabilitySnapshot;
    if (frozen === undefined) throw new Error("capability status requires a frozen run snapshot");
    return `CAPABILITIES | current-run=frozen | plugins=${String(frozen.eligiblePluginCount)} | components=${String(frozen.componentCount)} | enablement-rev=${String(frozen.enablementRevision)} | snapshot=${frozen.snapshotId.slice(0, 28)}...`;
  }

  #renderTranscript(width: number): string[] {
    const items = this.#view.transcript;
    const offset = Math.min(this.#ephemeral.scrollOffset, items.length);
    const end = Math.max(0, items.length - offset);
    const start = Math.max(0, end - this.#transcriptViewportRows);
    const visibleItems = items.slice(start, end);
    const range =
      items.length === 0 ? "empty" : `${start + 1}-${end}/${items.length}`;

    return [
      this.#line(`TRANSCRIPT | ${range}`, width),
      ...visibleItems.map((item) =>
        this.#line(this.#renderTranscriptItem(item), width),
      ),
    ];
  }

  #renderTranscriptItem(item: TranscriptViewItem): string {
    switch (item.kind) {
      case "user":
        return `[user] ${item.text}`;
      case "model":
        return `[model:${item.status}:${item.visibility}] ${item.text}`;
      case "tool":
        return (
          `[tool:${item.status}] ${item.toolName}` +
          `${item.output.length > 0 ? ` -> ${item.output}` : ""}` +
          `${item.truncated ? " [truncated]" : ""}`
        );
      case "patch":
        return (
          `[patch:${item.status}] +${item.addedLines} -${item.removedLines}` +
          ` ${item.preview}${item.truncated ? " [truncated]" : ""}`
        );
      case "command":
        return (
          `[command:${item.status}] ${item.bytes}B ${item.output}` +
          `${item.termination === null ? "" : ` (${item.termination})`}` +
          `${item.truncated ? " [truncated]" : ""}`
        );
      case "verification":
        return (
          `[verification:${item.status}] generation=${item.generation}` +
          `${item.stale ? " stale" : ""}`
        );
      case "completion":
        return (
          `[completion:${item.status}] ${item.summary}` +
          `${item.reasons.length === 0 ? "" : ` (${item.reasons.join(", ")})`}`
        );
      case "context":
        return `[context] ${item.label}`;
      case "artifact":
        return `[artifact:${item.status}] ${item.bytes}B ${item.artifactId ?? "none"}`;
      case "session":
        return `[session] ${item.label}`;
      case "approval":
        return `[approval:${item.status}] ${item.actionKind} ${item.requestId}`;
      case "unsupported":
        return `[unsupported] ${item.eventType}`;
      default:
        return assertNever(item);
    }
  }

  #renderApproval(width: number): string[] {
    const approval = this.#view.approval;
    if (
      approval === null ||
      approval.expiresState.status !== "active" ||
      (this.#view.session.actionBlocked || this.#ephemeral.sessionBusy)
    ) {
      return [
        this.#line("APPROVAL | no active request", width),
        this.#line("[DENY]  allow (default deny)", width),
      ];
    }

    const allowFocused =
      this.#ephemeral.approvalRequestId === approval.requestId &&
      this.#ephemeral.approvalFocus === "allow";
    const decisionLine = allowFocused
      ? "deny  [ALLOW]"
      : "[DENY]  allow (default deny)";
    return [
      this.#line(
        `APPROVAL | ${approval.actionKind} | request=${approval.requestId}`,
        width,
      ),
      this.#line(`preview: ${approval.preview}`, width),
      this.#line(decisionLine, width),
    ];
  }

  #renderPlanDecision(width: number): string[] {
    const dialog = this.#ephemeral.planDecisionDialog;
    if (dialog === null) return [];
    const action =
      dialog.action === "approve_build"
        ? "APPROVE & BUILD"
        : dialog.action.toUpperCase();
    const stale =
      this.#view.session.id !== dialog.sessionId ||
      this.#view.session.lastSessionSeq !== dialog.expectedSessionSeq ||
      this.#ephemeral.sessionBusy;
    const confirmFocused =
      this.#ephemeral.planDecisionFocus === "confirm";
    return [
      this.#line(`PLAN DECISION | ${action}${stale ? " | STALE" : ""}`, width),
      this.#line(
        `session=${dialog.sessionId} seq=${String(dialog.expectedSessionSeq)}`,
        width,
      ),
      this.#line(
        `goal=${dialog.goalId}@${String(dialog.goalRevision)} | ${dialog.goalObjective}`,
        width,
      ),
      this.#line(
        `plan=${dialog.planId}@${String(dialog.revision)} | sha256=${dialog.planSha256}`,
        width,
      ),
      this.#line(
        `replaces approved revision=${dialog.currentApprovedRevision === null ? "none" : String(dialog.currentApprovedRevision)}`,
        width,
      ),
      ...dialog.items.flatMap((item, index) => [
        this.#line(
          `${String(index + 1)}. [${item.required ? "required" : "optional"}] ${item.itemId}: ${item.title}`,
          width,
        ),
        this.#line(`   acceptance: ${item.acceptance}`, width),
      ]),
      ...(dialog.reason === null
        ? []
        : [this.#line(`reason: ${dialog.reason}`, width)]),
      this.#line(
        "WARNING | Plan approval does not approve patches, commands, MCP calls, or completion.",
        width,
      ),
      this.#line(
        stale
          ? "[CANCEL]  confirm disabled by stale identity"
          : confirmFocused
            ? "cancel  [CONFIRM]"
            : "[CANCEL]  confirm (default cancel)",
        width,
      ),
    ];
  }

  #renderInput(width: number): string[] {
    const blocked =
      this.#view.session.actionBlocked || this.#ephemeral.sessionBusy
        ? " | blocked"
        : "";
    return [
      this.#line(`INPUT${blocked}`, width),
      this.#line(`> ${this.#ephemeral.draftInput}`, width),
    ];
  }

  #renderDiagnostic(width: number): string[] {
    return this.#ephemeral.coreDiagnostic === null
      ? []
      : [
          this.#line(
            `DIAGNOSTIC | ${this.#ephemeral.coreDiagnostic}`,
            width,
          ),
        ];
  }
}
