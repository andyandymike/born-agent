import { createHash } from "node:crypto";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type {
  ExecutionResult,
  ExecutionSignal,
  Executor,
  PreparedExecution,
  SandboxEphemeralChangeEvidence,
} from "../execution-types.js";
import {
  NodeWorkspaceSnapshotSink,
} from "../snapshot/node-workspace-snapshot-adapters.js";
import { inspectSnapshotDiff } from "../snapshot/snapshot-diff-inspector.js";
import { WorkspaceSnapshotter } from "../snapshot/workspace-snapshotter.js";
import {
  buildDockerCreateArgv,
  type DockerContainerIdentity,
} from "./docker-cli-argv.js";
import {
  projectContainerLifecycle,
  type ContainerCleanupResolution,
  type ContainerLifecycleFact,
  type ContainerLifecycleIdentity,
  type DetachedContainerRuntimePort,
  type SanitizedContainerInspection,
} from "./container-lifecycle.js";
import {
  isDockerPreparedExecution,
  type DockerPreparedExecution,
} from "./docker-execution-preparer.js";
import type { SandboxEventAppender } from "./sandbox-event-schema.js";
import { persistDockerExecutionImageIdentity } from "./acquisition/docker-image-identity.js";

type StopReason = Extract<ContainerLifecycleFact, { type: "stopping" }>["reason"];

export class DockerExecutorError extends Error {
  override readonly name = "DockerExecutorError";

