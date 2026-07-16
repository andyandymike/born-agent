import { describe, expect, it } from "vitest";

import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import {
  reconstructMultiRunSession,
  SessionProjectionError,
} from "../../src/sessions/reconstruct-multi-run-session.js";

const SESSION = "00000000-0000-4000-8000-000000009601";
const RUN_1 = "00000000-0000-4000-8000-000000009611";
const RUN_2 = "00000000-0000-4000-8000-000000009612";
const V2_ONLY_RUN = "00000000-0000-4000-8000-000000009613";
const UNKNOWN_RUN = "00000000-0000-4000-8000-000000009699";
const TIME = "2026-07-17T00:00:00.000Z";

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function startData(extra: Record<string, unknown> = {}): unknown {
  return {
    command: "chat",
    input: { role: "user", text: "continue safely" },
    model: "fake-model",
    provider: "fake",
    timeout_ms: 1_000,
    workspace: "D:\\Code\\bornagent",
    ...extra,
  };
}

function v1Start(): unknown {
  return {
    data: startData(),
    event_id: uuid(9_620),
    run_id: RUN_1,
    schema_version: 1,
    seq: 1,
    session_id: SESSION,
    timestamp: TIME,
    type: "run.started",
  };
}

function sessionResume(sourceRunId = RUN_1): unknown {
  return {
    data: { requested_mode: "exact", source_run_id: sourceRunId },
    event_id: uuid(9_621),
    schema_version: 2,
    scope: "session",
    session_id: SESSION,
    session_seq: 2,
    timestamp: TIME,
    type: "session.resume.requested",
  };
}

function resumedStart(
  extra: Record<string, unknown> = {
    resume_mode: "exact",
    resume_of_run_id: RUN_1,
  },
): unknown {
  return {
    data: startData(extra),
    event_id: uuid(9_622),
    run_id: RUN_2,
    run_seq: 1,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: 3,
    timestamp: TIME,
    type: "run.started",
  };
}

function completed(): unknown {
  return {
    data: { duration_ms: 5, output_chars: 0 },
    event_id: uuid(9_624),
    run_id: RUN_2,
    run_seq: 3,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: 5,
    timestamp: TIME,
    type: "run.completed",
  };
}

function backendSelected(): unknown {
  return {
    data: {
      adapter: "fake-adapter",
      adapter_version: "1.0.0",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "none",
        usage: "complete",
      },
      config_fingerprint: "a".repeat(64),
      model: "fake-model",
      provider: "fake",
      resume_capability: "canonical_only",
    },
    event_id: uuid(9_623),
    run_id: RUN_2,
    run_seq: 2,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: 4,
    timestamp: TIME,
    type: "backend.selected",
  };
}

function v2OnlyEvent(
  sequence: number,
  type: string,
  data: unknown,
): unknown {
  return {
    data,
    event_id: uuid(9_800 + sequence),
    run_id: V2_ONLY_RUN,
    run_seq: sequence,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: sequence,
    timestamp: TIME,
    type,
  };
}

function v2OnlyStart(): unknown {
  return v2OnlyEvent(1, "run.started", startData());
}

function v2OnlyBackend(): unknown {
  return v2OnlyEvent(2, "backend.selected", {
    adapter: "fake-adapter",
    adapter_version: "1.0.0",
    capabilities: {
      cancellation: "abort_signal",
      reasoning: "none",
      streaming: true,
      tools: "none",
      usage: "complete",
    },
    config_fingerprint: "b".repeat(64),
    model: "fake-model",
    provider: "fake",
    resume_capability: "canonical_only",
  });
}

function failed(sequence: number): unknown {
  return v2OnlyEvent(sequence, "run.failed", {
    category: "internal",
    code: "fixture_failure",
    duration_ms: 1,
    message: "fixture terminal",
    retryable: false,
  });
}

