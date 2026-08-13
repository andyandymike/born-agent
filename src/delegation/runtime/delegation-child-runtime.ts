import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import type { CliIO } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { currentProcessIdentity } from "../../sessions/process-identity.js";
import { SessionCatalog } from "../../sessions/session-catalog.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { DelegationOperationStore } from "../delegation-operation-store.js";
import type { DelegationChildOperationV1 } from "../delegation-operation-schema.js";
import { DelegationError } from "../delegation-errors.js";
import { childReceiptEvidenceSchema } from "../receipts/child-receipt-schema.js";
import { contextCapsuleSchema, type ContextCapsuleV1 } from "../context/context-capsule-schema.js";
import { DelegatedChildApprovalBridge, type DelegationChildControlChannelV1 } from "./child-approval-bridge.js";
import {
  assertBoundedProtocolFrame,
  delegationChildCancelFrameSchema,
  delegationChildStartSchema,
  type DelegationChildTerminalFrameV1,
} from "./child-handshake-schema.js";
import { executableChildEnvelopeSchema, type ExecutableChildEnvelopeV1 } from "./executable-child-envelope.js";
import { buildChildToolProfile } from "../context/child-tool-profile.js";
import { delegatedBuiltinToolCatalog } from "../context/delegated-tool-catalog.js";
import { childSessionShardWorkspace } from "./child-session-shard.js";

const boundedResultSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 4 * 1024),
  diagnosticCode: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/u).nullable(),
  candidateClaims: z.array(z.object({
    claimId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    kind: z.enum(["answer", "file_observation", "symbol_observation", "change_bundle", "verification_result"]),
    narrative: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 8 * 1024),
    evidence: z.array(childReceiptEvidenceSchema).max(16),
  }).strict()).max(16),
}).strict();

function boundedDiagnosticCode(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as Readonly<Record<string, unknown>>;
    const code = typeof record.code === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(record.code)
      ? record.code
      : null;
    const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(record.name)
      ? record.name
      : null;
    parts.push(code ?? name ?? "UnknownError");
    current = record.cause;
  }
  return parts.join(":").slice(0, 256) || "UnknownError";
}

export interface DelegationChildExecutionPortV1 {
  execute(input: {
    readonly capsule: ContextCapsuleV1;
    readonly envelope: ExecutableChildEnvelopeV1;
    readonly io: CliIO;
    readonly operation: DelegationChildOperationV1;
    readonly onCancel: (listener: (reason: "user_cancel" | "tui_surface_fatal") => void) => () => void;
    readonly prompt: DelegatedChildApprovalBridge;
    readonly writer: V2SessionWriter;
  }): Promise<{
    readonly exitCode: number;
    readonly summary: string;
    readonly candidateClaims: readonly z.infer<typeof boundedResultSchema>["candidateClaims"][number][];
  }>;
}

async function readStableJson(path: string, maximumBytes: number, expectedSha256: string): Promise<unknown> {
  const canonical = await realpath(resolve(path));
  const before = await lstat(canonical);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
    throw new DelegationError("delegation_child_protocol_invalid", "child input is not a bounded regular file");
  }
  const bytes = await readFile(canonical);
  const after = await lstat(canonical);
  if (
    before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  ) {
    throw new DelegationError("delegation_artifact_invalid", "child input changed or failed its exact hash");
  }
  return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** @internal Protocol seam used by deterministic start/cancel race tests. */
export function waitForDelegationChildStart(input: {
  readonly channel: DelegationChildControlChannelV1;
  readonly envelope: ExecutableChildEnvelopeV1;
  readonly timeoutMs: number;
}): Promise<void> {
  return new Promise((resolveStart, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      offMessage();
      offClose();
      if (error === undefined) resolveStart();
      else reject(error);
    };
    const offMessage = input.channel.onMessage((candidate) => {
      const frame = delegationChildStartSchema.safeParse(candidate);
      if (!frame.success) return;
      const actor = input.envelope.prepared.actor;
      if (
        frame.data.operationId !== input.envelope.execution.operationId ||
        frame.data.childAttemptId !== actor.attemptId ||
        frame.data.envelopeSha256 !== input.envelope.envelopeSha256 ||
        frame.data.startBarrierProofSha256 !== input.envelope.execution.startBarrierNonceSha256
      ) {
        finish(new DelegationError("delegation_handshake_failed", "child start barrier proof is stale or spoofed"));
        return;
      }
      finish();
    });
    const offClose = input.channel.onClose(() => finish(new DelegationError("delegation_handshake_failed", "parent channel closed before start barrier")));
    const timeout = setTimeout(() => finish(new DelegationError("delegation_handshake_failed", "child start barrier timed out")), input.timeoutMs);
  });
}

