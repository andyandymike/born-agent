import { createHash } from "node:crypto";

import { canonicalJson } from "../completion/canonical-json.js";
import { McpCoreError } from "./mcp-errors.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface McpProcessIdentity {
  readonly hostFingerprint: string;
  readonly pid: number;
  readonly processIdentitySha256: string;
  readonly processStartIdentity: string;
}

export type McpProcessObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly pid: number; readonly processStartIdentity: string }
  | { readonly kind: "unverifiable" };

export type McpRecoveryProcessDecision =
  | { readonly cleanupAllowed: false; readonly status: "absent" | "blocked_unverifiable" | "pid_reused" }
  | { readonly cleanupAllowed: true; readonly status: "matching_cleanup_required" };

export function createMcpProcessIdentity(input: {
  readonly hostFingerprint: string;
  readonly pid: number;
  readonly processStartIdentity: string;
}): McpProcessIdentity {
  if (!SHA256.test(input.hostFingerprint)) {
    throw new McpCoreError("mcp_lifecycle_invalid", "invalid MCP host fingerprint");
  }
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new McpCoreError("mcp_lifecycle_invalid", "invalid MCP pid");
  }
  if (
    input.processStartIdentity.length === 0 ||
    input.processStartIdentity.length > 256 ||
    input.processStartIdentity.includes("\0")
  ) {
    throw new McpCoreError("mcp_lifecycle_invalid", "invalid MCP process-start identity");
  }
  return Object.freeze({
    ...input,
    processIdentitySha256: createHash("sha256")
      .update(
        canonicalJson({
          host_fingerprint: input.hostFingerprint,
          pid: input.pid,
          process_start_identity: input.processStartIdentity,
        }),
        "utf8",
      )
      .digest("hex"),
  });
}

export function classifyMcpRecoveryProcess(
  recorded: McpProcessIdentity,
  observed: McpProcessObservation,
): McpRecoveryProcessDecision {
  // PHASE12: an old client/stdio process is never reusable. PID alone is not
  // identity; a reused PID must not authorize killing an unrelated process.
  if (observed.kind === "unverifiable") {
    return { cleanupAllowed: false, status: "blocked_unverifiable" };
  }
  if (observed.kind === "absent" || observed.pid !== recorded.pid) {
    return { cleanupAllowed: false, status: "absent" };
  }
  if (observed.processStartIdentity !== recorded.processStartIdentity) {
    return { cleanupAllowed: false, status: "pid_reused" };
  }
  return { cleanupAllowed: true, status: "matching_cleanup_required" };
}

export type McpLifecycleStatus =
  | "catalog_changed"
  | "discovered"
  | "start_effect_unknown"
  | "start_failed"
  | "start_requested"
  | "started"
  | "stopped"
  | "stopping"
  | "unstarted";

export interface McpLifecycleState {
  readonly activeCallIds: readonly string[];
  readonly catalogSha256: string | null;
  readonly processIdentity: McpProcessIdentity | null;
  readonly startActionSha256: string | null;
  readonly status: McpLifecycleStatus;
  readonly unknownEffectCallIds: readonly string[];
}

export type McpLifecycleEvent =
  | { readonly actionSha256: string; readonly type: "start_requested" }
  | { readonly type: "start_effect_unknown" }
  | { readonly zeroProcessProofSha256: string; readonly type: "start_failed" }
  | { readonly identity: McpProcessIdentity; readonly type: "started" }
  | { readonly catalogSha256: string; readonly type: "catalog_discovered" }
  | { readonly catalogSha256: string; readonly type: "catalog_changed" }
  | { readonly callId: string; readonly type: "call_started" }
  | { readonly callId: string; readonly type: "call_completed" }
  | { readonly callId: string; readonly type: "call_effect_unknown" }
  | { readonly type: "stopping" }
  | {
      readonly cleanupVerified: boolean;
      readonly identity: McpProcessIdentity;
      readonly type: "stopped";
    };

