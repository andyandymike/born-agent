import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeStoredEvents, type DecodedRunEvent } from "../../src/events/event-decoder-registry.js";
import { mapMcpTextResult } from "../../src/mcp/mcp-result-mapper.js";
import {
  mergeMcpPendingEffects,
  reconstructPendingEffectLedger,
} from "../../src/resume/pending-effect-ledger.js";
import { ResumePlanner } from "../../src/resume/resume-planner.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const SESSION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const APPROVAL = "33333333-3333-4333-8333-333333333333";

function decoded(type: string, data: unknown): readonly DecodedRunEvent[] {
  return decodeStoredEvents([
    {
      data: {
        command: "agent",
        input: { role: "user", text: "test" },
        max_duration_ms: 1000,
        max_steps: 1,
        max_tokens: 100,
        max_tool_output_bytes: 65536,
        model: "fixture",
        provider: "ollama",
        request_timeout_ms: 1000,
        workspace: ".",
      },
      event_id: randomUUID(),
      run_id: RUN,
      run_seq: 1,
      schema_version: 2,
      scope: "run",
      session_id: SESSION,
      session_seq: 1,
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "run.started",
    },
    {
      data: {
        adapter: "fixture",
        adapter_version: "1",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "best_effort",
          usage: "complete",
        },
        config_fingerprint: A,
        model: "fixture",
        provider: "ollama",
      },
      event_id: randomUUID(),
      run_id: RUN,
      run_seq: 2,
      schema_version: 2,
      scope: "run",
      session_id: SESSION,
      session_seq: 2,
      timestamp: "2026-07-17T00:00:00.001Z",
      type: "backend.selected",
    },
    {
      data,
      event_id: randomUUID(),
      run_id: RUN,
      run_seq: 3,
      schema_version: 2,
      scope: "run",
      session_id: SESSION,
      session_seq: 3,
      timestamp: "2026-07-17T00:00:00.002Z",
      type,
    },
  ]) as readonly DecodedRunEvent[];
}

function callIdentity() {
  return {
    action_sha256: A,
    approval_request_id: APPROVAL,
    arguments_sha256: B,
    call_id: "call-1",
    catalog_sha256: A,
    config_sha256: A,
    model_tool_name: "mcp__fixture__echo",
    process_identity_sha256: A,
    raw_tool_name: "echo",
    schema_sha256: A,
    server_id: "fixture",
    step: 1,
    timeout_ms: 5000,
  };
}

describe("Phase 12 MCP pending-effect recovery", () => {
  it("blocks requested-only server starts and started-only calls", () => {
    const base = reconstructPendingEffectLedger([]);
    const serverLedger = mergeMcpPendingEffects(
      base,
      decoded("mcp.server.start.requested", {
        action_sha256: A,
        approval_request_id: APPROVAL,
        config_sha256: A,
        env_mapping_sha256: A,
        executable_identity_sha256: A,
        integrity_binding: "explicit",
        integrity_manifest_sha256: A,
        server_id: "fixture",
        startup_timeout_ms: 5000,
      }),
    );
    expect(serverLedger.unknownMcpServers).toMatchObject([
      { serverId: "fixture", stage: "requested" },
    ]);

    const callLedger = mergeMcpPendingEffects(
      base,
      decoded("mcp.tool.call.started", callIdentity()),
    );
    expect(callLedger.unknownMcpCalls).toMatchObject([
      { callId: "call-1", stage: "started" },
    ]);
    expect(
      new ResumePlanner({ createRunId: randomUUID }).preflightPendingEffects({
        ledger: callLedger,
        sessionId: SESSION,
        sourceRunId: RUN,
      }),
    ).toMatchObject({ reasons: ["pending_mcp_effect_unknown"], status: "blocked" });
  });

  it("recovers only the exact durable mapped inner result", () => {
    const mapped = mapMcpTextResult(
      { content: [{ text: "done", type: "text" }] },
      { maxObservationBytes: 64 * 1024 },
    );
    const ledger = mergeMcpPendingEffects(
      reconstructPendingEffectLedger([]),
      decoded("mcp.tool.call.completed", {
        ...callIdentity(),
        bytes: mapped.bytes,
        duration_ms: 10,
        mapper_version: mapped.mapperVersion,
        observation: mapped.observation,
        observation_sha256: mapped.observationSha256,
        status: mapped.status,
        truncated: mapped.truncated,
      }),
    );
    expect(ledger.unknownMcpCalls).toEqual([]);
    expect(ledger.recoveredInnerEffects).toMatchObject([
      {
        callId: "call-1",
        kind: "mcp",
        observation: { output: mapped.observation, status: "success" },
      },
    ]);
  });
});
