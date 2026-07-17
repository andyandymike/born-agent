import { describe, expect, it } from "vitest";

import { McpCoreError } from "../../src/mcp/mcp-errors.js";
import {
  classifyMcpRecoveryProcess,
  createInitialMcpLifecycleState,
  createMcpProcessIdentity,
  reduceMcpLifecycle,
} from "../../src/mcp/mcp-lifecycle.js";
import {
  MCP_RESULT_MAPPER_VERSION,
  mapMcpTextResult,
  recoverDurableMappedMcpResult,
} from "../../src/mcp/mcp-result-mapper.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("Phase 12 MCP text result mapper", () => {
  it("maps ordered text, redacts secrets, and removes terminal controls", () => {
    const mapped = mapMcpTextResult(
      {
        content: [
          { text: "first", type: "text" },
          { text: "\u001b]52;c;ZmFrZQ==\u0007token-value", type: "text" },
        ],
        isError: false,
      },
      { maxObservationBytes: 4096, secrets: ["token-value"] },
    );
    expect(mapped).toMatchObject({
      mapperVersion: MCP_RESULT_MAPPER_VERSION,
      status: "success",
      truncated: false,
    });
    expect(JSON.parse(mapped.observation)).toEqual({
      is_error: false,
      ok: true,
      text: ["first", "[redacted]"],
      truncated: false,
      version: MCP_RESULT_MAPPER_VERSION,
    });
    expect(mapped.observation).not.toContain("ZmFrZQ");
  });

  it("keeps bounded text for isError without treating it as a process crash", () => {
    const mapped = mapMcpTextResult(
      { content: [{ text: "fixture error", type: "text" }], isError: true },
      { maxObservationBytes: 4096 },
    );
    expect(mapped.status).toBe("error");
    expect(JSON.parse(mapped.observation)).toMatchObject({
      is_error: true,
      ok: false,
      text: ["fixture error"],
    });
  });

  it("truncates at a valid structured boundary and preserves Unicode JSON", () => {
    const mapped = mapMcpTextResult(
      { content: [{ text: "中文🙂".repeat(500), type: "text" }] },
      { maxObservationBytes: 256 },
    );
    expect(mapped.truncated).toBe(true);
    expect(mapped.bytes).toBeLessThanOrEqual(256);
    expect(() => JSON.parse(mapped.observation)).not.toThrow();
    expect(JSON.parse(mapped.observation).truncated).toBe(true);
  });

  it("rejects image/audio/resource/unknown fields and nonempty structured content", () => {
    const unsupported = [
      { content: [{ data: "x", type: "image" }] },
      { content: [{ data: "x", type: "audio" }] },
      { content: [{ resource: {}, type: "resource" }] },
      { content: [{ text: "x", type: "text" }], structuredContent: { value: 1 } },
      { content: [{ text: "x", type: "text" }], unknown: true },
    ];
    for (const value of unsupported) {
      expect(() =>
        mapMcpTextResult(value, { maxObservationBytes: 4096 }),
      ).toThrowError(McpCoreError);
    }
  });

  it("enforces source/item limits", () => {
    expect(() =>
      mapMcpTextResult(
        { content: [{ text: "x".repeat(4 * 1024 * 1024 + 1), type: "text" }] },
        { maxObservationBytes: 4096 },
      ),
    ).toThrowError(McpCoreError);
    expect(() =>
      mapMcpTextResult(
        {
          content: Array.from({ length: 257 }, () => ({ text: "x", type: "text" })),
        },
        { maxObservationBytes: 4096 },
      ),
    ).toThrowError(McpCoreError);
  });

  it("recovers only byte-for-byte durable inner results without a server call", () => {
    const mapped = mapMcpTextResult(
      { content: [{ text: "durable", type: "text" }] },
      { maxObservationBytes: 4096 },
    );
    expect(recoverDurableMappedMcpResult(mapped)).toEqual(mapped);
    expect(() =>
      recoverDurableMappedMcpResult({
        ...mapped,
        observation: `${mapped.observation} `,
      }),
    ).toThrowError(McpCoreError);
    expect(() =>
      recoverDurableMappedMcpResult({
        ...mapped,
        mapperVersion: "future-mapper",
      }),
    ).toThrowError(McpCoreError);
    expect(() =>
      recoverDurableMappedMcpResult({
        ...mapped,
        status: "error",
      }),
    ).toThrowError(McpCoreError);
  });
});

function processIdentity(start = "process-start-1") {
  return createMcpProcessIdentity({
    hostFingerprint: A,
    pid: 1234,
    processStartIdentity: start,
  });
}