export function createInitialMcpLifecycleState(): McpLifecycleState {
  return Object.freeze({
    activeCallIds: Object.freeze([]),
    catalogSha256: null,
    processIdentity: null,
    startActionSha256: null,
    status: "unstarted",
    unknownEffectCallIds: Object.freeze([]),
  });
}

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new McpCoreError("mcp_lifecycle_invalid", `${label} must be a SHA-256 digest`);
  }
}

function invalid(message: string): never {
  throw new McpCoreError("mcp_lifecycle_invalid", message);
}

function sameIdentity(left: McpProcessIdentity, right: McpProcessIdentity): boolean {
  return left.processIdentitySha256 === right.processIdentitySha256;
}

export function reduceMcpLifecycle(
  state: McpLifecycleState,
  event: McpLifecycleEvent,
): McpLifecycleState {
  switch (event.type) {
    case "start_requested":
      if (state.status !== "unstarted") return invalid("MCP start can only be requested once");
      requireHash(event.actionSha256, "start action");
      return Object.freeze({ ...state, startActionSha256: event.actionSha256, status: "start_requested" });
    case "start_failed":
      if (state.status !== "start_requested") return invalid("definite start failure requires a start request");
      requireHash(event.zeroProcessProofSha256, "zero-process proof");
      return Object.freeze({ ...state, status: "start_failed" });
    case "start_effect_unknown":
      if (state.status !== "start_requested") return invalid("unknown start effect requires a start request");
      return Object.freeze({ ...state, status: "start_effect_unknown" });
    case "started":
      if (state.status !== "start_requested") return invalid("MCP started must pair with start requested");
      return Object.freeze({ ...state, processIdentity: event.identity, status: "started" });
    case "catalog_discovered":
      if (state.status !== "started") return invalid("MCP discovery requires a started server");
      requireHash(event.catalogSha256, "catalog");
      return Object.freeze({ ...state, catalogSha256: event.catalogSha256, status: "discovered" });
    case "catalog_changed":
      if (state.status !== "discovered") return invalid("catalog change requires frozen discovery");
      requireHash(event.catalogSha256, "changed catalog");
      if (event.catalogSha256 === state.catalogSha256) return invalid("catalog change must change the hash");
      return Object.freeze({ ...state, status: "catalog_changed" });
    case "call_started":
      if (state.status !== "discovered") return invalid("MCP calls require an unchanged frozen catalog");
      if (
        state.activeCallIds.includes(event.callId) ||
        state.unknownEffectCallIds.includes(event.callId) ||
        event.callId.length === 0
      ) {
        return invalid("MCP call id must be new and nonempty");
      }
      return Object.freeze({
        ...state,
        activeCallIds: Object.freeze([...state.activeCallIds, event.callId].sort()),
      });
    case "call_completed":
      if (!state.activeCallIds.includes(event.callId)) return invalid("MCP completion lacks a started call");
      return Object.freeze({
        ...state,
        activeCallIds: Object.freeze(state.activeCallIds.filter((callId) => callId !== event.callId)),
      });
    case "call_effect_unknown":
      if (!state.activeCallIds.includes(event.callId)) return invalid("unknown MCP call effect lacks a started call");
      return Object.freeze({
        ...state,
        activeCallIds: Object.freeze(state.activeCallIds.filter((callId) => callId !== event.callId)),
        unknownEffectCallIds: Object.freeze([...state.unknownEffectCallIds, event.callId].sort()),
      });
    case "stopping":
      if (
        !["started", "discovered", "catalog_changed"].includes(state.status) ||
        state.activeCallIds.length > 0
      ) {
        return invalid("MCP stopping requires every active call to be terminal");
      }
      // PHASE12: SDK close is only a protocol request; lifecycle completion still
      // requires matching process-tree identity and verified cleanup.
      return Object.freeze({ ...state, status: "stopping" });
    case "stopped":
      if (
        state.status !== "stopping" ||
        state.processIdentity === null ||
        !sameIdentity(state.processIdentity, event.identity) ||
        !event.cleanupVerified
      ) {
        return invalid("MCP stopped requires verified cleanup of the matching process identity");
      }
      return Object.freeze({ ...state, status: "stopped" });
  }
}
