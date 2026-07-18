import { sha256Canonical } from "../../completion/canonical-json.js";
import type { DecodedRunEvent } from "../../events/event-decoder-registry.js";
import {
  phase13SandboxRunEventDataSchemas,
  type Phase13SandboxRunEventData,
  type Phase13SandboxRunEventType,
} from "./sandbox-event-schema.js";
import {
  projectContainerLifecycle,
  type ContainerCleanupResolution,
  type ContainerLifecycleFact,
  type ContainerLifecycleIdentity,
  type DetachedContainerRuntimePort,
  type SanitizedContainerInspection,
} from "./container-lifecycle.js";
import {
  planContainerReconciliation,
  type ContainerReconciliationAction,
  type ContainerRuntimeObservation,
} from "./container-reconciler.js";
import { parseDigestPinnedImageReference } from "./docker-policy.js";
import {
  persistDockerExecutionImageIdentity,
  restoreDockerExecutionImageIdentity,
} from "./acquisition/docker-image-identity.js";

const MAX_RECOVERED_LOG_BYTES = 1_048_576;
const RECOVERY_LOG_TIMEOUT_MS = 5_000;

export interface ContainerReconciliationRuntimePort
  extends DetachedContainerRuntimePort {
  daemonOperatingSystem(): Promise<string>;
}

export interface ContainerRecoveryEventAppender {
  append<TType extends Phase13SandboxRunEventType>(
    runId: string,
    type: TType,
    data: Phase13SandboxRunEventData<TType>,
  ): Promise<void>;
}

export interface ContainerRecoveryResult {
  readonly attempted: number;
  readonly blocked: readonly string[];
  readonly cleaned: number;
  readonly mayReplayCommand: false;
  readonly pending: number;
}

interface CollectedLifecycle {
  readonly actionSha256: string;
  readonly containerIdentitySha256: string;
  readonly executionId: string;
  readonly facts: readonly ContainerLifecycleFact[];
  readonly runId: string;
}

function identitySha256(identity: ContainerLifecycleIdentity): string {
  return sha256Canonical({
    execution_id: identity.executionId,
    hostname: identity.hostname,
    image_digest: identity.image.digest,
    ...(identity.imageIdentity === undefined
      ? {}
      : {
          image_identity: persistDockerExecutionImageIdentity(
            identity.imageIdentity,
          ),
        }),
    name: identity.name,
    nonce: identity.nonce,
    run_id: identity.runId,
    snapshot_sha256: identity.snapshotSha256,
  });
}

