import { describe, expect, it } from "vitest";

import {
  decodeStoredEvents,
  EventDecoderRegistry,
  StoredEventDecodeError,
} from "../../src/events/event-decoder-registry.js";

const SESSION = "00000000-0000-4000-8000-000000009001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000009002";
const RUN_1 = "00000000-0000-4000-8000-000000009101";
const RUN_2 = "00000000-0000-4000-8000-000000009102";
const TIME = "2026-07-17T00:00:00.000Z";

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function chatStartData(extra: Record<string, unknown> = {}): unknown {
  return {
    command: "chat",
    input: { role: "user", text: "inspect the workspace" },
    model: "fake-model",
    provider: "fake",
    timeout_ms: 1_000,
    workspace: "D:\\Code\\bornagent",
    ...extra,
  };
}

function v1RunEvent(
  seq: number,
  type: string,
  data: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data,
    event_id: uuid(9_200 + seq),
    run_id: RUN_1,
    schema_version: 1,
    seq,
    session_id: SESSION,
    timestamp: TIME,
    type,
    ...overrides,
  };
}

function v2RunEvent(
  sessionSeq: number,
  runSeq: number,
  type: string,
  data: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data,
    event_id: uuid(9_300 + sessionSeq),
    run_id: RUN_2,
    run_seq: runSeq,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
    ...overrides,
  };
}

function v2SessionEvent(
  sessionSeq: number,
  type: string,
  data: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data,
    event_id: uuid(9_400 + sessionSeq),
    schema_version: 2,
    scope: "session",
    session_id: SESSION,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
    ...overrides,
  };
}

describe("Phase 9 event decoder registry", () => {
  it("strictly upcasts v1 then v2 while synthesizing v1 session sequence", () => {
    const values = [
      v1RunEvent(1, "run.started", chatStartData()),
      v2SessionEvent(2, "session.resume.requested", {
        requested_mode: "exact",
        source_run_id: RUN_1,
      }),
      v2RunEvent(
        3,
        1,
        "run.started",
        chatStartData({ resume_mode: "exact", resume_of_run_id: RUN_1 }),
      ),
      v2RunEvent(4, 2, "run.completed", {
        duration_ms: 10,
        output_chars: 0,
      }),
    ];

    const decoded = decodeStoredEvents(values);

    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toMatchObject({
      runId: RUN_1,
      runSeq: 1,
      sessionSeq: 1,
      sourceSchemaVersion: 1,
      type: "run.started",
    });
    expect(decoded[1]).toMatchObject({
      scope: "session",
      sessionSeq: 2,
      type: "session.resume.requested",
    });
    expect(decoded[2]).toMatchObject({
      data: { resume_mode: "exact", resume_of_run_id: RUN_1 },
      runId: RUN_2,
      runSeq: 1,
      sessionSeq: 3,
      sourceSchemaVersion: 2,
    });
  });

  it("registers strict Phase 9 run and session event data decoders", () => {
    const values = [
      v2RunEvent(1, 1, "run.started", chatStartData()),
      v2RunEvent(2, 2, "backend.checkpoint.created", {
        adapter: "fake-adapter",
        adapter_version: "1.0.0",
        bytes: 42,
        checkpoint_id: uuid(9_500),
        codec_version: "fake-v1",
        model: "fake-model",
        provider: "fake",
        ref: `.bornagent/checkpoints/${SESSION}/${uuid(9_500)}.bin`,
        sha256: "a".repeat(64),
        turn: 1,
      }),
      v2RunEvent(3, 3, "run.cancelled", {
        duration_ms: 2,
        reason: "user",
      }),
      v2SessionEvent(4, "session.tail.recovered", {
        backup_ref: `.bornagent/sessions/${SESSION}.jsonl.corrupt.1`,
        discarded_bytes: 7,
        original_sha256: "b".repeat(64),
        repair: "removed_incomplete_tail",
        repaired_sha256: "c".repeat(64),
      }),
    ];

    expect(new EventDecoderRegistry().decodeAll(values)).toMatchObject([
      { type: "run.started" },
      { data: { bytes: 42 }, type: "backend.checkpoint.created" },
      { type: "run.cancelled" },
      { data: { discarded_bytes: 7 }, type: "session.tail.recovered" },
    ]);

    const invalid = structuredClone(values);
    (invalid[1] as { data: Record<string, unknown> }).data.secret = "nope";
    expect(() => decodeStoredEvents(invalid)).toThrow(StoredEventDecodeError);
  });

  it.each([
    {
      code: "unsupported_schema",
      name: "future schema",
      values: [
        {
          ...v2RunEvent(1, 1, "run.started", chatStartData()),
          schema_version: 3,
        },
      ],
    },
    {
      code: "unknown_event_type",
      name: "unknown type",
      values: [v2SessionEvent(1, "session.future.fact", {})],
    },
    {
      code: "invalid_scope",
      name: "wrong scope",
      values: [
        v2RunEvent(1, 1, "session.resume.requested", {
          requested_mode: "exact",
          source_run_id: RUN_1,
        }),
      ],
    },
  ])("fails closed for $name", ({ code, values }) => {
    expect.assertions(1);
    try {
      decodeStoredEvents(values);
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it.each([
    {
      code: "duplicate_event_id",
      name: "duplicate event_id",
      values: [
        v1RunEvent(1, "run.started", chatStartData()),
        v1RunEvent(2, "run.cancelled", { duration_ms: 1, reason: "user" }, {
          event_id: uuid(9_201),
        }),
      ],
    },
    {
      code: "session_mismatch",
      name: "session mismatch",
      values: [
        v1RunEvent(1, "run.started", chatStartData()),
        v1RunEvent(2, "run.cancelled", { duration_ms: 1, reason: "user" }, {
          session_id: OTHER_SESSION,
        }),
      ],
    },
    {
      code: "session_sequence",
      name: "session sequence gap",
      values: [v2RunEvent(2, 1, "run.started", chatStartData())],
    },
    {
      code: "run_sequence",
      name: "run sequence gap",
      values: [v2RunEvent(1, 2, "run.started", chatStartData())],
    },
    {
      code: "event_after_terminal",
      name: "event after terminal",
      values: [
        v1RunEvent(1, "run.started", chatStartData()),
        v1RunEvent(2, "run.completed", { duration_ms: 1, output_chars: 0 }),
        v1RunEvent(3, "text.delta", { delta: "late" }),
      ],
    },
    {
      code: "v1_after_v2",
      name: "v1 after v2",
      values: [
        v2RunEvent(1, 1, "run.started", chatStartData()),
        v1RunEvent(2, "run.cancelled", { duration_ms: 1, reason: "user" }),
      ],
    },
  ])("rejects $name", ({ code, values }) => {
    expect.assertions(1);
    try {
      decodeStoredEvents(values);
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it("rejects extra v1 envelope and v2 data properties", () => {
    expect(() =>
      decodeStoredEvents([
        v1RunEvent(1, "run.started", chatStartData(), { extra: true }),
      ]),
    ).toThrow(StoredEventDecodeError);
    expect(() =>
      decodeStoredEvents([
        v2RunEvent(1, 1, "run.started", chatStartData()),
        v2RunEvent(2, 2, "run.completed", {
          duration_ms: 1,
          extra: true,
          output_chars: 0,
        }),
      ]),
    ).toThrow(StoredEventDecodeError);
  });
});
