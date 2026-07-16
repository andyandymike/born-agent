import { describe, expect, it } from "vitest";

import { runEventSchema } from "../../src/events/run-event-schema.js";

const envelope = {
  event_id: "00000000-0000-4000-8000-000000000003",
  run_id: "00000000-0000-4000-8000-000000000002",
  schema_version: 1,
  seq: 1,
  session_id: "00000000-0000-4000-8000-000000000001",
  timestamp: "2026-07-16T00:00:00.000Z",
};

describe("RunEvent v1 schema", () => {
  it.each([
    {
      ...envelope,
      data: {
        command: "chat",
        input: { role: "user", text: "hello" },
        model: "gpt-test",
        provider: "openai",
        timeout_ms: 120_000,
        workspace: "D:\\Code\\bornagent",
      },
      type: "run.started",
    },
    { ...envelope, data: { delta: "hi" }, type: "text.delta" },
    {
      ...envelope,
      data: {
        cached_input_tokens: 1,
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
      },
      type: "usage",
    },
    {
      ...envelope,
      data: { duration_ms: 10, output_chars: 2 },
      type: "run.completed",
    },
    {
      ...envelope,
      data: {
        category: "network",
        code: "network_error",
        duration_ms: 10,
        message: "network failed",
        retryable: true,
      },
      type: "run.failed",
    },
    {
      ...envelope,
      data: { duration_ms: 10, reason: "user" },
      type: "run.cancelled",
    },
  ])("accepts $type", (event) => {
    expect(runEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    { ...envelope, data: { delta: "" }, type: "text.delta" },
    {
      ...envelope,
      data: { input_tokens: -1, output_tokens: 0, total_tokens: 0 },
      type: "usage",
    },
    {
      ...envelope,
      schema_version: 2,
      data: { delta: "hi" },
      type: "text.delta",
    },
    {
      ...envelope,
      timestamp: "2026-07-16T09:00:00+09:00",
      data: { delta: "hi" },
      type: "text.delta",
    },
  ])("rejects an invalid v1 event", (event) => {
    expect(runEventSchema.safeParse(event).success).toBe(false);
  });
});
