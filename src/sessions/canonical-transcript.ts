import { assertDecodedStoredEventInvariants } from "../events/event-decoder-registry.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";

export interface UserTextTranscriptItem {
  readonly kind: "user_text";
  readonly runId: string | null;
  readonly sessionSeq: number;
  readonly source: "resume_request" | "run_started";
  readonly text: string;
}

export interface AssistantTextTranscriptItem {
  readonly firstSessionSeq: number;
  readonly kind: "assistant_text";
  readonly lastSessionSeq: number;
  readonly runId: string;
  readonly text: string;
  readonly visibility: "internal_candidate" | "user_visible";
}

export interface ToolCallFactTranscriptItem {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly kind: "tool_call";
  readonly runId: string;
  readonly sessionSeq: number;
  readonly step: number;
  readonly toolName: string;
}

export interface ToolObservationFactTranscriptItem {
  readonly callId: string;
  readonly kind: "tool_observation";
  readonly output: string;
  readonly recovered: boolean;
  readonly runId: string;
  readonly sessionSeq: number;
  readonly sourceRunId?: string;
  readonly status: "error" | "success";
  readonly step: number;
  readonly toolName: string;
  readonly truncated: boolean;
}

export interface ChangeFactTranscriptItem {
  readonly addedLines: number;
  readonly files: readonly {
    readonly kind: "create" | "modify";
    readonly path: string;
    readonly postSha256: string;
    readonly preSha256: string | null;
  }[];
  readonly journalSha256: string;
  readonly kind: "change";
  readonly removedLines: number;
  readonly runId: string;
  readonly sessionSeq: number;
}

export interface VerificationFactTranscriptItem {
  readonly exitCode: number | null;
  readonly kind: "verification";
  readonly runId: string;
  readonly sessionSeq: number;
  readonly stale: boolean;
  readonly status: "failed" | "passed" | "stale";
  readonly verificationId: string;
}

export type CompletionFactTranscriptItem =
  | {
      readonly candidateSha256: string;
      readonly final: false;
      readonly kind: "completion";
      readonly phase: "candidate";
      readonly runId: string;
      readonly sessionSeq: number;
      readonly status: "blocked" | "completed";
      readonly summary: string;
    }
  | {
      readonly effect: "accept" | "continue" | "error" | "incomplete";
      readonly final: false;
      readonly kind: "completion";
      readonly phase: "evaluated";
      readonly reasons: readonly string[];
      readonly runId: string;
      readonly sessionSeq: number;
    }
  | {
      readonly final: boolean;
      readonly kind: "completion";
      readonly outcome:
        | "budget_exceeded"
        | "cancelled"
        | "completed"
        | "failed"
        | "incomplete";
      readonly phase: "terminal";
      readonly runId: string;
      readonly sessionSeq: number;
    };

export type CanonicalTranscriptItem =
  | AssistantTextTranscriptItem
  | ChangeFactTranscriptItem
  | CompletionFactTranscriptItem
  | ToolCallFactTranscriptItem
  | ToolObservationFactTranscriptItem
  | UserTextTranscriptItem
  | VerificationFactTranscriptItem;

export type CanonicalTranscript = readonly CanonicalTranscriptItem[];

interface PendingAssistantText {
  firstSessionSeq: number;
  lastSessionSeq: number;
  runId: string;
  text: string;
  visibility: "internal_candidate" | "user_visible";
}

function terminalOutcome(
  type:
    | "run.budget_exceeded"
    | "run.cancelled"
    | "run.completed"
    | "run.failed"
    | "run.incomplete",
): CompletionFactTranscriptItem & { phase: "terminal" } {
  const outcome = type.slice("run.".length) as
    | "budget_exceeded"
    | "cancelled"
    | "completed"
    | "failed"
    | "incomplete";
  return {
    final: type === "run.completed",
    kind: "completion",
    outcome,
    phase: "terminal",
    runId: "",
    sessionSeq: 0,
  };
}

