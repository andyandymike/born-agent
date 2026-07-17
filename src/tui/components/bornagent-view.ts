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
    return [
      this.#line(this.#renderStatus(), width),
      ...this.#renderTranscript(width),
      ...this.#renderApproval(width),
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
        : `${run.status}:${run.provider}/${run.model}:${run.taskProfile}`;
    const blocked = session.actionBlocked ? " blocked" : "";
    const compacting = context.compacting ? " compacting" : "";
    return (
      `STATUS | session=${session.id ?? "none"} | run=${runLabel}` +
      ` | context=${context.estimatedInputTokens ?? "?"}@${context.epoch}` +
      `${compacting}${blocked}`
    );
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
      this.#view.session.actionBlocked
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

  #renderInput(width: number): string[] {
    const blocked = this.#view.session.actionBlocked ? " | blocked" : "";
    return [
      this.#line(`INPUT${blocked}`, width),
      this.#line(`> ${this.#ephemeral.draftInput}`, width),
    ];
  }
}