function collectContainerLifecycles(
  events: readonly DecodedRunEvent[],
): readonly CollectedLifecycle[] {
  const started = events.find((event) => event.type === "run.started");
  const imageReference =
    started?.type === "run.started" && "docker_sandbox" in started.data
      ? started.data.docker_sandbox?.image
      : undefined;
  const groups = new Map<
    string,
    {
      actionSha256: string;
      containerIdentitySha256: string;
      executionId: string;
      facts: ContainerLifecycleFact[];
      runId: string;
    }
  >();

  const requireGroup = (
    event: DecodedRunEvent,
    data: {
      readonly action_sha256: string;
      readonly container_identity_sha256: string;
      readonly execution_id: string;
    },
  ) => {
    const group = groups.get(data.execution_id);
    if (
      group === undefined ||
      group.runId !== event.runId ||
      group.actionSha256 !== data.action_sha256 ||
      group.containerIdentitySha256 !== data.container_identity_sha256
    ) {
      throw new Error("sandbox lifecycle event has no matching durable create identity");
    }
    return group;
  };

  for (const event of events) {
    switch (event.type) {
      case "sandbox.container.create.requested": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        const imageIdentity =
          data.image_identity === undefined
            ? undefined
            : restoreDockerExecutionImageIdentity(data.image_identity);
        const selectedReference =
          imageIdentity?.kind === "trusted_local_build"
            ? imageIdentity.configImageId
            : imageIdentity?.kind === "registry_digest"
              ? imageIdentity.reference
              : imageReference;
        if (selectedReference === undefined) {
          throw new Error("sandbox lifecycle has no immutable run image");
        }
        const image =
          imageIdentity?.kind === "trusted_local_build"
            ? Object.freeze({
                digest: imageIdentity.configImageId,
                reference: imageIdentity.configImageId,
                repository: "",
              })
            : parseDigestPinnedImageReference(selectedReference);
        const identity: ContainerLifecycleIdentity = Object.freeze({
          executionId: data.execution_id,
          hostname: data.hostname,
          image,
          ...(imageIdentity === undefined ? {} : { imageIdentity }),
          name: data.container_name,
          nonce: data.nonce,
          runId: event.runId,
          snapshotSha256: data.snapshot_sha256,
        });
        if (
          identity.image.digest !== data.image_digest ||
          (imageReference !== undefined && imageReference !== selectedReference) ||
          identitySha256(identity) !== data.container_identity_sha256 ||
          groups.has(data.execution_id)
        ) {
          throw new Error("sandbox create identity does not match its durable digest");
        }
        groups.set(data.execution_id, {
          actionSha256: data.action_sha256,
          containerIdentitySha256: data.container_identity_sha256,
          executionId: data.execution_id,
          facts: [{ identity, type: "create_requested" }],
          runId: event.runId,
        });
        break;
      }
      case "sandbox.container.created": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({ containerId: data.container_id, type: "created" });
        break;
      }
      case "sandbox.container.start.requested": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({ type: "start_requested" });
        break;
      }
      case "sandbox.container.started": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({ recovered: false, type: "started" });
        break;
      }
      case "sandbox.container.stopping": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({ reason: data.reason, type: "stopping" });
        break;
      }
      case "sandbox.container.exited": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({
          exitCode: data.exit_code,
          recovered: data.recovered,
          type: "exited",
        });
        break;
      }
      case "sandbox.container.inspected": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({
          exitCode: data.exit_code,
          finishedAt: data.finished_at,
          oomKilled: data.oom_killed,
          startedAt: data.started_at,
          stateError: data.state_error,
          type: "inspected",
        });
        break;
      }
      case "sandbox.container.cleaned": {
        const data = phase13SandboxRunEventDataSchemas[event.type].parse(event.data);
        requireGroup(event, data).facts.push({
          absentById: true,
          absentByName: true,
          recovered: data.recovered,
          resolution: data.resolution,
          type: "cleaned",
        });
        break;
      }
      default:
        break;
    }
  }

  return Object.freeze(
    [...groups.values()].map((group) => {
      projectContainerLifecycle(group.facts);
      return Object.freeze({ ...group, facts: Object.freeze([...group.facts]) });
    }),
  );
}

export function countPendingContainerLifecycles(
  events: readonly DecodedRunEvent[],
): number {
  return collectContainerLifecycles(events).filter(
    ({ facts }) => projectContainerLifecycle(facts).cleanupState !== "verified",
  ).length;
}

function exactIdentityMatches(
  inspection: SanitizedContainerInspection,
  identity: ContainerLifecycleIdentity,
  durableContainerId: string | null,
): boolean {
  return (
    (durableContainerId === null || inspection.containerId === durableContainerId) &&
    inspection.name === identity.name &&
    inspection.imageReference === identity.image.reference &&
    (identity.imageIdentity === undefined ||
      inspection.imageId === identity.imageIdentity.configImageId) &&
    inspection.labels["org.bornagent.run-id"] === identity.runId &&
    inspection.labels["org.bornagent.execution-id"] === identity.executionId &&
    inspection.labels["org.bornagent.nonce"] === identity.nonce &&
    inspection.labels["org.bornagent.snapshot-sha256"] === identity.snapshotSha256
  );
}