export function buildCanonicalTranscript(
  events: readonly DecodedStoredEvent[],
): CanonicalTranscript {
  assertDecodedStoredEventInvariants(events);
  const transcript: CanonicalTranscriptItem[] = [];
  let pendingAssistant: PendingAssistantText | undefined;

  const flushAssistant = (): void => {
    if (pendingAssistant === undefined) return;
    transcript.push({
      firstSessionSeq: pendingAssistant.firstSessionSeq,
      kind: "assistant_text",
      lastSessionSeq: pendingAssistant.lastSessionSeq,
      runId: pendingAssistant.runId,
      text: pendingAssistant.text,
      visibility: pendingAssistant.visibility,
    });
    pendingAssistant = undefined;
  };

  for (const event of events) {
    if (event.type === "text.delta") {
      const visibility =
        event.data.visibility === "internal_candidate"
          ? "internal_candidate"
          : "user_visible";
      if (
        pendingAssistant !== undefined &&
        pendingAssistant.runId === event.runId &&
        pendingAssistant.visibility === visibility
      ) {
        pendingAssistant.text += event.data.delta;
        pendingAssistant.lastSessionSeq = event.sessionSeq;
      } else {
        flushAssistant();
        pendingAssistant = {
          firstSessionSeq: event.sessionSeq,
          lastSessionSeq: event.sessionSeq,
          runId: event.runId,
          text: event.data.delta,
          visibility,
        };
      }
      continue;
    }
    flushAssistant();

    switch (event.type) {
      case "run.started":
        if (event.data.resume_of_run_id === undefined) {
          transcript.push({
            kind: "user_text",
            runId: event.runId,
            sessionSeq: event.sessionSeq,
            source: "run_started",
            text: event.data.input.text,
          });
        }
        break;
      case "session.resume.requested":
        if (event.data.message !== undefined) {
          transcript.push({
            kind: "user_text",
            runId: null,
            sessionSeq: event.sessionSeq,
            source: "resume_request",
            text: event.data.message,
          });
        }
        break;
      case "tool.call.requested":
        transcript.push({
          argumentsJson: event.data.arguments_json,
          callId: event.data.call_id,
          kind: "tool_call",
          runId: event.runId,
          sessionSeq: event.sessionSeq,
          step: event.data.step,
          toolName: event.data.tool_name,
        });
        break;
      case "tool.call.completed":
        transcript.push({
          callId: event.data.call_id,
          kind: "tool_observation",
          output: event.data.output,
          recovered: false,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
          status: event.data.status,
          step: event.data.step,
          toolName: event.data.tool_name,
          truncated: event.data.truncated,
        });
        break;
      case "tool.call.recovered":
        transcript.push({
          callId: event.data.call_id,
          kind: "tool_observation",
          output: event.data.output,
          recovered: true,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
          sourceRunId: event.data.source_run_id,
          status: event.data.status,
          step: event.data.step,
          toolName: event.data.tool_name,
          truncated: event.data.truncated,
        });
        break;
      case "patch.apply.completed":
        transcript.push({
          addedLines: event.data.added_lines,
          files: event.data.files.map((file) => ({
            kind: file.kind,
            path: file.path,
            postSha256: file.post_sha256,
            preSha256: file.pre_sha256,
          })),
          journalSha256: event.data.journal_sha256,
          kind: "change",
          removedLines: event.data.removed_lines,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
        });
        break;
      case "verification.completed":
        transcript.push({
          exitCode: event.data.exit_code,
          kind: "verification",
          runId: event.runId,
          sessionSeq: event.sessionSeq,
          stale: event.data.stale,
          status: event.data.status,
          verificationId: event.data.verification_id,
        });
        break;
      case "completion.candidate":
        // PHASE9: a finish_task proposal remains an internal candidate. Replay
        // cannot promote it to final just because the original process ended.
        transcript.push({
          candidateSha256: event.data.candidate_sha256,
          final: false,
          kind: "completion",
          phase: "candidate",
          runId: event.runId,
          sessionSeq: event.sessionSeq,
          status: event.data.status,
          summary: event.data.summary,
        });
        break;
      case "completion.evaluated":
        transcript.push({
          effect: event.data.effect,
          final: false,
          kind: "completion",
          phase: "evaluated",
          reasons: event.data.reasons,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
        });
        break;
      case "run.budget_exceeded":
      case "run.cancelled":
      case "run.completed":
      case "run.failed":
      case "run.incomplete": {
        const terminal = terminalOutcome(event.type);
        transcript.push({
          ...terminal,
          runId: event.runId,
          sessionSeq: event.sessionSeq,
        });
        break;
      }
      default:
        break;
    }
  }
  flushAssistant();
  return transcript;
}
