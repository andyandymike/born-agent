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
        arguments_json: '{"path":"README.md"}',
        call_id: "call_1",
        provider_response_id: "resp_1",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    },
    {
      ...envelope,
      data: {
        call_id: "call_1",
        duration_ms: 2,
        output: '{"ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
      type: "tool.call.completed",
    },
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
    {
      ...envelope,
      data: {
        arguments_json: "x".repeat(16 * 1024 + 1),
        call_id: "call_1",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    },
    {
      ...envelope,
      data: {
        call_id: "call_1",
        duration_ms: 1,
        error_code: "missing_category",
        output: '{"ok":false}',
        status: "error",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
      type: "tool.call.completed",
    },
  ])("rejects an invalid v1 event", (event) => {
    expect(runEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts the bounded Phase 5 patch and approval evidence events", () => {
    const planId = "a".repeat(64);
    const preSha256 = "b".repeat(64);
    const postSha256 = "c".repeat(64);
    const approvalRequestId = "00000000-0000-4000-8000-000000000010";
    const path = { kind: "modify" as const, path: "src/math.ts" };
    const shared = { call_id: "call_patch", plan_id: planId, step: 1 };

    const events = [
      {
        ...envelope,
        data: {
          ...shared,
          added_lines: 1,
          patch_sha256: "d".repeat(64),
          paths: [path],
          preview: "+return 2;",
          removed_lines: 1,
          truncated: false,
        },
        type: "patch.plan.created",
      },
      {
        ...envelope,
        data: {
          ...shared,
          action: "apply_patch",
          added_lines: 1,
          approval_request_id: approvalRequestId,
          paths: [path],
          preview: "+return 2;",
          removed_lines: 1,
          truncated: false,
        },
        type: "approval.requested",
      },
      {
        ...envelope,
        data: {
          ...shared,
          action: "apply_patch",
          approval_request_id: approvalRequestId,
          decision: "approved",
        },
        type: "approval.decided",
      },
      {
        ...envelope,
        data: {
          ...shared,
          approval_request_id: approvalRequestId,
          files: [{ ...path, pre_sha256: preSha256 }],
        },
        type: "patch.apply.started",
      },
      {
        ...envelope,
        data: {
          ...shared,
          added_lines: 1,
          approval_request_id: approvalRequestId,
          duration_ms: 3,
          files: [{ ...path, post_sha256: postSha256, pre_sha256: preSha256 }],
          journal_sha256: "e".repeat(64),
          removed_lines: 1,
        },
        type: "patch.apply.completed",
      },
    ];

    expect(events.every((event) => runEventSchema.safeParse(event).success)).toBe(
      true,
    );
    expect(
      runEventSchema.safeParse({
        ...events[0],
        data: { ...events[0]?.data, paths: [{ ...path, path: "../outside.ts" }] },
      }).success,
    ).toBe(false);
  });
});