async function observeRuntime(
  runtime: ContainerReconciliationRuntimePort,
  lifecycle: CollectedLifecycle,
): Promise<{
  readonly inspection: SanitizedContainerInspection | null;
  readonly observation: ContainerRuntimeObservation;
}> {
  try {
    await runtime.daemonOperatingSystem();
  } catch {
    return { inspection: null, observation: { kind: "daemon_unavailable" } };
  }
  const projection = projectContainerLifecycle(lifecycle.facts);
  const [byId, byName] = await Promise.all([
    projection.containerId === null
      ? Promise.resolve(null)
      : runtime.inspectById(projection.containerId),
    runtime.inspectByName(projection.identity.name),
  ]);
  if (byId === null && byName === null) {
    return {
      inspection: null,
      observation: { absentById: true, absentByName: true, kind: "absent" },
    };
  }
  const selected = byId ?? byName;
  if (
    selected === null ||
    (byId !== null && byName !== null && byId.containerId !== byName.containerId) ||
    !exactIdentityMatches(selected, projection.identity, projection.containerId)
  ) {
    return { inspection: selected, observation: { kind: "identity_mismatch" } };
  }
  return {
    inspection: selected,
    observation: {
      containerId: selected.containerId,
      kind: "present_exact",
      state: selected.status,
    },
  };
}

