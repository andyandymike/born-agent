import type { DockerContainerIdentity } from "./docker-cli-argv.js";
import type { DigestPinnedImageReference } from "./docker-policy.js";

const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ContainerLifecycleIdentity extends DockerContainerIdentity {
  readonly image: DigestPinnedImageReference;
  readonly snapshotSha256: string;
}

export type ContainerCleanupResolution =
  | "effect_unknown_absent"
  | "never_created"
  | "never_started"
  | "terminal_inspected";

export type ContainerLifecycleFact =
  | {
      readonly identity: ContainerLifecycleIdentity;
      readonly type: "create_requested";
    }
  | {
      readonly containerId: string;
      readonly type: "created";
    }
  | { readonly type: "start_requested" }
  | { readonly recovered: boolean; readonly type: "started" }
  | {
      readonly reason:
        | "abort"
        | "output_limit"
        | "storage_failure"
        | "timeout"
        | "wait_error";
      readonly type: "stopping";
    }
  | {
      readonly exitCode: number;
      readonly recovered: boolean;
      readonly type: "exited";
    }
  | {
      readonly exitCode: number;
      readonly finishedAt: string;
      readonly oomKilled: boolean;
      readonly startedAt: string;
      readonly stateError: string | null;
      readonly type: "inspected";
    }
  | {
      readonly absentById: true;
      readonly absentByName: true;
      readonly recovered: boolean;
      readonly resolution: ContainerCleanupResolution;
      readonly type: "cleaned";
    };

export interface ContainerLifecycleProjection {
  readonly cleanupState: "pending" | "verified";
  readonly containerId: string | null;
  readonly effectState: "none" | "start_unknown" | "started" | "terminal";
  readonly facts: readonly ContainerLifecycleFact[];
  readonly identity: ContainerLifecycleIdentity;
  readonly resumeDisposition:
    | "complete"
    | "incomplete_do_not_replay"
    | "reconcile_only";
  readonly safeToPublishCommandTerminal: boolean;
}

export class ContainerLifecycleError extends Error {
  override readonly name = "ContainerLifecycleError";

  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function assertIdentity(identity: ContainerLifecycleIdentity): void {
  if (
    !/^bornagent-[0-9a-f]{24}$/u.test(identity.name) ||
    !/^born-[0-9a-f]{12}$/u.test(identity.hostname) ||
    !UUID.test(identity.runId) ||
    !UUID.test(identity.executionId) ||
    !UUID.test(identity.nonce) ||
    !SHA256.test(identity.snapshotSha256) ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.image.digest) ||
    identity.image.reference !==
      `${identity.image.repository}@${identity.image.digest}`
  ) {
    throw new ContainerLifecycleError(
      "invalid_lifecycle_identity",
      "container lifecycle identity is not bounded or digest-pinned",
    );
  }
}

function assertExitCode(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new ContainerLifecycleError(
      "invalid_exit_code",
      "container exit code must be an integer from 0 through 255",
    );
  }
}

function assertTimestamp(value: string): void {
  if (
    value.length > 100 ||
    Number.isNaN(Date.parse(value)) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new ContainerLifecycleError(
      "invalid_container_timestamp",
      "container inspection timestamp is invalid",
    );
  }
}

