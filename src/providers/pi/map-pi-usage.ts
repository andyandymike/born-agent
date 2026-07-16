import type { ModelCapabilities } from "../../model/model-capabilities.js";
import type { ModelUsage } from "../../model/model-events.js";
import type { PiRuntimeUsage } from "./pi-runtime-port.js";

export class PiUsageProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PiUsageProtocolError";
  }
}

function validTokenCount(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function sameUsage(left: PiRuntimeUsage, right: PiRuntimeUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.totalTokens === right.totalTokens
  );
}

function validateUsage(usage: PiRuntimeUsage): void {
  if (
    !validTokenCount(usage.inputTokens) ||
    !validTokenCount(usage.outputTokens) ||
    !validTokenCount(usage.cacheReadTokens) ||
    !validTokenCount(usage.cacheWriteTokens) ||
    !validTokenCount(usage.totalTokens)
  ) {
    throw new PiUsageProtocolError("invalid_usage_value");
  }
  const components = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (
    usage.totalTokens !== null &&
    components.every((value): value is number => value !== null) &&
    components.reduce((sum, value) => sum + value, 0) !== usage.totalTokens
  ) {
    throw new PiUsageProtocolError("conflicting_usage_total");
  }
}

export function mapPiUsage(
  capability: ModelCapabilities["usage"],
  snapshots: readonly PiRuntimeUsage[],
  terminalUsage: PiRuntimeUsage | undefined,
): ModelUsage | undefined {
  if (capability === "none") return undefined;

  for (const snapshot of snapshots) validateUsage(snapshot);
  if (terminalUsage !== undefined) validateUsage(terminalUsage);
  const lastSnapshot = snapshots.at(-1);
  if (
    lastSnapshot !== undefined &&
    terminalUsage !== undefined &&
    !sameUsage(lastSnapshot, terminalUsage)
  ) {
    throw new PiUsageProtocolError("conflicting_usage_snapshots");
  }
  const usage = terminalUsage ?? lastSnapshot;
  if (usage === undefined) {
    throw new PiUsageProtocolError("missing_authoritative_usage");
  }

  // PHASE8: missing provider fields stay null. Treating them as zero would turn
  // partial telemetry into a false reported-token fact and make the Phase 4
  // turn-boundary ceiling unsafe.
  if (capability === "partial") {
    return { completeness: "partial", ...usage };
  }
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.totalTokens === null
  ) {
    throw new PiUsageProtocolError("incomplete_usage_claimed_complete");
  }
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    completeness: "complete",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