async function drainRecoveredLogs(
  runtime: ContainerReconciliationRuntimePort,
  containerId: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECOVERY_LOG_TIMEOUT_MS);
  let bytes = 0;
  try {
    for await (const chunk of runtime.collectBoundedLogs(containerId, controller.signal)) {
      bytes += chunk.bytes;
      if (bytes > MAX_RECOVERED_LOG_BYTES) {
        throw new Error("recovered Docker logs exceeded their fixed bound");
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function commonData(lifecycle: CollectedLifecycle) {
  return {
    action_sha256: lifecycle.actionSha256,
    container_identity_sha256: lifecycle.containerIdentitySha256,
    execution_id: lifecycle.executionId,
  } as const;
}

async function appendRecoveredCleaned(
  appender: ContainerRecoveryEventAppender,
  lifecycle: CollectedLifecycle,
  resolution: ContainerCleanupResolution,
): Promise<void> {
  await appender.append(lifecycle.runId, "sandbox.container.cleaned", {
    ...commonData(lifecycle),
    absent_by_id: true,
    absent_by_name: true,
    recovered: true,
    resolution,
  });
}

async function executeAction(
  action: ContainerReconciliationAction,
  state: {
    inspection: SanitizedContainerInspection | null;
    readonly lifecycle: CollectedLifecycle;
    readonly runtime: ContainerReconciliationRuntimePort;
    readonly appender: ContainerRecoveryEventAppender;
    terminalExitCode: number | null;
  },
): Promise<void> {
  const projection = projectContainerLifecycle(state.lifecycle.facts);
  const containerId = projection.containerId ?? state.inspection?.containerId ?? null;
  switch (action.type) {
    case "inspect_exact":
      if (containerId === null) throw new Error("exact container id is unavailable");
      state.inspection = await state.runtime.inspectById(containerId);
      if (
        state.inspection === null ||
        !exactIdentityMatches(state.inspection, projection.identity, projection.containerId)
      ) {
        throw new Error("exact container identity changed during reconciliation");
      }
      return;
    case "record_stopping":
      await state.appender.append(state.lifecycle.runId, "sandbox.container.stopping", {
        ...commonData(state.lifecycle),
        reason: "storage_failure",
      });
      return;
    case "stop_exact":
      if (containerId === null) throw new Error("exact container id is unavailable");
      state.inspection = await state.runtime.inspectById(containerId);
      if (state.inspection?.running === true) await state.runtime.stop(containerId, 5);
      return;
    case "kill_if_still_running":
      if (containerId === null) throw new Error("exact container id is unavailable");
      state.inspection = await state.runtime.inspectById(containerId);
      if (state.inspection?.running === true) await state.runtime.kill(containerId);
      return;
    case "wait_terminal":
      if (containerId === null) throw new Error("exact container id is unavailable");
      state.terminalExitCode = await state.runtime.wait(
        containerId,
        new AbortController().signal,
      );
      return;
    case "record_exited":
      if (state.terminalExitCode === null) {
        state.terminalExitCode = state.inspection?.exitCode ?? null;
      }
      if (state.terminalExitCode === null) throw new Error("terminal exit code is unavailable");
      await state.appender.append(state.lifecycle.runId, "sandbox.container.exited", {
        ...commonData(state.lifecycle),
        exit_code: state.terminalExitCode,
        recovered: true,
      });
      return;
    case "collect_bounded_logs":
      if (containerId === null) throw new Error("exact container id is unavailable");
      await drainRecoveredLogs(state.runtime, containerId);
      return;
    case "record_terminal_inspect": {
      if (containerId === null) throw new Error("exact container id is unavailable");
      const inspection = await state.runtime.inspectById(containerId);
      if (
        inspection === null ||
        inspection.running ||
        inspection.exitCode === null ||
        inspection.startedAt === null ||
        inspection.finishedAt === null ||
        !exactIdentityMatches(inspection, projection.identity, projection.containerId)
      ) {
        throw new Error("terminal Docker inspection could not be proven");
      }
      if (
        state.terminalExitCode !== null &&
        inspection.exitCode !== state.terminalExitCode
      ) {
        throw new Error("Docker wait and inspect exit codes do not match");
      }
      state.terminalExitCode = inspection.exitCode;
      state.inspection = inspection;
      await state.appender.append(state.lifecycle.runId, "sandbox.container.inspected", {
        ...commonData(state.lifecycle),
        exit_code: inspection.exitCode,
        finished_at: inspection.finishedAt,
        oom_killed: inspection.oomKilled,
        started_at: inspection.startedAt,
        state_error: inspection.stateError,
      });
      return;
    }
    case "remove_force_exact":
      if (containerId !== null) await state.runtime.removeForce(containerId);
      state.inspection = null;
      return;
    case "prove_absent_by_id":
      if (containerId !== null && (await state.runtime.inspectById(containerId)) !== null) {
        throw new Error("container id is still present after cleanup");
      }
      return;
    case "prove_absent_by_name":
      if ((await state.runtime.inspectByName(projection.identity.name)) !== null) {
        throw new Error("container name is still present after cleanup");
      }
      return;
    case "record_recovered_cleaned":
      await appendRecoveredCleaned(state.appender, state.lifecycle, action.resolution);
      return;
  }
}

export async function reconcilePersistedContainers(
  events: readonly DecodedRunEvent[],
  runtime: ContainerReconciliationRuntimePort,
  appender: ContainerRecoveryEventAppender,
): Promise<ContainerRecoveryResult> {
  const pending = collectContainerLifecycles(events).filter(
    ({ facts }) => projectContainerLifecycle(facts).cleanupState !== "verified",
  );
  const blocked: string[] = [];
  let cleaned = 0;
  for (const lifecycle of pending) {
    try {
      const observed = await observeRuntime(runtime, lifecycle);
      const plan = planContainerReconciliation(lifecycle.facts, observed.observation);
      if (plan.disposition === "blocked") {
        blocked.push(`${lifecycle.executionId}:${plan.reason}`);
        continue;
      }
      // PHASE13: recovery executes only the exact cleanup plan derived from a
      // durable identity. There is deliberately no action capable of starting,
      // attaching to, or replaying the interrupted command.
      const state = {
        appender,
        inspection: observed.inspection,
        lifecycle,
        runtime,
        terminalExitCode: observed.inspection?.exitCode ?? null,
      };
      for (const action of plan.actions) await executeAction(action, state);
      cleaned += 1;
    } catch (error) {
      blocked.push(
        `${lifecycle.executionId}:${error instanceof Error ? error.message : "container reconciliation failed"}`,
      );
    }
  }
  return Object.freeze({
    attempted: pending.length,
    blocked: Object.freeze(blocked),
    cleaned,
    mayReplayCommand: false,
    pending: pending.length,
  });
}