  public constructor(
    readonly code: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export interface DockerExecutorOptions {
  readonly clock: { now(): number };
  readonly events: SandboxEventAppender;
  readonly randomUUID: () => string;
  readonly redact: (value: string) => string;
  readonly runtime: DetachedContainerRuntimePort;
}

interface OutputState {
  stderr: string[];
  stderrBytes: number;
  stdout: string[];
  stdoutBytes: number;
  truncated: boolean;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function result(input: {
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly exitCode: number | null;
  readonly output: OutputState;
  readonly processIdentity?: string;
  readonly sandboxEphemeralChanges?: SandboxEphemeralChangeEvidence;
  readonly termination: ExecutionResult["termination"];
}): ExecutionResult {
  return Object.freeze({
    cleanupVerified: true,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    exitCode: input.exitCode,
    ok: input.termination === "exit" && input.exitCode === 0,
    ...(input.processIdentity === undefined
      ? {}
      : { processIdentity: input.processIdentity }),
    signal: null,
    ...(input.sandboxEphemeralChanges === undefined
      ? {}
      : { sandboxEphemeralChanges: input.sandboxEphemeralChanges }),
    stderr: input.output.stderr.join(""),
    stderrBytes: input.output.stderrBytes,
    stdout: input.output.stdout.join(""),
    stdoutBytes: input.output.stdoutBytes,
    termination: input.termination,
    truncated: input.output.truncated,
  });
}

function emptyOutput(): OutputState {
  return { stderr: [], stderrBytes: 0, stdout: [], stdoutBytes: 0, truncated: false };
}

function lifecycleIdentity(
  prepared: DockerPreparedExecution,
  identity: DockerContainerIdentity,
): ContainerLifecycleIdentity {
  return Object.freeze({
    ...identity,
    image: prepared.docker.image.image,
    imageIdentity: prepared.docker.image.identity,
    snapshotSha256: prepared.docker.plan.manifest.sha256,
  });
}

function containerIdentitySha256(identity: ContainerLifecycleIdentity): string {
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

function assertExactInspection(
  inspection: SanitizedContainerInspection,
  prepared: DockerPreparedExecution,
  identity: ContainerLifecycleIdentity,
  containerId: string,
): void {
  const labels = inspection.labels;
  if (
    inspection.containerId !== containerId ||
    inspection.name !== identity.name ||
    inspection.imageId !== prepared.docker.image.configImageId ||
    inspection.imageReference !== prepared.docker.image.image.reference ||
    labels["org.bornagent.run-id"] !== identity.runId ||
    labels["org.bornagent.execution-id"] !== identity.executionId ||
    labels["org.bornagent.nonce"] !== identity.nonce ||
    labels["org.bornagent.snapshot-sha256"] !== identity.snapshotSha256
  ) {
    throw new DockerExecutorError(
      "container_identity_mismatch",
      "Docker object does not match the exact durable run/execution/nonce identity",
    );
  }
}

function terminalInspection(
  inspection: SanitizedContainerInspection,
  exitCode: number,
): asserts inspection is SanitizedContainerInspection & {
  readonly exitCode: number;
  readonly finishedAt: string;
  readonly startedAt: string;
} {
  if (
    inspection.running ||
    inspection.exitCode !== exitCode ||
    inspection.finishedAt === null ||
    inspection.startedAt === null
  ) {
    throw new DockerExecutorError(
      "container_terminal_mismatch",
      "Docker wait and terminal inspect evidence do not match",
    );
  }
}

export class DockerExecutor implements Executor {
  public constructor(private readonly options: DockerExecutorOptions) {}

  async *execute(
    preparedInput: PreparedExecution,
    signal: AbortSignal,
  ): AsyncIterable<ExecutionSignal> {
    const startedAt = this.options.clock.now();
    if (!isDockerPreparedExecution(preparedInput)) {
      yield {
        result: result({
          durationMs: this.options.clock.now() - startedAt,
          errorCode: "docker_prepared_execution_required",
          exitCode: null,
          output: emptyOutput(),
          termination: "spawn_error",
        }),
        type: "completed",
      };
      return;
    }
    const prepared = preparedInput;
    const executionId = prepared.docker.executionId;
    if (executionId === null) {
      yield {
        result: result({
          durationMs: this.options.clock.now() - startedAt,
          errorCode: "docker_execution_context_missing",
          exitCode: null,
          output: emptyOutput(),
          termination: "spawn_error",
        }),
        type: "completed",
      };
      return;
    }

    const sink = new NodeWorkspaceSnapshotSink(
      prepared.docker.workspaceRealPath,
      prepared.docker.runId,
      executionId,
    );
    let snapshotCreated = false;
    try {
      await new WorkspaceSnapshotter(
        prepared.docker.source,
        sink,
      ).materializeApproved(prepared.docker.plan, signal);
      snapshotCreated = true;
    } catch {
      yield {
        result: result({
          durationMs: this.options.clock.now() - startedAt,
          errorCode: signal.aborted ? "sandbox_snapshot_cancelled" : "sandbox_snapshot_failed",
          exitCode: null,
          output: emptyOutput(),
          termination: signal.aborted ? "cancelled" : "spawn_error",
        }),
        type: "completed",
      };
      return;
    }

    try {
      await this.options.events.append("sandbox.snapshot.created", {
        action_sha256: prepared.actionSha256,
        execution_id: executionId,
        file_count: prepared.docker.plan.manifest.fileCount,
        image_digest: prepared.docker.image.image.digest,
        image_identity: persistDockerExecutionImageIdentity(
          prepared.docker.image.identity,
        ),
        limits: {
          cpus: prepared.docker.limits.cpus,
          memory_mib: prepared.docker.limits.memoryMiB,
          pids: prepared.docker.limits.pids,
          tmp_mib: prepared.docker.limits.tmpMiB,
        },
        network: "none",
        omitted: [...prepared.docker.plan.manifest.omitted],
        policy_version: prepared.docker.image.policy.imagePolicyVersion,
        snapshot_sha256: prepared.docker.plan.manifest.sha256,
        source_state_sha256: prepared.docker.plan.sourceStateSha256,
        total_bytes: prepared.docker.plan.manifest.totalBytes,
      });
    } catch (error) {
      try {
        await sink.cleanupAndVerify();
        snapshotCreated = false;
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "snapshot event persistence and cleanup both failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }

    let identity: ContainerLifecycleIdentity | undefined;
    let identitySha256: string | undefined;
    let containerId: string | undefined;
    const facts: ContainerLifecycleFact[] = [];
    const appendFact = async (fact: ContainerLifecycleFact): Promise<void> => {
      projectContainerLifecycle([...facts, fact]);
      if (identity === undefined || identitySha256 === undefined) {
        if (fact.type !== "create_requested") {
          throw new DockerExecutorError("container_identity_missing", "container lifecycle identity is missing");
        }
        identity = fact.identity;
        identitySha256 = containerIdentitySha256(identity);
      }
      const common = {
        action_sha256: prepared.actionSha256,
        container_identity_sha256: identitySha256,
        execution_id: executionId,
      };
      switch (fact.type) {
        case "create_requested":
          await this.options.events.append("sandbox.container.create.requested", {
            ...common,
            container_name: fact.identity.name,
            hostname: fact.identity.hostname,
            image_digest: fact.identity.image.digest,
            ...(fact.identity.imageIdentity === undefined
              ? {}
              : {
                  image_identity: persistDockerExecutionImageIdentity(
                    fact.identity.imageIdentity,
                  ),
                }),
            nonce: fact.identity.nonce,
            snapshot_sha256: fact.identity.snapshotSha256,
          });
          break;
        case "created":
          await this.options.events.append("sandbox.container.created", {
            ...common,
            container_id: fact.containerId,
            container_id_sha256: sha256(fact.containerId),
          });
          break;
        case "start_requested":
          await this.options.events.append("sandbox.container.start.requested", common);
          break;
        case "started":
          await this.options.events.append("sandbox.container.started", common);
          break;
        case "stopping":
          await this.options.events.append("sandbox.container.stopping", {
            ...common,
            reason: fact.reason,
          });
          break;
        case "exited":
          await this.options.events.append("sandbox.container.exited", {
            ...common,
            exit_code: fact.exitCode,
            recovered: fact.recovered,
          });
          break;
        case "inspected":
          await this.options.events.append("sandbox.container.inspected", {
            ...common,
            exit_code: fact.exitCode,
            finished_at: fact.finishedAt,
            oom_killed: fact.oomKilled,
            started_at: fact.startedAt,
            state_error: fact.stateError,
          });
          break;
        case "cleaned":
          await this.options.events.append("sandbox.container.cleaned", {
            ...common,
            absent_by_id: true,
            absent_by_name: true,
            recovered: fact.recovered,
            resolution: fact.resolution,
          });
          break;
      }
      facts.push(fact);
    };

    const cleanupSnapshot = async (): Promise<
      SandboxEphemeralChangeEvidence | undefined
    > => {
      if (!snapshotCreated) return undefined;
      const diff = await inspectSnapshotDiff(
        sink.workspacePath,
        prepared.docker.plan.manifest,
      );
      await this.options.events.append("sandbox.snapshot.changed", {
        action_sha256: prepared.actionSha256,
        after_sha256: diff.afterSha256,
        before_sha256: diff.beforeSha256,
        created: diff.created,
        deleted: diff.deleted,
        execution_id: executionId,
        modified: diff.modified,
        paths: [...diff.paths],
        special_entries: diff.specialEntries,
        truncated: diff.truncated,
      });
      await sink.cleanupAndVerify();
      snapshotCreated = false;
      await this.options.events.append("sandbox.snapshot.cleaned", {
        action_sha256: prepared.actionSha256,
        cleanup_verified: true,
        execution_id: executionId,
        snapshot_sha256: prepared.docker.plan.manifest.sha256,
      });
      return diff;
    };

    const proveAbsentAndClean = async (
      resolution: ContainerCleanupResolution,
      recovered: boolean,
    ): Promise<void> => {
      if (containerId !== undefined) await this.options.runtime.removeForce(containerId);
      const absentId =
        containerId === undefined ||
        (await this.options.runtime.inspectById(containerId)) === null;
      const absentName =
        identity !== undefined &&
        (await this.options.runtime.inspectByName(identity.name)) === null;
      if (!absentId || !absentName) {
        throw new DockerExecutorError("container_cleanup_unknown", "exact Docker id/name absence could not be proven");
      }
      await appendFact({
        absentById: true,
        absentByName: true,
        recovered,
        resolution,
        type: "cleaned",
      });
    };

    try {
      const create = buildDockerCreateArgv({
        command: {
          args: prepared.docker.commandArgs,
          containerCwd: prepared.docker.containerCwd,
          logicalExecutable: prepared.request.logicalExecutable,
        },
        image: prepared.docker.image,
        limits: prepared.docker.limits,
        nonce: this.options.randomUUID(),
        snapshot: {
          executionId,
          hostPlatform: prepared.docker.hostPlatform,
          runId: prepared.docker.runId,
          sandboxRoot: sink.sandboxRoot,
          snapshotSha256: prepared.docker.plan.manifest.sha256,
          snapshotWorkspacePath: sink.workspacePath,
        },
      });
      await appendFact({
        identity: lifecycleIdentity(prepared, create.identity),
        type: "create_requested",
      });
      try {
        containerId = await this.options.runtime.create(create.argv, signal);
      } catch {
        const observed = await this.options.runtime.inspectByName(create.identity.name);
        if (observed !== null) {
          containerId = observed.containerId;
          assertExactInspection(observed, prepared, identity!, containerId);
        }
        await proveAbsentAndClean("never_created", true);
        await cleanupSnapshot();
        yield {
          result: result({
            durationMs: this.options.clock.now() - startedAt,
            errorCode: signal.aborted ? "docker_create_cancelled" : "docker_create_failed",
            exitCode: null,
            output: emptyOutput(),
            termination: signal.aborted ? "cancelled" : "spawn_error",
          }),
          type: "completed",
        };
        return;
      }

      const [byId, byName] = await Promise.all([
        this.options.runtime.inspectById(containerId),
        this.options.runtime.inspectByName(identity!.name),
      ]);
      if (byId === null || byName === null || byId.containerId !== byName.containerId) {
        throw new DockerExecutorError("container_create_unreconciled", "created Docker object could not be reconciled by exact id and name");
      }
      assertExactInspection(byId, prepared, identity!, containerId);
      await appendFact({ containerId, type: "created" });
      // PHASE13: Persisting start_requested before daemon start preserves the
      // effect-unknown boundary after a crash. Even a container that exits
      // immediately still needs wait + terminal inspect + exact removal proof;
      // the Docker CLI process ending never proves its process tree is gone.
      await appendFact({ type: "start_requested" });
      try {
        await this.options.runtime.startDetached(containerId, signal);
      } catch (error) {
        await this.reconcileUnknownStart(
          prepared,
          identity!,
          containerId,
          appendFact,
        );
        await cleanupSnapshot();
        throw new DockerExecutorError(
          "container_start_effect_unknown",
          "Docker start outcome required recovery and the command will not be replayed",
          { cause: error },
        );
      }
      await appendFact({ recovered: false, type: "started" });
      const processIdentity = `docker:${identitySha256}`;
      yield { processIdentity, type: "started" };

      const output = emptyOutput();
      const lifecycleAbort = new AbortController();
      const iterator = this.options.runtime
        .collectBoundedLogs(containerId, lifecycleAbort.signal)[Symbol.asyncIterator]();
      let nextLog = iterator.next().then(
        (value) => ({ kind: "log" as const, value }),
        (error: unknown) => ({ error, kind: "log_error" as const }),
      );
      let waitDone = false;
      let logsDone = false;
      let exitCode: number | undefined;
      let stopReason: StopReason | undefined;
      const wait = this.options.runtime.wait(containerId, lifecycleAbort.signal).then(
        (value) => ({ kind: "wait" as const, value }),
        (error: unknown) => ({ error, kind: "wait_error" as const }),
      );
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), prepared.request.timeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<{ kind: "abort" }>((resolve) => {
        if (signal.aborted) resolve({ kind: "abort" });
        else {
          abortListener = () => resolve({ kind: "abort" });
          signal.addEventListener("abort", abortListener, { once: true });
        }
      });

      try {
        while ((!waitDone || !logsDone) && stopReason === undefined) {
          const candidates: Promise<
            | Awaited<typeof nextLog>
            | Awaited<typeof wait>
            | { kind: "abort" }
            | { kind: "timeout" }
          >[] = [aborted, timeout];
          if (!logsDone) candidates.push(nextLog);
          if (!waitDone) candidates.push(wait);
          const outcome = await Promise.race(candidates);
          if (outcome.kind === "wait") {
            waitDone = true;
            exitCode = outcome.value;
          } else if (outcome.kind === "wait_error") {
            stopReason = "wait_error";
          } else if (outcome.kind === "abort") {
            stopReason = "abort";
          } else if (outcome.kind === "timeout") {
            stopReason = "timeout";
          } else if (outcome.kind === "log_error") {
            stopReason = "wait_error";
          } else if (outcome.value.done) {
            logsDone = true;
          } else {
            const entry = outcome.value.value;
            const sanitized = this.options.redact(entry.text);
            const currentBytes = output.stdoutBytes + output.stderrBytes;
            const remaining = Math.max(0, prepared.request.outputLimitBytes - currentBytes);
            const selected = utf8Prefix(sanitized, remaining);
            if (selected.length > 0) {
              const bytes = Buffer.byteLength(selected, "utf8");
              output[entry.stream].push(selected);
              if (entry.stream === "stdout") output.stdoutBytes += bytes;
              else output.stderrBytes += bytes;
              yield { chunk: selected, chunkBytes: bytes, stream: entry.stream, type: "output" };
            }
            if (Buffer.byteLength(sanitized, "utf8") > remaining) {
              output.truncated = true;
              stopReason = "output_limit";
            } else {
              nextLog = iterator.next().then(
                (value) => ({ kind: "log" as const, value }),
                (error: unknown) => ({ error, kind: "log_error" as const }),
              );
            }
          }
        }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (abortListener !== undefined) {
          signal.removeEventListener("abort", abortListener);
        }
      }

      if (stopReason !== undefined) {
        lifecycleAbort.abort();
        await appendFact({ reason: stopReason, type: "stopping" });
        let inspection = await this.options.runtime.inspectById(containerId);
        if (inspection === null) {
          throw new DockerExecutorError("container_disappeared", "Docker container disappeared before terminal evidence");
        }
        assertExactInspection(inspection, prepared, identity!, containerId);
        if (inspection.running) {
          await this.options.runtime.stop(containerId, 5).catch(() => undefined);
          inspection = await this.options.runtime.inspectById(containerId);
          if (inspection?.running) {
            await this.options.runtime.kill(containerId);
            inspection = await this.options.runtime.inspectById(containerId);
          }
        }
        if (inspection === null || inspection.running) {
          throw new DockerExecutorError("container_stop_unknown", "Docker process tree cleanup could not reach terminal state");
        }
        exitCode = inspection.exitCode ??
          (await this.options.runtime.wait(containerId, new AbortController().signal));
      } else {
        lifecycleAbort.abort();
      }

      if (exitCode === undefined) {
        throw new DockerExecutorError("container_exit_unknown", "Docker wait produced no terminal exit code");
      }
      await appendFact({ exitCode, recovered: false, type: "exited" });
      const inspected = await this.options.runtime.inspectById(containerId);
      if (inspected === null) {
        throw new DockerExecutorError("container_inspect_missing", "Docker terminal object disappeared before inspection");
      }
      assertExactInspection(inspected, prepared, identity!, containerId);
      terminalInspection(inspected, exitCode);
      await appendFact({
        exitCode,
        finishedAt: inspected.finishedAt,
        oomKilled: inspected.oomKilled,
        startedAt: inspected.startedAt,
        stateError: inspected.stateError,
        type: "inspected",
      });
      await proveAbsentAndClean("terminal_inspected", false);
      const sandboxEphemeralChanges = await cleanupSnapshot();
      if (stopReason === "wait_error") {
        throw new DockerExecutorError(
          "container_wait_or_log_failed",
          "Docker wait or bounded log collection failed after exact cleanup",
        );
      }
      const termination: ExecutionResult["termination"] =
        stopReason === "abort"
          ? "cancelled"
          : stopReason === "timeout"
            ? "timeout"
            : stopReason === "output_limit"
              ? "output_limit_exceeded"
              : "exit";
      const errorCode = inspected.oomKilled
        ? "sandbox_oom"
        : inspected.stateError !== null
          ? "sandbox_runtime_error"
          : undefined;
      yield {
        result: result({
          durationMs: this.options.clock.now() - startedAt,
          ...(errorCode === undefined ? {} : { errorCode }),
          exitCode,
          output,
          processIdentity,
          ...(sandboxEphemeralChanges === undefined
            ? {}
            : { sandboxEphemeralChanges }),
          termination,
        }),
        type: "completed",
      };
    } catch (error) {
      if (snapshotCreated) {
        await sink.cleanupAndVerify().catch(() => undefined);
      }
      throw error;
    }
  }

  private async reconcileUnknownStart(
    prepared: DockerPreparedExecution,
    identity: ContainerLifecycleIdentity,
    containerId: string,
    appendFact: (fact: ContainerLifecycleFact) => Promise<void>,
  ): Promise<void> {
    let inspection = await this.options.runtime.inspectById(containerId);
    if (inspection === null) {
      const absentName = (await this.options.runtime.inspectByName(identity.name)) === null;
      if (!absentName) {
        throw new DockerExecutorError("container_start_identity_unknown", "reserved Docker name could not be reconciled");
      }
      await appendFact({
        absentById: true,
        absentByName: true,
        recovered: true,
        resolution: "effect_unknown_absent",
        type: "cleaned",
      });
      return;
    }
    assertExactInspection(inspection, prepared, identity, containerId);
    if (inspection.running) {
      await appendFact({ reason: "wait_error", type: "stopping" });
      await this.options.runtime.stop(containerId, 5).catch(() => undefined);
      inspection = await this.options.runtime.inspectById(containerId);
      if (inspection?.running) {
        await this.options.runtime.kill(containerId);
        inspection = await this.options.runtime.inspectById(containerId);
      }
    }
    if (inspection !== null && !inspection.running && inspection.exitCode !== null) {
      await appendFact({ exitCode: inspection.exitCode, recovered: true, type: "exited" });
      terminalInspection(inspection, inspection.exitCode);
      await appendFact({
        exitCode: inspection.exitCode,
        finishedAt: inspection.finishedAt,
        oomKilled: inspection.oomKilled,
        startedAt: inspection.startedAt,
        stateError: inspection.stateError,
        type: "inspected",
      });
      await this.options.runtime.removeForce(containerId);
      const absentById = (await this.options.runtime.inspectById(containerId)) === null;
      const absentByName = (await this.options.runtime.inspectByName(identity.name)) === null;
      if (!absentById || !absentByName) {
        throw new DockerExecutorError("container_cleanup_unknown", "unknown start cleanup could not prove exact absence");
      }
      await appendFact({
        absentById: true,
        absentByName: true,
        recovered: true,
        resolution: "terminal_inspected",
        type: "cleaned",
      });
      return;
    }
    await this.options.runtime.removeForce(containerId);
    const absentById = (await this.options.runtime.inspectById(containerId)) === null;
    const absentByName = (await this.options.runtime.inspectByName(identity.name)) === null;
    if (!absentById || !absentByName) {
      throw new DockerExecutorError("container_cleanup_unknown", "unknown start cleanup could not prove exact absence");
    }
    await appendFact({
      absentById: true,
      absentByName: true,
      recovered: true,
      resolution: "effect_unknown_absent",
      type: "cleaned",
    });
  }
}
