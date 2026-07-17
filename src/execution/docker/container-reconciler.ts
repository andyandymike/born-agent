import {
  projectContainerLifecycle,
  type ContainerCleanupResolution,
  type ContainerLifecycleFact,
  type ContainerLifecycleProjection,
} from "./container-lifecycle.js";

export type ContainerRuntimeObservation =
  | { readonly kind: "daemon_unavailable" }
  | {
      readonly absentById: boolean;
      readonly absentByName: boolean;
      readonly kind: "absent";
    }
  | { readonly kind: "identity_mismatch" }
  | {
      readonly containerId: string;
      readonly kind: "present_exact";
      readonly state: "created" | "dead" | "exited" | "removing" | "running";
    };

export type ContainerReconciliationAction =
  | { readonly type: "collect_bounded_logs" }
  | { readonly type: "inspect_exact" }
  | { readonly type: "kill_if_still_running" }
  | { readonly type: "remove_force_exact" }
  | { readonly type: "record_exited" }
  | { readonly type: "record_stopping" }
  | { readonly type: "record_terminal_inspect" }
  | {
      readonly resolution: ContainerCleanupResolution;
      readonly type: "record_recovered_cleaned";
    }
  | { readonly type: "stop_exact" }
  | { readonly type: "wait_terminal" }
  | { readonly type: "prove_absent_by_id" }
  | { readonly type: "prove_absent_by_name" };

export interface ContainerReconciliationPlan {
  readonly actions: readonly ContainerReconciliationAction[];
  readonly disposition:
    | "blocked"
    | "cleanup_only"
    | "effect_unknown_cleanup"
    | "resolved";
  readonly mayReplayCommand: false;
  readonly reason: string;
}

function fact(
  projection: ContainerLifecycleProjection,
  type: ContainerLifecycleFact["type"],
): ContainerLifecycleFact | undefined {
  return projection.facts.find((candidate) => candidate.type === type);
}

function cleanupTail(
  resolution: ContainerCleanupResolution,
): readonly ContainerReconciliationAction[] {
  return Object.freeze([
    { type: "remove_force_exact" },
    { type: "prove_absent_by_id" },
    { type: "prove_absent_by_name" },
    { resolution, type: "record_recovered_cleaned" },
  ] as const);
}

function result(
  disposition: ContainerReconciliationPlan["disposition"],
  reason: string,
  actions: readonly ContainerReconciliationAction[] = [],
): ContainerReconciliationPlan {
  return Object.freeze({
    actions: Object.freeze([...actions]),
    disposition,
    mayReplayCommand: false,
    reason,
  });
}

export function planContainerReconciliation(
  prefix: readonly ContainerLifecycleFact[],
  observation: ContainerRuntimeObservation,
): ContainerReconciliationPlan {
  const projection = projectContainerLifecycle(prefix);
  if (projection.cleanupState === "verified") {
    return result("resolved", "cleanup is already durably verified");
  }
  if (observation.kind === "daemon_unavailable") {
    return result(
      "blocked",
      "Docker daemon unavailable; terminal state and absence cannot be proven",
    );
  }
  if (observation.kind === "identity_mismatch") {
    return result(
      "blocked",
      "reserved name or id belongs to a different nonce identity",
    );
  }
  const created = fact(projection, "created") !== undefined;
  const startRequested = fact(projection, "start_requested") !== undefined;
  const inspected = fact(projection, "inspected") !== undefined;
  if (observation.kind === "absent") {
    if (!observation.absentById || !observation.absentByName) {
      return result(
        "blocked",
        "cleanup needs exact absence proof by both container id and reserved name",
      );
    }
    const resolution: ContainerCleanupResolution = inspected
      ? "terminal_inspected"
      : startRequested
        ? "effect_unknown_absent"
        : created
          ? "never_started"
          : "never_created";
    return result(
      startRequested && !inspected ? "effect_unknown_cleanup" : "cleanup_only",
      startRequested && !inspected
        ? "container is absent but the prior start effect has no terminal evidence"
        : "container absence can be recorded without replay",
      [{ resolution, type: "record_recovered_cleaned" }],
    );
  }
  if (
    projection.containerId !== null &&
    observation.containerId !== projection.containerId
  ) {
    return result(
      "blocked",
      "runtime observation does not match the exact durable container id",
    );
  }
  if (inspected) {
    return result(
      "cleanup_only",
      "terminal evidence exists; remove exact object and prove absence",
      cleanupTail("terminal_inspected"),
    );
  }
  if (!startRequested) {
    if (observation.state === "running") {
      return result(
        "blocked",
        "container is running without a durable start request",
      );
    }
    const prefixActions: ContainerReconciliationAction[] =
      [];
    return result(
      "cleanup_only",
      "container was never durably authorized to start and must not be started now",
      [
        ...prefixActions,
        ...cleanupTail(created ? "never_started" : "never_created"),
      ],
    );
  }
  if (observation.state === "running") {
    return result(
      "effect_unknown_cleanup",
      "unknown start effect is running; stop process tree and collect terminal evidence",
      [
        { type: "inspect_exact" },
        { type: "record_stopping" },
        { type: "stop_exact" },
        { type: "kill_if_still_running" },
        { type: "wait_terminal" },
        { type: "record_exited" },
        { type: "collect_bounded_logs" },
        { type: "record_terminal_inspect" },
        ...cleanupTail("terminal_inspected"),
      ],
    );
  }
  if (observation.state === "exited" || observation.state === "dead") {
    return result(
      "effect_unknown_cleanup",
      "unknown start effect exited; recover bounded logs and terminal inspect without replay",
      [
        { type: "collect_bounded_logs" },
        { type: "wait_terminal" },
        { type: "record_exited" },
        { type: "record_terminal_inspect" },
        ...cleanupTail("terminal_inspected"),
      ],
    );
  }
  return result(
    "effect_unknown_cleanup",
    "start was requested but no terminal evidence exists; remove without replay",
    [
      { type: "inspect_exact" },
      ...cleanupTail("effect_unknown_absent"),
    ],
  );
}