describe("Phase 12 MCP lifecycle and process identity", () => {
  it("enforces requested -> started -> discovered -> call -> stopped pairing", () => {
    const identity = processIdentity();
    let state = createInitialMcpLifecycleState();
    state = reduceMcpLifecycle(state, { actionSha256: A, type: "start_requested" });
    state = reduceMcpLifecycle(state, { identity, type: "started" });
    state = reduceMcpLifecycle(state, { catalogSha256: B, type: "catalog_discovered" });
    state = reduceMcpLifecycle(state, { callId: "call-1", type: "call_started" });
    state = reduceMcpLifecycle(state, { callId: "call-1", type: "call_completed" });
    state = reduceMcpLifecycle(state, { type: "stopping" });
    state = reduceMcpLifecycle(state, {
      cleanupVerified: true,
      identity,
      type: "stopped",
    });

    expect(state).toMatchObject({
      activeCallIds: [],
      catalogSha256: B,
      status: "stopped",
    });
  });

  it("blocks discovery before start, calls after catalog change, and stop with active calls", () => {
    expect(() =>
      reduceMcpLifecycle(createInitialMcpLifecycleState(), {
        catalogSha256: B,
        type: "catalog_discovered",
      }),
    ).toThrowError(McpCoreError);

    let state = reduceMcpLifecycle(createInitialMcpLifecycleState(), {
      actionSha256: A,
      type: "start_requested",
    });
    state = reduceMcpLifecycle(state, { identity: processIdentity(), type: "started" });
    state = reduceMcpLifecycle(state, { catalogSha256: B, type: "catalog_discovered" });
    const withCall = reduceMcpLifecycle(state, { callId: "call-1", type: "call_started" });
    expect(() => reduceMcpLifecycle(withCall, { type: "stopping" })).toThrowError(
      McpCoreError,
    );

    const changed = reduceMcpLifecycle(state, {
      catalogSha256: C,
      type: "catalog_changed",
    });
    expect(() =>
      reduceMcpLifecycle(changed, { callId: "call-2", type: "call_started" }),
    ).toThrowError(McpCoreError);
  });

  it("distinguishes definite zero-process failure and uncertain start/call effects", () => {
    const requested = reduceMcpLifecycle(createInitialMcpLifecycleState(), {
      actionSha256: A,
      type: "start_requested",
    });
    expect(
      reduceMcpLifecycle(requested, {
        type: "start_failed",
        zeroProcessProofSha256: B,
      }).status,
    ).toBe("start_failed");
    expect(reduceMcpLifecycle(requested, { type: "start_effect_unknown" }).status).toBe(
      "start_effect_unknown",
    );

    let state = reduceMcpLifecycle(requested, {
      identity: processIdentity(),
      type: "started",
    });
    state = reduceMcpLifecycle(state, { catalogSha256: B, type: "catalog_discovered" });
    state = reduceMcpLifecycle(state, { callId: "call-unknown", type: "call_started" });
    state = reduceMcpLifecycle(state, {
      callId: "call-unknown",
      type: "call_effect_unknown",
    });
    expect(state).toMatchObject({
      activeCallIds: [],
      unknownEffectCallIds: ["call-unknown"],
    });
    expect(reduceMcpLifecycle(state, { type: "stopping" }).status).toBe("stopping");
  });

  it("allows cleanup only for exact PID plus process-start identity", () => {
    const recorded = processIdentity();
    expect(
      classifyMcpRecoveryProcess(recorded, {
        kind: "present",
        pid: recorded.pid,
        processStartIdentity: recorded.processStartIdentity,
      }),
    ).toEqual({ cleanupAllowed: true, status: "matching_cleanup_required" });
    expect(
      classifyMcpRecoveryProcess(recorded, {
        kind: "present",
        pid: recorded.pid,
        processStartIdentity: "reused-pid-start",
      }),
    ).toEqual({ cleanupAllowed: false, status: "pid_reused" });
    expect(classifyMcpRecoveryProcess(recorded, { kind: "unverifiable" })).toEqual({
      cleanupAllowed: false,
      status: "blocked_unverifiable",
    });
    expect(classifyMcpRecoveryProcess(recorded, { kind: "absent" })).toEqual({
      cleanupAllowed: false,
      status: "absent",
    });
  });

  it("rejects a stopped event for a reused process identity", () => {
    const original = processIdentity();
    let state = reduceMcpLifecycle(createInitialMcpLifecycleState(), {
      actionSha256: A,
      type: "start_requested",
    });
    state = reduceMcpLifecycle(state, { identity: original, type: "started" });
    state = reduceMcpLifecycle(state, { type: "stopping" });
    expect(() =>
      reduceMcpLifecycle(state, {
        cleanupVerified: true,
        identity: processIdentity("different-start"),
        type: "stopped",
      }),
    ).toThrowError(McpCoreError);
  });
});