/** @internal Persistent latch spanning handshake, start, and execution. */
export function installDelegationChildCancellationLatch(input: {
  readonly channel: DelegationChildControlChannelV1;
  readonly childAttemptId: string;
  readonly operationId: string;
}) {
  let cancelled = false;
  let reason: "user_cancel" | "tui_surface_fatal" = "user_cancel";
  const listeners = new Set<(reason: "user_cancel" | "tui_surface_fatal") => void>();
  const cancel = (nextReason: "user_cancel" | "tui_surface_fatal") => {
    if (cancelled) return;
    cancelled = true;
    reason = nextReason;
    for (const listener of [...listeners]) listener(reason);
  };
  const offMessage = input.channel.onMessage((candidate) => {
    const frame = delegationChildCancelFrameSchema.safeParse(candidate);
    if (
      frame.success &&
      frame.data.operationId === input.operationId &&
      frame.data.childAttemptId === input.childAttemptId
    ) cancel(frame.data.kind);
  });
  const offClose = input.channel.onClose(() => cancel("user_cancel"));
  return Object.freeze({
    dispose: () => {
      offMessage();
      offClose();
      listeners.clear();
    },
    onCancel: (listener: (reason: "user_cancel" | "tui_surface_fatal") => void) => {
      if (cancelled) {
        listener(reason);
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export class DelegationChildRuntime {
  constructor(private readonly input: {
    readonly channel: DelegationChildControlChannelV1;
    readonly envelopePath: string;
    readonly execute: DelegationChildExecutionPortV1;
    readonly io: CliIO;
    readonly nonce: string;
    readonly operationId: string;
    readonly operationRoot: string;
    readonly randomUuid?: () => string;
    readonly startTimeoutMs?: number;
  }) {}

  async run(): Promise<DelegationChildTerminalFrameV1> {
    const store = await DelegationOperationStore.create({ root: this.input.operationRoot, operationId: this.input.operationId });
    const operation = await store.read();
    if (
      operation === null || operation.operationId !== this.input.operationId ||
      resolve(operation.envelopePath) !== resolve(this.input.envelopePath) ||
      createHash("sha256").update(this.input.nonce, "utf8").digest("hex") !== operation.nonceSha256
    ) {
      throw new DelegationError("delegation_handshake_failed", "child operation, envelope path, or nonce does not exact-match the trusted journal");
    }
    const envelope = executableChildEnvelopeSchema.parse(await readStableJson(
      operation.envelopePath,
      512 * 1024,
      operation.envelopeArtifactSha256,
    ));
    const capsule = contextCapsuleSchema.parse(await readStableJson(
      operation.capsulePath,
      256 * 1024,
      operation.capsuleArtifactSha256,
    ));
    const actor = envelope.prepared.actor;
    if (
      envelope.execution.operationId !== operation.operationId ||
      envelope.execution.sessionId !== operation.sessionId ||
      actor.actorId !== operation.childActorId ||
      actor.attemptId !== operation.childAttemptId ||
      actor.delegationId !== operation.delegationId ||
      envelope.envelopeSha256 !== operation.envelopeSha256 ||
      capsule.capsuleSha256 !== operation.capsuleSha256 ||
      capsule.childActorId !== actor.actorId
    ) {
      throw new DelegationError("delegation_handshake_failed", "child envelope/capsule lineage does not match the operation journal");
    }
    if (
      capsule.constraints.taskProfile !== envelope.prepared.effectiveAuthority.taskProfile ||
      sha256Canonical([...capsule.constraints.toolIds].sort()) !==
        sha256Canonical([...envelope.prepared.effectiveAuthority.toolIds].sort())
    ) {
      throw new DelegationError(
        "delegation_authority_expansion",
        "child capsule and executable envelope have different authority",
      );
    }
    const frozenToolProfile = buildChildToolProfile({
      taskProfile: envelope.prepared.effectiveAuthority.taskProfile,
      requestedToolIds: envelope.prepared.effectiveAuthority.toolIds,
      policyToolIds: envelope.prepared.effectiveAuthority.toolIds,
      parentDelegableToolIds: envelope.prepared.effectiveAuthority.toolIds,
      catalog: delegatedBuiltinToolCatalog(),
    });
    if (
      frozenToolProfile.profileSha256 !== envelope.prepared.preparation.toolProfileSha256 ||
      frozenToolProfile.profileSha256 !== envelope.prepared.model.delegatedToolProfileSha256
    ) {
      throw new DelegationError(
        "delegation_authority_expansion",
        "child tool profile hash differs from the sealed package schemas",
      );
    }
    const handshake = {
      schemaVersion: 1 as const,
      protocolVersion: 1 as const,
      frame: "handshake" as const,
      operationId: operation.operationId,
      childActorId: actor.actorId,
      childAttemptId: actor.attemptId,
      envelopeSha256: envelope.envelopeSha256,
      executableDescriptorSha256: operation.executableDescriptorSha256,
      pid: process.pid,
      processStartIdentity: currentProcessIdentity().startIdentity,
      nonceProofSha256: sha256Canonical({
        nonce: this.input.nonce,
        operation_id: operation.operationId,
        attempt_id: actor.attemptId,
        envelope_sha256: envelope.envelopeSha256,
      }),
    };
    assertBoundedProtocolFrame(handshake);
    this.input.channel.send(handshake);
    // Install a separate persistent listener before accepting start. Unlike
    // the one-shot start listener, this remains active through shard setup and
    // execution, so there is no IPC handoff window in which cancel is lost.
    const cancellation = installDelegationChildCancellationLatch({
      channel: this.input.channel,
      childAttemptId: actor.attemptId,
      operationId: operation.operationId,
    });
    // No provider, tool, credential, or session writer is touched before this
    // exact Host start barrier is accepted.
    try {
      await waitForDelegationChildStart({
        channel: this.input.channel,
        envelope,
        timeoutMs: this.input.startTimeoutMs ?? 30_000,
      });
    } catch (error) {
      cancellation.dispose();
      throw error;
    }
    const running = await store.read();
    if (running?.state !== "running" || running.operationSha256 === operation.operationSha256) {
      throw new DelegationError("delegation_handshake_failed", "operation journal did not durably enter running state before child start");
    }
    const shardWorkspace = childSessionShardWorkspace(operation);
    const writer = await V2SessionWriter.openExisting(shardWorkspace, operation.sessionId, {
      createEventId: this.input.randomUuid ?? randomUUID,
      timestamp: () => new Date().toISOString(),
    });
    const prompt = new DelegatedChildApprovalBridge({
      channel: this.input.channel,
      envelope,
      randomUuid: this.input.randomUuid ?? randomUUID,
      writer,
    });
    let result;
    try {
      result = await this.input.execute.execute({
        capsule,
        envelope,
        io: this.input.io,
        onCancel: cancellation.onCancel,
        operation,
        prompt,
        writer,
      });
    } catch (error) {
      await writer.close().catch(() => undefined);
      result = {
        exitCode: 1,
        summary: "delegated child execution failed before a trusted result was produced",
        candidateClaims: [],
        diagnosticCode: boundedDiagnosticCode(error),
      };
    } finally {
      cancellation.dispose();
    }
    await writer.close().catch(() => undefined);
    const bounded = boundedResultSchema.parse({
      schemaVersion: 1,
      summary: result.summary,
      candidateClaims: result.candidateClaims,
      diagnosticCode: "diagnosticCode" in result ? result.diagnosticCode : null,
    });
    const resultBytes = Buffer.from(JSON.stringify(bounded), "utf8");
    const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
    const resultPath = await store.storePayload("result", resultBytes, resultSha256);
    const current = await store.read();
    if (current === null || current.state !== "running") {
      throw new DelegationError("delegation_child_protocol_invalid", "operation ownership changed before terminal observation");
    }
    await store.compareAndSwap({
      expectedSha256: current.operationSha256,
      expectedState: "running",
      now: new Date().toISOString(),
      mutate: (value) => ({
        ...value,
        boundedResultRef: resultPath,
        boundedResultSha256: resultSha256,
        state: "terminal_observed",
      }),
    });
    const session = await new SessionCatalog(shardWorkspace).read(operation.sessionId);
    const childRun = session.runs.find((run) => run.runId === operation.childRunId);
    const terminal: DelegationChildTerminalFrameV1 = {
      schemaVersion: 1,
      protocolVersion: 1,
      frame: "terminal",
      operationId: operation.operationId,
      childAttemptId: actor.attemptId,
      childRunId: operation.childRunId,
      exitCode: Math.max(0, Math.min(255, result.exitCode)),
      observedTerminalEventId: childRun?.terminal?.eventId ?? null,
      diagnosticCode: childRun?.terminal === undefined ? "delegation_run_terminal_missing" : null,
    };
    assertBoundedProtocolFrame(terminal);
    this.input.channel.send(terminal);
    return Object.freeze(terminal);
  }
}