export function projectContainerLifecycle(
  input: readonly ContainerLifecycleFact[],
): ContainerLifecycleProjection {
  const first = input[0];
  if (first?.type !== "create_requested") {
    throw new ContainerLifecycleError(
      "create_request_required",
      "container lifecycle must begin with a durable create request",
    );
  }
  assertIdentity(first.identity);
  let containerId: string | null = null;
  let created = false;
  let startRequested = false;
  let started = false;
  let stopping = false;
  let exited: Extract<ContainerLifecycleFact, { type: "exited" }> | undefined;
  let inspected = false;
  let cleaned: Extract<ContainerLifecycleFact, { type: "cleaned" }> | undefined;
  for (const [index, fact] of input.entries()) {
    if (index === 0) continue;
    if (cleaned !== undefined) {
      throw new ContainerLifecycleError(
        "fact_after_cleanup",
        "container lifecycle cannot append facts after verified cleanup",
      );
    }
    switch (fact.type) {
      case "create_requested":
        throw new ContainerLifecycleError(
          "duplicate_create_request",
          "container create request can only appear once",
        );
      case "created":
        if (created || startRequested || !CONTAINER_ID.test(fact.containerId)) {
          throw new ContainerLifecycleError(
            "invalid_created_fact",
            "created fact must contain one exact full container id",
          );
        }
        created = true;
        containerId = fact.containerId;
        break;
      case "start_requested":
        if (!created || startRequested || exited !== undefined) {
          throw new ContainerLifecycleError(
            "invalid_start_request",
            "start request requires one durable created fact",
          );
        }
        startRequested = true;
        break;
      case "started":
        if (!startRequested || started || exited !== undefined) {
          throw new ContainerLifecycleError(
            "invalid_started_fact",
            "started fact requires one prior durable start request",
          );
        }
        started = true;
        break;
      case "stopping":
        if (!startRequested || stopping || exited !== undefined) {
          throw new ContainerLifecycleError(
            "invalid_stopping_fact",
            "stopping requires an unresolved start side effect",
          );
        }
        stopping = true;
        break;
      case "exited":
        assertExitCode(fact.exitCode);
        if (
          !startRequested ||
          exited !== undefined ||
          inspected ||
          (!started && !fact.recovered)
        ) {
          throw new ContainerLifecycleError(
            "invalid_exited_fact",
            "exit must follow a start request; unobserved starts require recovery evidence",
          );
        }
        exited = fact;
        break;
      case "inspected":
        assertExitCode(fact.exitCode);
        assertTimestamp(fact.startedAt);
        assertTimestamp(fact.finishedAt);
        if (
          exited === undefined ||
          inspected ||
          fact.exitCode !== exited.exitCode ||
          (fact.stateError !== null &&
            (fact.stateError.length > 500 ||
              fact.stateError.includes("\n") ||
              fact.stateError.includes("\r")))
        ) {
          throw new ContainerLifecycleError(
            "invalid_inspected_fact",
            "terminal inspect must uniquely match docker wait evidence",
          );
        }
        inspected = true;
        break;
      case "cleaned": {
        const resolutionValid =
          (fact.resolution === "terminal_inspected" && inspected) ||
          (fact.resolution === "never_created" && !created && !startRequested) ||
          (fact.resolution === "never_started" && created && !startRequested) ||
          (fact.resolution === "effect_unknown_absent" &&
            startRequested &&
            !inspected);
        if (!resolutionValid) {
          throw new ContainerLifecycleError(
            "invalid_cleanup_resolution",
            "cleanup resolution does not match the durable lifecycle prefix",
          );
        }
        cleaned = fact;
        break;
      }
    }
  }
  const effectState = inspected
    ? "terminal"
    : started
      ? "started"
      : startRequested
        ? "start_unknown"
        : "none";
  const safeToPublishCommandTerminal =
    inspected && cleaned?.resolution === "terminal_inspected";
  return Object.freeze({
    cleanupState: cleaned === undefined ? "pending" : "verified",
    containerId,
    effectState,
    facts: Object.freeze([...input]),
    identity: first.identity,
    resumeDisposition:
      cleaned === undefined
        ? "reconcile_only"
        : safeToPublishCommandTerminal
          ? "complete"
          : "incomplete_do_not_replay",
    safeToPublishCommandTerminal,
  });
}

export interface ContainerLifecycleJournal {
  /** Append must be durable before the caller performs its matching side effect. */
  append(fact: ContainerLifecycleFact): Promise<void>;
}

export interface SanitizedContainerInspection {
  readonly containerId: string;
  readonly exitCode: number | null;
  readonly finishedAt: string | null;
  readonly imageId: string;
  readonly imageReference: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly oomKilled: boolean;
  readonly running: boolean;
  readonly status: "created" | "dead" | "exited" | "removing" | "running";
  readonly startedAt: string | null;
  readonly stateError: string | null;
}

export interface DetachedContainerRuntimePort {
  collectBoundedLogs(
    containerId: string,
    signal: AbortSignal,
  ): AsyncIterable<{
    readonly bytes: number;
    readonly stream: "stderr" | "stdout";
    readonly text: string;
  }>;
  create(argv: readonly string[], signal: AbortSignal): Promise<string>;
  inspectById(containerId: string): Promise<SanitizedContainerInspection | null>;
  inspectByName(name: string): Promise<SanitizedContainerInspection | null>;
  kill(containerId: string): Promise<void>;
  removeForce(containerId: string): Promise<void>;
  startDetached(containerId: string, signal: AbortSignal): Promise<void>;
  stop(containerId: string, graceSeconds: number): Promise<void>;
  wait(containerId: string, signal: AbortSignal): Promise<number>;
}
