import { createHash } from "node:crypto";

import { ArtifactSessionRuntime } from "../artifacts/artifact-session-runtime.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { HookError } from "./hook-errors.js";
import type { HookCommandOperationRecordV1 } from "./hook-command-operation-schema.js";
import {
  HookCommandOperationStore,
  listHookCommandOperationRecords,
} from "./hook-command-operation-store.js";

const TERMINAL_TYPES = new Set([
  "hook.invocation.completed",
  "hook.invocation.decided",
  "hook.invocation.failed",
]);

function operationError(message: string, cause?: unknown): HookError {
  return new HookError(
    "hook_effect_unknown",
    message,
    1,
    cause === undefined ? undefined : { cause },
  );
}

function artifactId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function runEvents(
  events: readonly DecodedStoredEvent[],
  runId: string,
): readonly Extract<DecodedStoredEvent, { readonly scope: "run" }>[] {
  return events.filter(
    (event): event is Extract<DecodedStoredEvent, { readonly scope: "run" }> =>
      event.scope === "run" && event.runId === runId,
  );
}

function validateRequested(
  record: HookCommandOperationRecordV1,
  events: readonly DecodedStoredEvent[],
): void {
  const requested = events.filter((event) => event.eventId === record.requestedEventId);
  if (requested.length !== 1) {
    throw operationError("Hook operation does not have one exact durable request event");
  }
  const event = requested[0]!;
  if (
    event.scope !== "run" ||
    event.runId !== record.runId ||
    event.type !== "hook.invocation.requested" ||
    event.data.handler !== "command" ||
    event.data.hook_input_sha256 !== record.inputSha256 ||
    event.data.invocation_id !== record.invocationId ||
    event.data.mode !== record.mode ||
    sha256Canonical(event.data.hook_identity) !== record.hookIdentitySha256
  ) {
    throw operationError("Hook operation request binding disagrees with the session ledger");
  }
}

function terminalEvents(
  record: HookCommandOperationRecordV1,
  events: readonly DecodedStoredEvent[],
): readonly Extract<DecodedStoredEvent, { readonly scope: "run" }>[] {
  return runEvents(events, record.runId).filter((event) => {
    if (!TERMINAL_TYPES.has(event.type)) return false;
    return "invocation_id" in event.data && event.data.invocation_id === record.invocationId;
  });
}

function expectedTerminalType(
  record: Extract<HookCommandOperationRecordV1, { readonly state: "captured" | "terminal" }>,
): "hook.invocation.completed" | "hook.invocation.decided" | "hook.invocation.failed" {
  return record.capture.kind === "gate"
    ? "hook.invocation.decided"
    : record.capture.kind === "observer"
      ? "hook.invocation.completed"
      : "hook.invocation.failed";
}

export interface HookCommandOperationReconciliationResult {
  readonly backfilled: number;
  readonly inspected: number;
  readonly terminalMarked: number;
}

export class HookCommandOperationReconciler {
  constructor(private readonly options: {
    readonly operationRoot: string;
    readonly randomUUID: () => string;
    readonly sessionId: string;
    readonly timestamp: () => string;
    readonly workspace: string;
    readonly writer: V2SessionWriter;
  }) {}

