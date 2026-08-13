import type { ControlOperationRecordV1 } from "./control-operation-schema.js";

export type ControlOperationDriverReconciliationV1 =
  | Readonly<{ kind: "acquire"; takeover: boolean }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "block_unknown_effect" }>
  | Readonly<{ kind: "terminal" }>;

const TERMINAL_STATES = new Set<ControlOperationRecordV1["state"]>([
  "blocked_stale",
  "blocked_unknown_effect",
  "completed",
  "failed_internal",
  "rejected_known_not_started",
]);

/**
 * PHASE21: expiry only proves that the old driver lease is no longer usable;
 * it never proves that a domain append or effect did not happen. A replacement
 * may take over a pre-dispatch prefix (or finish an already-built result), but
 * ambiguous post-dispatch prefixes fail closed before any handler is invoked.
 */
export function reconcileControlOperationDriver(
  operation: ControlOperationRecordV1,
  now: Date,
  options: Readonly<{ readonly allowPostDispatchReconcile?: boolean }> = {},
): ControlOperationDriverReconciliationV1 {
  if (TERMINAL_STATES.has(operation.state)) return Object.freeze({ kind: "terminal" });
  const owner = operation.ownerClaim;
  if (owner !== null && Date.parse(owner.expiresAt) > now.getTime()) {
    return Object.freeze({ kind: "busy" });
  }
  if (operation.state === "domain_records_linked") {
    const primaryIsLinked = operation.primaryDomainRecord !== null &&
      operation.domainRecordRefs.some((reference) =>
        reference.recordId === operation.primaryDomainRecord?.recordId &&
        reference.recordSha256 === operation.primaryDomainRecord.recordSha256
      );
    if (
      primaryIsLinked &&
      operation.resolvedResourceScope !== null &&
      operation.resolvedResourceVersion !== null &&
      (operation.resultArtifact !== null || options.allowPostDispatchReconcile === true)
    ) {
      return Object.freeze({ kind: "acquire", takeover: owner !== null });
    }
    return Object.freeze({ kind: "block_unknown_effect" });
  }
  if (operation.state === "domain_append_started") {
    return options.allowPostDispatchReconcile === true
      ? Object.freeze({ kind: "acquire", takeover: owner !== null })
      : Object.freeze({ kind: "block_unknown_effect" });
  }
  return Object.freeze({ kind: "acquire", takeover: owner !== null });
}
