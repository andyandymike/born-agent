import { describe, expect, it } from "vitest";

import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import { buildCanonicalTranscript } from "../../src/sessions/canonical-transcript.js";

const SESSION = "00000000-0000-4000-8000-000000009701";
const RUN = "00000000-0000-4000-8000-000000009711";
const TIME = "2026-07-17T00:00:00.000Z";

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function event(
  sessionSeq: number,
  type: string,
  data: unknown,
): unknown {
  return {
    data,
    event_id: uuid(9_720 + sessionSeq),
    run_id: RUN,
    run_seq: sessionSeq,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
  };
}

describe("Phase 9 canonical transcript", () => {
  it("keeps candidate text internal, omits reasoning, and replays bounded facts", () => {
    const events = decodeStoredEvents([
      event(1, "run.started", {
        command: "chat",
        input: { role: "user", text: "make the safe change" },
        model: "fake-model",
        provider: "fake",
        timeout_ms: 1_000,
        workspace: "D:\\Code\\bornagent",
      }),
      event(2, "text.delta", {
        delta: "candidate ",
        visibility: "internal_candidate",
      }),
      event(3, "text.delta", {
        delta: "only",
        visibility: "internal_candidate",
      }),
      event(4, "text.delta", { delta: "visible answer", visibility: "user" }),
      event(5, "tool.call.requested", {
        arguments_json: '{"path":"src/a.ts"}',
        call_id: "call_read",
        step: 1,
        tool_name: "read_file",
      }),
      event(6, "tool.call.completed", {
        call_id: "call_read",
        duration_ms: 1,
        output: '{"ok":true,"content":"bounded"}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      }),
      event(7, "patch.apply.completed", {
        added_lines: 1,
        approval_request_id: uuid(9_780),
        call_id: "call_patch",
        duration_ms: 2,
        files: [
          {
            kind: "modify",
            path: "src/a.ts",
            post_sha256: "b".repeat(64),
            pre_sha256: "a".repeat(64),
          },
        ],
        journal_sha256: "c".repeat(64),
        plan_id: "d".repeat(64),
        removed_lines: 1,
        step: 1,
      }),
      event(8, "verification.completed", {
        action_sha256: "e".repeat(64),
        after_snapshot_sha256: "f".repeat(64),
        before_snapshot_sha256: "f".repeat(64),
        call_id: "call_verify",
        command_execution_id: uuid(9_781),
        completed_generation: 1,
        duration_ms: 3,
        exit_code: 0,
        stale: false,
        stale_reasons: [],
        started_generation: 1,
        status: "passed",
        step: 1,
        verification_id: uuid(9_782),
      }),
      event(9, "completion.candidate", {
        call_id: "call_finish",
        candidate_sha256: "1".repeat(64),
        status: "completed",
        step: 1,
        summary: "candidate summary is not final",
      }),
      event(10, "completion.evaluated", {
        call_id: "call_finish",
        candidate_sha256: "1".repeat(64),
        changed_paths: [],
        effect: "error",
        error_code: "completion_evaluation_failed",
        reasons: [],
        step: 1,
        verification_ids: [],
      }),
      event(11, "run.completed", { duration_ms: 5, output_chars: 14 }),
    ]);

    const transcript = buildCanonicalTranscript(events);

    expect(transcript).toContainEqual(
      expect.objectContaining({
        kind: "assistant_text",
        text: "candidate only",
        visibility: "internal_candidate",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        kind: "assistant_text",
        text: "visible answer",
        visibility: "user_visible",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        final: false,
        kind: "completion",
        phase: "candidate",
        summary: "candidate summary is not final",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        final: true,
        kind: "completion",
        outcome: "completed",
        phase: "terminal",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        kind: "tool_observation",
        output: '{"ok":true,"content":"bounded"}',
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        files: [expect.objectContaining({ path: "src/a.ts" })],
        kind: "change",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: "verification", status: "passed" }),
    );
    expect(
      transcript.every((item) => !Object.hasOwn(item, "reasoning")),
    ).toBe(true);
  });
});
