import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import {
  assertPhase9RunEventSemantics,
  Phase9RunEventSemanticError,
} from "../../src/events/phase9-run-event-semantics.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const SESSION_ID = "81000000-0000-4000-8000-000000000001";
const SOURCE_RUN_ID = "82000000-0000-4000-8000-000000000001";
const RESUMED_RUN_ID = "82000000-0000-4000-8000-000000000002";
const CHECKPOINT_ID = "83000000-0000-4000-8000-000000000001";
const TIME = "2026-07-17T00:00:00.000Z";
const temporaryDirectories: string[] = [];

type Capability = "canonical_only" | "exact_checkpoint" | "none";

function uuid(sequence: number): string {
  return `84000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function runEnvelope(
  sessionSeq: number,
  runId: string,
  runSeq: number,
  type: string,
  data: unknown,
): unknown {
  return {
    data,
    event_id: uuid(sessionSeq),
    run_id: runId,
    run_seq: runSeq,
    schema_version: 2,
    scope: "run",
    session_id: SESSION_ID,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
  };
}

function start(
  sessionSeq: number,
  runId: string,
  extra: Record<string, unknown> = {},
): unknown {
  return runEnvelope(sessionSeq, runId, 1, "run.started", {
    command: "chat",
    input: { role: "user", text: "semantic fixture" },
    model: "qwen3:1.7b",
    provider: "ollama",
    timeout_ms: 1_000,
    tools: ["read_file"],
    tools_enabled: true,
    workspace: "D:\\Code\\bornagent",
    ...extra,
  });
}

function backend(
  sessionSeq: number,
  runId: string,
  capability: Capability,
  override: Record<string, unknown> = {},
): unknown {
  return runEnvelope(sessionSeq, runId, 2, "backend.selected", {
    adapter: "fake-adapter",
    adapter_version: "1.0.0",
    capabilities: {
      cancellation: "abort_signal",
      reasoning: "opaque_passthrough",
      streaming: true,
      tools: "strict",
      usage: "complete",
    },
    ...(capability === "exact_checkpoint"
      ? { checkpoint_codec_version: "fake-codec-v1" }
      : {}),
    config_fingerprint: "a".repeat(64),
    model: "qwen3:1.7b",
    provider: "ollama",
    resume_capability: capability,
    ...override,
  });
}

function checkpoint(
  sessionSeq: number,
  runId: string,
  runSeq: number,
  override: Record<string, unknown> = {},
): unknown {
  return runEnvelope(sessionSeq, runId, runSeq, "backend.checkpoint.created", {
    adapter: "fake-adapter",
    adapter_version: "1.0.0",
    bytes: 4,
    checkpoint_id: CHECKPOINT_ID,
    codec_version: "fake-codec-v1",
    model: "qwen3:1.7b",
    provider: "ollama",
    ref: `.bornagent/checkpoints/${SESSION_ID}/${CHECKPOINT_ID}.bin`,
    sha256: "b".repeat(64),
    turn: 1,
    ...override,
  });
}

function canonicalBoundary(
  sessionSeq: number,
  runId: string,
  runSeq: number,
  turn: number,
): unknown {
  return runEnvelope(
    sessionSeq,
    runId,
    runSeq,
    "backend.canonical_boundary.created",
    {
      pending_call: false,
      transcript_sha256: "c".repeat(64),
      turn,
    },
  );
}

function exactPendingSource(): unknown[] {
  return [
    start(1, SOURCE_RUN_ID),
    backend(2, SOURCE_RUN_ID, "exact_checkpoint"),
    runEnvelope(3, SOURCE_RUN_ID, 3, "tool.call.requested", {
      arguments_json: "{}",
      call_id: "source-call",
      step: 1,
      tool_name: "read_file",
    }),
    checkpoint(4, SOURCE_RUN_ID, 4),
  ];
}

function exactResumePrefix(
  adoptionOverride: Record<string, unknown> = {},
): unknown[] {
  return [
    ...exactPendingSource(),
    {
      data: { requested_mode: "exact", source_run_id: SOURCE_RUN_ID },
      event_id: uuid(5),
      schema_version: 2,
      scope: "session",
      session_id: SESSION_ID,
      session_seq: 5,
      timestamp: TIME,
      type: "session.resume.requested",
    },
    start(6, RESUMED_RUN_ID, {
      resume_mode: "exact",
      resume_of_run_id: SOURCE_RUN_ID,
    }),
    backend(7, RESUMED_RUN_ID, "exact_checkpoint"),
    runEnvelope(8, RESUMED_RUN_ID, 3, "resume.pending_call.adopted", {
      call_id: "source-call",
      checkpoint_id: CHECKPOINT_ID,
      source_call_id: "source-call",
      source_run_id: SOURCE_RUN_ID,
      step: 1,
      tool_name: "read_file",
      ...adoptionOverride,
    }),
  ];
}

function replay(raw: readonly unknown[]): void {
  reconstructMultiRunSession(decodeStoredEvents(raw));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 9 run-event semantic validator", () => {
  it.each([
    {
      capability: "none" as const,
      code: "backend_capability_mismatch",
      event: canonicalBoundary(3, SOURCE_RUN_ID, 3, 1),
      name: "canonical boundary from a non-resumable backend",
    },
    {
      capability: "canonical_only" as const,
      code: "backend_capability_mismatch",
      event: checkpoint(3, SOURCE_RUN_ID, 3),
      name: "checkpoint from a canonical-only backend",
    },
  ])("rejects $name", ({ capability, code, event }) => {
    expect(() => replay([start(1, SOURCE_RUN_ID), backend(2, SOURCE_RUN_ID, capability), event])).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects checkpoint identity drift from backend.selected", () => {
    expect(() =>
      replay([
        start(1, SOURCE_RUN_ID),
        backend(2, SOURCE_RUN_ID, "exact_checkpoint"),
        checkpoint(3, SOURCE_RUN_ID, 3, { adapter: "substituted-adapter" }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: "checkpoint_identity_mismatch" }),
    );
  });

  it("rejects skipped and duplicate boundary turns", () => {
    expect(() =>
      replay([
        start(1, SOURCE_RUN_ID),
        backend(2, SOURCE_RUN_ID, "canonical_only"),
        canonicalBoundary(3, SOURCE_RUN_ID, 3, 1),
        canonicalBoundary(4, SOURCE_RUN_ID, 4, 3),
      ]),
    ).toThrow(expect.objectContaining({ code: "turn_sequence_invalid" }));
  });

  it("rejects adoption that substitutes the source call or checkpoint", () => {
    expect(() =>
      replay(exactResumePrefix({ source_call_id: "different-call" })),
    ).toThrow(expect.objectContaining({ code: "adoption_invalid" }));
    expect(() =>
      replay(
        exactResumePrefix({
          checkpoint_id: "83000000-0000-4000-8000-000000000099",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "adoption_invalid" }));
  });

  it("accepts a correctly linked exact adoption prefix", () => {
    expect(() => replay(exactResumePrefix())).not.toThrow();
  });

  it("rejects a recovered observation without a completed source inner effect", () => {
    expect(() =>
      replay([
        ...exactResumePrefix(),
        runEnvelope(9, RESUMED_RUN_ID, 4, "tool.call.recovered", {
          call_id: "source-call",
          duration_ms: 1,
          output: "{}",
          source_run_id: SOURCE_RUN_ID,
          status: "success",
          step: 1,
          tool_name: "read_file",
          truncated: false,
        }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: "recovered_effect_mismatch" }),
    );
  });

  it("accepts an exact durable outer observation and requires byte-identical recovery", () => {
    const sourceCompleted = runEnvelope(
      5,
      SOURCE_RUN_ID,
      5,
      "tool.call.completed",
      {
        call_id: "source-call",
        duration_ms: 1,
        output: '{"content":"durable","ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
    );
    const resume = [
      ...exactPendingSource(),
      sourceCompleted,
      {
        data: { requested_mode: "exact", source_run_id: SOURCE_RUN_ID },
        event_id: uuid(6),
        schema_version: 2,
        scope: "session",
        session_id: SESSION_ID,
        session_seq: 6,
        timestamp: TIME,
        type: "session.resume.requested",
      },
      start(7, RESUMED_RUN_ID, {
        resume_mode: "exact",
        resume_of_run_id: SOURCE_RUN_ID,
      }),
      backend(8, RESUMED_RUN_ID, "exact_checkpoint"),
      runEnvelope(9, RESUMED_RUN_ID, 3, "resume.pending_call.adopted", {
        call_id: "source-call",
        checkpoint_id: CHECKPOINT_ID,
        source_call_id: "source-call",
        source_run_id: SOURCE_RUN_ID,
        step: 1,
        tool_name: "read_file",
      }),
      runEnvelope(10, RESUMED_RUN_ID, 4, "tool.call.recovered", {
        call_id: "source-call",
        duration_ms: 0,
        output: '{"content":"durable","ok":true}',
        source_run_id: SOURCE_RUN_ID,
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      }),
      runEnvelope(11, RESUMED_RUN_ID, 5, "tool.call.completed", {
        call_id: "source-call",
        duration_ms: 0,
        output: '{"content":"durable","ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      }),
    ];

    expect(() => replay(resume)).not.toThrow();
    const tampered = [...resume];
    tampered[9] = runEnvelope(
      10,
      RESUMED_RUN_ID,
      4,
      "tool.call.recovered",
      {
        call_id: "source-call",
        duration_ms: 0,
        output: '{"content":"tampered","ok":true}',
        source_run_id: SOURCE_RUN_ID,
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
    );
    expect(() => replay(tampered)).toThrow(
      expect.objectContaining({ code: "recovered_effect_mismatch" }),
    );
  });

  it("binds inner patch recovery to the deterministic source observation", () => {
    const planId = "9".repeat(64);
    const patchOutput = JSON.stringify({
      approved: true,
      files: [
        {
          kind: "modify",
          path: "src/a.ts",
          post_sha256: "2".repeat(64),
          pre_sha256: "1".repeat(64),
        },
      ],
      plan_id: planId,
      stats: { added_lines: 1, removed_lines: 1 },
      ok: true,
    });
    const source = [
      start(1, SOURCE_RUN_ID),
      backend(2, SOURCE_RUN_ID, "exact_checkpoint"),
      runEnvelope(3, SOURCE_RUN_ID, 3, "tool.call.requested", {
        arguments_json: '{"patch":"fixture"}',
        call_id: "source-patch",
        step: 1,
        tool_name: "apply_patch",
      }),
      checkpoint(4, SOURCE_RUN_ID, 4),
      runEnvelope(5, SOURCE_RUN_ID, 5, "patch.apply.completed", {
        added_lines: 1,
        approval_request_id: "85000000-0000-4000-8000-000000000001",
        call_id: "source-patch",
        duration_ms: 1,
        files: [
          {
            kind: "modify",
            path: "src/a.ts",
            post_sha256: "2".repeat(64),
            pre_sha256: "1".repeat(64),
          },
        ],
        journal_sha256: "3".repeat(64),
        plan_id: planId,
        removed_lines: 1,
        step: 1,
      }),
      {
        data: { requested_mode: "exact", source_run_id: SOURCE_RUN_ID },
        event_id: uuid(6),
        schema_version: 2,
        scope: "session",
        session_id: SESSION_ID,
        session_seq: 6,
        timestamp: TIME,
        type: "session.resume.requested",
      },
      start(7, RESUMED_RUN_ID, {
        resume_mode: "exact",
        resume_of_run_id: SOURCE_RUN_ID,
      }),
      backend(8, RESUMED_RUN_ID, "exact_checkpoint"),
      runEnvelope(9, RESUMED_RUN_ID, 3, "resume.pending_call.adopted", {
        call_id: "source-patch",
        checkpoint_id: CHECKPOINT_ID,
        source_call_id: "source-patch",
        source_run_id: SOURCE_RUN_ID,
        step: 1,
        tool_name: "apply_patch",
      }),
    ];
    const recovered = (output: string) =>
      runEnvelope(10, RESUMED_RUN_ID, 4, "tool.call.recovered", {
        call_id: "source-patch",
        duration_ms: 0,
        output,
        source_run_id: SOURCE_RUN_ID,
        status: "success",
        step: 1,
        tool_name: "apply_patch",
        truncated: false,
      });

    expect(() =>
      assertPhase9RunEventSemantics(
        decodeStoredEvents([...source, recovered(patchOutput)]),
      ),
    ).not.toThrow();
    expect(() =>
      assertPhase9RunEventSemantics(
        decodeStoredEvents([
          ...source,
          recovered('{"approved":true,"ok":true}'),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "recovered_effect_mismatch" }));
  });

  it("rejects an invalid turn before V2SessionWriter writes it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase9-semantics-"));
    temporaryDirectories.push(workspace);
    const sessionId = randomUUID();
    const runId = randomUUID();
    const writer = await V2SessionWriter.createNew(workspace, sessionId);
    const publisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId,
      sessionId,
      timestamp: () => TIME,
      writer,
    });
    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: "writer semantic fixture" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 1_000,
        workspace,
      },
      type: "run.started",
    });
    await publisher.publish({
      data: {
        adapter: "fake-adapter",
        adapter_version: "1.0.0",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "strict",
          usage: "complete",
        },
        config_fingerprint: "d".repeat(64),
        model: "qwen3:1.7b",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await writer.appendRunEvent(runId, "backend.canonical_boundary.created", {
      pending_call: false,
      transcript_sha256: "e".repeat(64),
      turn: 1,
    });
    const before = await readFile(writer.path);

    await expect(
      writer.appendRunEvent(runId, "backend.canonical_boundary.created", {
        pending_call: false,
        transcript_sha256: "f".repeat(64),
        turn: 1,
      }),
    ).rejects.toBeInstanceOf(Phase9RunEventSemanticError);
    expect(await readFile(writer.path)).toEqual(before);
    await writer.close();
  });
});