  async reconcile(): Promise<HookCommandOperationReconciliationResult> {
    const records = await listHookCommandOperationRecords({
      root: this.options.operationRoot,
      sessionId: this.options.sessionId,
    });
    let backfilled = 0;
    let terminalMarked = 0;
    for (const initial of records) {
      validateRequested(initial, this.options.writer.events);
      const store = await HookCommandOperationStore.openExisting({
        invocationId: initial.invocationId,
        root: this.options.operationRoot,
        runId: initial.runId,
        sessionId: initial.sessionId,
      });
      let record = (await store.read())!;
      const existingTerminals = terminalEvents(record, this.options.writer.events);
      if (existingTerminals.length > 1) {
        throw operationError("Hook operation has duplicate session terminal events");
      }
      if (existingTerminals.length === 1) {
        const existing = existingTerminals[0]!;
        if (
          record.state !== "captured" && record.state !== "terminal" ||
          existing.eventId !== record.terminalEventId ||
          existing.type !== expectedTerminalType(record)
        ) {
          throw operationError("Hook operation terminal identity conflicts with the session ledger");
        }
        if (record.state === "captured") {
          await store.markTerminal({
            committedAt: this.options.timestamp(),
            nonce: this.options.randomUUID(),
            terminalEventId: record.terminalEventId,
            terminalType: existing.type,
          });
          terminalMarked += 1;
        }
        continue;
      }
      if (record.state === "terminal") {
        throw operationError("Hook operation claims a terminal that is absent from the session ledger");
      }
      if (record.state === "requested") {
        const ownerDeathIsDurable = this.options.writer.events.some(
          (event) => event.scope === "session" &&
            event.type === "session.lock.recovered" &&
            event.data.previous_nonce_sha256 === record.sessionLockNonceSha256 &&
            event.data.reason === "owner_confirmed_dead",
        );
        if (!ownerDeathIsDurable) {
          throw operationError("requested Hook operation has no exact dead-owner recovery fact");
        }
        record = await store.markNotStartedCaptured({
          capturedAt: this.options.timestamp(),
          code: "hook_invocation_failed",
          nonce: this.options.randomUUID(),
        });
      }
      if (record.state === "spawning" || record.state === "started") {
        throw operationError(
          record.state === "started"
            ? "started Hook operation has no provable Host capture"
            : "Hook spawn boundary is ambiguous after supervisor interruption",
        );
      }
      if (record.state !== "captured") {
        throw operationError("Hook operation recovery reached an unsupported state");
      }

      const type = expectedTerminalType(record);
      if (record.capture.kind === "failure") {
        await this.options.writer.appendRunEventWithId(record.runId, record.terminalEventId, type, {
          code: record.capture.code,
          effect_state: record.capture.effectState,
          failure_policy: record.failurePolicy,
          invocation_id: record.invocationId,
        });
      } else {
        const outputBytes = Buffer.from(canonicalJson({
          action_sha256: record.capture.actionSha256,
          kind: record.capture.kind,
          stderr: record.capture.stderr,
          stdout: record.capture.stdout,
        }), "utf8");
        const expectedArtifactId = artifactId(outputBytes);
        const existingArtifactIds = runEvents(this.options.writer.events, record.runId).flatMap(
          (event) => event.type === "artifact.stored" &&
            event.data.artifact_id === expectedArtifactId &&
            event.data.origin_event_id === record.requestedEventId
            ? [event.data.artifact_id]
            : [],
        );
        if (existingArtifactIds.length > 1) {
          throw operationError("Hook output has duplicate exact artifact facts");
        }
        let outputArtifactId = existingArtifactIds[0];
        if (outputArtifactId === undefined) {
          const artifacts = await ArtifactSessionRuntime.create({
            eventAppender: {
              appendArtifactEvent: (runId, event) => this.options.writer.appendArtifactEvent(runId, event),
            },
            events: this.options.writer.events,
            runId: record.runId,
            sessionId: record.sessionId,
            workspace: this.options.workspace,
          });
          outputArtifactId = (await artifacts.materializeText({
            bytes: outputBytes,
            mediaType: "text/plain; charset=utf-8",
            originEventId: record.requestedEventId,
          })).artifactId;
          if (outputArtifactId !== expectedArtifactId) {
            throw operationError("Hook output artifact identity changed during recovery");
          }
        }
        if (record.capture.kind === "gate") {
          await this.options.writer.appendRunEventWithId(record.runId, record.terminalEventId, type, {
            ...(record.capture.code === undefined ? {} : { code: record.capture.code }),
            decision: record.capture.decision,
            evidence: [...new Set([...record.capture.evidence, outputArtifactId])],
            invocation_id: record.invocationId,
            ...(record.capture.message === undefined ? {} : { message: record.capture.message }),
          });
        } else {
          await this.options.writer.appendRunEventWithId(record.runId, record.terminalEventId, type, {
            artifact_ids: [outputArtifactId],
            invocation_id: record.invocationId,
            ...(record.capture.message === undefined ? {} : { message: record.capture.message }),
            status: "observed",
          });
        }
      }
      await store.markTerminal({
        committedAt: this.options.timestamp(),
        nonce: this.options.randomUUID(),
        terminalEventId: record.terminalEventId,
        terminalType: type,
      });
      backfilled += 1;
      terminalMarked += 1;
    }
    return Object.freeze({ backfilled, inspected: records.length, terminalMarked });
  }
}