describe("Phase 9 multi-run session reconstruction", () => {
  it("projects an unterminated old run as interrupted and keeps the new terminal factual", () => {
    const events = decodeStoredEvents([
      v1Start(),
      sessionResume(),
      resumedStart(),
      backendSelected(),
      completed(),
    ]);

    const session = reconstructMultiRunSession(events);

    expect(session).toMatchObject({
      lastRun: { runId: RUN_2, status: "completed" },
      sessionId: SESSION,
      status: "completed",
    });
    expect(session.runs).toHaveLength(2);
    expect(session.runs[0]).toMatchObject({
      endSessionSeq: 1,
      runId: RUN_1,
      status: "interrupted",
    });
    expect(session.runs[0]?.terminal).toBeUndefined();
    expect(session.runs[1]).toMatchObject({
      resumeMode: "exact",
      resumeOfRunId: RUN_1,
      runId: RUN_2,
      status: "completed",
      terminal: { type: "run.completed" },
    });
    expect(session.sessionEvents).toMatchObject([
      { type: "session.resume.requested" },
    ]);
  });

  it("requires every later run to identify an earlier run", () => {
    const missingMetadata = decodeStoredEvents([
      v1Start(),
      sessionResume(),
      resumedStart({}),
      backendSelected(),
      completed(),
    ]);
    expect(() => reconstructMultiRunSession(missingMetadata)).toThrow(
      "every later run must declare",
    );

    const unknownReference = decodeStoredEvents([
      v1Start(),
      sessionResume(),
      resumedStart({
        resume_mode: "exact",
        resume_of_run_id: UNKNOWN_RUN,
      }),
      backendSelected(),
      completed(),
    ]);
    expect(() => reconstructMultiRunSession(unknownReference)).toThrow(
      SessionProjectionError,
    );
    expect(() => reconstructMultiRunSession(unknownReference)).toThrow(
      "unknown resume source",
    );
  });

  it("rejects a session-scoped recovery fact that references an unseen run", () => {
    const events = decodeStoredEvents([v1Start(), sessionResume(UNKNOWN_RUN)]);
    expect(() => reconstructMultiRunSession(events)).toThrow(
      "references unknown source run",
    );
  });

  it.each([
    {
      expected: "command completion does not match",
      name: "isolated command.completed",
      payload: {
        action_sha256: "c".repeat(64),
        call_id: "call_command",
        cleanup_verified: true,
        duration_ms: 1,
        execution_id: uuid(9_850),
        executor: "local",
        exit_code: 0,
        signal: null,
        stderr_bytes: 0,
        stdout_bytes: 0,
        step: 1,
        termination: "exit",
        total_bytes: 0,
        truncated: false,
      },
      type: "command.completed",
    },
    {
      expected: "patch completion does not match",
      name: "isolated patch.apply.completed",
      payload: {
        added_lines: 1,
        approval_request_id: uuid(9_851),
        call_id: "call_patch",
        duration_ms: 1,
        files: [
          {
            kind: "modify",
            path: "src/a.ts",
            post_sha256: "d".repeat(64),
            pre_sha256: "e".repeat(64),
          },
        ],
        journal_sha256: "f".repeat(64),
        plan_id: "1".repeat(64),
        removed_lines: 1,
        step: 1,
      },
      type: "patch.apply.completed",
    },
  ])("rejects malicious v2 $name despite valid envelopes", ({ expected, payload, type }) => {
    const decoded = decodeStoredEvents([
      v2OnlyStart(),
      v2OnlyBackend(),
      v2OnlyEvent(3, type, payload),
      failed(4),
    ]);
    expect(() => reconstructMultiRunSession(decoded)).toThrow(expected);
  });

  it("accepts a semantically valid interrupted v2 prefix without inventing a terminal", () => {
    const decoded = decodeStoredEvents([
      v2OnlyStart(),
      v2OnlyBackend(),
      v2OnlyEvent(3, "tool.call.requested", {
        arguments_json: "{}",
        call_id: "call_read",
        step: 1,
        tool_name: "read_file",
      }),
    ]);
    const projection = reconstructMultiRunSession(decoded);
    expect(projection.lastRun).toMatchObject({
      runId: V2_ONLY_RUN,
      status: "interrupted",
    });
    expect(projection.lastRun.terminal).toBeUndefined();
    expect(projection.events.map((event) => event.type)).not.toContain(
      "run.failed",
    );
  });

  it("keeps the legacy v1 no-backend contract while rejecting that shape for active v2", () => {
    const legacy = decodeStoredEvents([
      v1Start(),
      {
        data: { delta: "ok" },
        event_id: uuid(9_860),
        run_id: RUN_1,
        schema_version: 1,
        seq: 2,
        session_id: SESSION,
        timestamp: TIME,
        type: "text.delta",
      },
      {
        data: { duration_ms: 1, output_chars: 2 },
        event_id: uuid(9_861),
        run_id: RUN_1,
        schema_version: 1,
        seq: 3,
        session_id: SESSION,
        timestamp: TIME,
        type: "run.completed",
      },
    ]);
    expect(reconstructMultiRunSession(legacy).status).toBe("completed");

    const v2WithoutSelection = decodeStoredEvents([
      v2OnlyStart(),
      v2OnlyEvent(2, "text.delta", { delta: "unsafe legacy disguise" }),
      v2OnlyEvent(3, "run.completed", {
        duration_ms: 1,
        output_chars: 22,
      }),
    ]);
    expect(() => reconstructMultiRunSession(v2WithoutSelection)).toThrow(
      "backend.selected must immediately follow",
    );
  });
});
