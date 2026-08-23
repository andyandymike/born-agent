import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { classifyDelegationReconcileOutcome } from "../../src/delegation/delegation-reconciler.js";
import { createDelegationChildOperation } from "../../src/delegation/delegation-operation-schema.js";
import { DelegationOperationStore } from "../../src/delegation/delegation-operation-store.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { RestrictedToolRegistry } from "../../src/tools/restricted-tool-registry.js";
import { IDS, SHA, phase20Budget, phase20Content, phase20Revision } from "../phase20-test-helpers.js";
import { delegationRevisionContentSchema } from "../../src/delegation/delegation-schema.js";
import {
  delegationApprovalIdentity,
  canonicalDelegationIdentity,
  delegationAuthorityRequestPreviewIdentity,
} from "../../src/delegation/delegation-identity.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { readDelegationOwnerSession } from "../../src/delegation/delegation-owner-execution-service.js";
import {
  childSessionShardWorkspace,
  DelegationSessionWriterQueue,
  importChildSessionShard,
  seedChildSessionShard,
} from "../../src/delegation/runtime/child-session-shard.js";
import { openDelegationWriter } from "../../src/delegation/runtime/child-launcher.js";
import { SessionLockError } from "../../src/sessions/session-lock.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function operation(
  state: "requested" | "running" | "reconciled" = "requested",
  preEffectFailure = false,
) {
  return createDelegationChildOperation({
    schemaVersion: 1,
    revision: 1,
    operationId: "a0000000-0000-4000-8000-000000000020",
    sessionId: IDS.session,
    delegationId: IDS.delegation,
    childActorId: IDS.actor,
    childAttemptId: IDS.attempt,
    childRunId: IDS.run,
    parentRunId: IDS.parent,
    envelopePath: "C:/trusted/envelope.json",
    envelopeArtifactSha256: SHA,
    envelopeSha256: SHA,
    capsulePath: "C:/trusted/capsule.json",
    capsuleArtifactSha256: SHA,
    capsuleSha256: SHA,
    sessionWorkspacePath: "C:/repo",
    executionWorkspacePath: "C:/repo",
    executableDescriptorSha256: SHA,
    nonceSha256: SHA,
    startBarrierNonceSha256: SHA,
    requestedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    state,
    process: state === "requested" || preEffectFailure ? null : { pid: 42, processStartIdentity: SHA },
    processCleanup: null,
    failure: preEffectFailure ? { code: "delegation_handshake_failed", phase: "before_spawn" } : null,
    boundedResultRef: null,
    boundedResultSha256: null,
  });
}

async function seedCompletedSession(root: string, adapterVersion: string): Promise<void> {
  const writer = await V2SessionWriter.createNew(root, IDS.session, {
    createEventId: randomUUID,
    timestamp: () => "2026-08-10T00:00:00.000Z",
  });
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: IDS.parent,
    sessionId: IDS.session,
    timestamp: () => "2026-08-10T00:00:00.000Z",
    writer,
  });
  try {
    await publisher.publish({
      data: { command: "chat", input: { role: "user", text: "seed" }, model: "qwen3:1.7b", provider: "ollama", timeout_ms: 1_000, workspace: root },
      type: "run.started",
    });
    await publisher.publish({
      data: {
        adapter: "deterministic-fake",
        adapter_version: adapterVersion,
        capabilities: { cancellation: "abort_signal", reasoning: "none", streaming: true, tools: "none", usage: "complete" },
        config_fingerprint: SHA,
        model: "qwen3:1.7b",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await publisher.publish({ data: { duration_ms: 1, output_chars: 0 }, type: "run.completed" });
  } finally {
    await writer.close();
  }
}

describe("Phase 20C runtime authority and recovery", () => {
  it("does not execute a forged tool call outside the child envelope", async () => {
    let reads = 0;
    let mutations = 0;
    const base = new ToolRegistry([
      { capability: "read", description: "read", inputSchema: z.object({ path: z.string() }).strict(), name: "read_file", execute: async () => { reads += 1; return { ok: true, truncated: false, value: {} }; } },
      { capability: "mutation", description: "mutate", inputSchema: z.object({ patch: z.string() }).strict(), name: "apply_patch", execute: async () => { mutations += 1; return { ok: true, truncated: false, value: {} }; } },
    ]);
    const restricted = new RestrictedToolRegistry(base, ["read_file"]);
    expect(restricted.modelDefinitions.map((tool) => tool.name)).toEqual(["read_file"]);
    expect((await restricted.execute({ argumentsJson: "{}", callId: "a", name: "apply_patch", step: 1 }, new AbortController().signal)).ok).toBe(false);
    expect(mutations).toBe(0);
    expect((await restricted.execute({ argumentsJson: '{"path":"src/index.ts"}', callId: "b", name: "read_file", step: 1 }, new AbortController().signal)).ok).toBe(true);
    expect(reads).toBe(1);
    const noTools = new RestrictedToolRegistry(base, []);
    expect(noTools.modelDefinitions).toEqual([]);
    expect((await noTools.execute({ argumentsJson: "{}", callId: "c", name: "read_file", step: 1 }, new AbortController().signal)).ok).toBe(false);
    expect(reads).toBe(1);
  });

  it("allows retry only for a proven pre-effect prefix and blocks unknown running effects", () => {
    expect(classifyDelegationReconcileOutcome({ operation: operation(), ownerObservation: "not_started" })).toMatchObject({ kind: "blocked_unknown_effect" });
    const revision = {
      ...phase20Revision({ envelope: true, retry: true, status: "queued" }),
      attempts: [{
        actorId: IDS.actor,
        attemptId: IDS.attempt,
        attemptNumber: 1,
        budgetSettlementEventId: "a0000000-0000-4000-8000-000000000030",
        budgetUsage: {
          artifactBytes: 0,
          attempts: 1,
          changedBytes: 0,
          changedFiles: 0,
          commandExecutions: 0,
          commandOutputBytes: 0,
          durationMs: 0,
          modelSteps: 0,
          reportedTokens: 0,
        },
        childRunId: IDS.run,
        executableEnvelopeSha256: SHA,
        operationId: "a0000000-0000-4000-8000-000000000020",
        reservationId: "a0000000-0000-4000-8000-000000000021",
        startedEventId: null,
        terminal: "pre_effect_infrastructure_failure" as const,
        terminalEventId: "a0000000-0000-4000-8000-000000000029",
        unresolvedEffectIds: [],
      }],
    };
    expect(classifyDelegationReconcileOutcome({
      operation: operation("reconciled", true),
      ownerObservation: "not_started",
      revision,
    })).toEqual({ kind: "retry_pre_effect_allowed" });
    expect(classifyDelegationReconcileOutcome({ operation: operation("running"), ownerObservation: "unknown" })).toMatchObject({ kind: "blocked_unknown_effect" });
  });

  it("persists immutable CAS operation revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-operation-"));
    temporary.push(root);
    const first = operation();
    const store = await DelegationOperationStore.create({ root, operationId: first.operationId });
    await store.initialize(first);
    const second = await store.compareAndSwap({
      expectedSha256: first.operationSha256,
      expectedState: "requested",
      now: "2026-08-10T00:00:01.000Z",
      mutate: (current) => ({ ...current, state: "spawned", process: { pid: 42, processStartIdentity: SHA } }),
    });
    expect(second.revision).toBe(2);
    expect((await DelegationOperationStore.listExisting(root))).toHaveLength(1);
    await expect(store.compareAndSwap({
      expectedSha256: first.operationSha256,
      expectedState: "requested",
      now: "2026-08-10T00:00:02.000Z",
      mutate: (current) => current,
    })).rejects.toMatchObject({ code: "delegation_lease_busy" });
  });

  it("serializes concurrent parent session writers used by parallel children", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-writer-queue-"));
    temporary.push(root);
    const initial = await V2SessionWriter.createNew(root, IDS.session, {
      createEventId: randomUUID,
      timestamp: () => "2026-08-10T00:00:00.000Z",
    });
    const seed = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId: IDS.parent,
      sessionId: IDS.session,
      timestamp: () => "2026-08-10T00:00:00.000Z",
      writer: initial,
    });
    await seed.publish({
      data: { command: "chat", input: { role: "user", text: "seed" }, model: "qwen3:1.7b", provider: "ollama", timeout_ms: 1_000, workspace: root },
      type: "run.started",
    });
    await seed.publish({
      data: {
        adapter: "deterministic-fake",
        adapter_version: "phase20-writer-queue-v1",
        capabilities: { cancellation: "abort_signal", reasoning: "none", streaming: true, tools: "none", usage: "complete" },
        config_fingerprint: SHA,
        model: "qwen3:1.7b",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await seed.publish({ data: { duration_ms: 1, output_chars: 0 }, type: "run.completed" });
    await initial.close();
    const queue = new DelegationSessionWriterQueue();
    const factory = queue.wrap((context) => V2SessionWriter.openExisting(
      context.workspace,
      context.sessionId,
      { createEventId: context.randomUuid, timestamp: context.now },
    ));
    const context = {
      inputSurface: "cli" as const,
      now: () => "2026-08-10T00:00:01.000Z",
      randomUuid: randomUUID,
      sessionId: IDS.session,
      workspace: root,
    };
    const first = await factory(context);
    let secondAcquired = false;
    const secondPending = factory(context).then((writer) => {
      secondAcquired = true;
      return writer;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    await first.close();
    const second = await secondPending;
    expect(secondAcquired).toBe(true);
    await second.close();
  });

  it("waits for a short session-writer handoff before reading an exact owner snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-owner-read-"));
    temporary.push(root);
    await seedCompletedSession(root, "phase20-owner-read-v1");

    const overlappingWriter = await V2SessionWriter.openExisting(root, IDS.session, {
      createEventId: randomUUID,
      timestamp: () => "2026-08-10T00:00:01.000Z",
    });
    const queue = new DelegationSessionWriterQueue();
    let opens = 0;
    let observed = 0;
    const factory = queue.wrap(async (context) => {
      opens += 1;
      return V2SessionWriter.openExisting(
        context.workspace,
        context.sessionId,
        { createEventId: context.randomUuid, timestamp: context.now },
      );
    });
    let waits = 0;
    const snapshot = await readDelegationOwnerSession({
      cwd: root,
      delegationWriterFactory: factory,
      env: {},
      observeSessionWriter: () => { observed += 1; },
      onCancel: () => () => undefined,
      platform: process.platform,
      randomUUID,
      timestamp: () => "2026-08-10T00:00:02.000Z",
      waitForRetry: async () => {
        waits += 1;
        await overlappingWriter.close();
      },
    }, IDS.session);

    expect(waits).toBe(1);
    expect(opens).toBe(2);
    expect(observed).toBe(1);
    expect(snapshot.sessionId).toBe(IDS.session);
    expect(snapshot.events).toHaveLength(3);
  });

  it("keeps child terminal writer acquisition bounded beyond the former five-second window", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-terminal-writer-"));
    temporary.push(root);
    await seedCompletedSession(root, "phase20-terminal-writer-v1");

    let attempts = 0;
    let elapsedMs = 0;
    const writer = await openDelegationWriter(
      async (context) => {
        attempts += 1;
        if (attempts <= 3) throw new SessionLockError("active_session_lock", "fixture lock handoff");
        return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
          createEventId: context.randomUuid,
          timestamp: context.now,
        });
      },
      {
        inputSurface: "cli",
        now: () => "2026-08-10T00:00:01.000Z",
        randomUuid: randomUUID,
        sessionId: IDS.session,
        workspace: root,
      },
      {
        now: () => elapsedMs,
        wait: async () => { elapsedMs += 3_000; },
      },
    );
    try {
      expect(attempts).toBe(4);
      expect(elapsedMs).toBe(9_000);
      expect(writer.events).toHaveLength(3);
    } finally {
      await writer.close();
    }
  });

  it("keeps prepared/executable envelope identities distinct and imports one minimal child shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-shard-"));
    temporary.push(root);
    const content = phase20Content();
    const eventContent = delegationRevisionContentSchema.parse(content);
    const identity = canonicalDelegationIdentity(content);
    const preparedEnvelopeSha256 = "b".repeat(64);
    const executableEnvelopeSha256 = "c".repeat(64);
    const capsuleSha256 = "d".repeat(64);
    const operationId = "a0000000-0000-4000-8000-000000000020";
    const operationNonceSha256 = "e".repeat(64);
    const descriptorSha256 = "f".repeat(64);
    const parent = await V2SessionWriter.createNew(root, IDS.session, {
      createEventId: randomUUID,
      timestamp: () => "2026-08-10T00:00:00.000Z",
    });
    const parentPublisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId: IDS.parent,
      sessionId: IDS.session,
      timestamp: () => "2026-08-10T00:00:00.000Z",
      writer: parent,
    });
    await parentPublisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: "parent run" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 1_000,
        workspace: root,
      },
      type: "run.started",
    });
    await parentPublisher.publish({
      data: {
        adapter: "deterministic-fake",
        adapter_version: "phase20-parent-v1",
        capabilities: { cancellation: "abort_signal", reasoning: "none", streaming: true, tools: "none", usage: "complete" },
        config_fingerprint: SHA,
        model: "qwen3:1.7b",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await parentPublisher.publish({ data: { delta: "parent complete" }, type: "text.delta" });
    await parentPublisher.publish({ data: { duration_ms: 1, output_chars: 15 }, type: "run.completed" });
    const proposed = await parent.appendDelegationEvent("delegation.revision.proposed", {
      artifact: {
        artifact_id: `sha256:${identity.delegationSha256}`,
        bytes: identity.byteLength,
        object_ref: `objects/${identity.delegationSha256}`,
        sha256: identity.delegationSha256,
      },
      authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
      binding: content.binding,
      content: eventContent,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      origin: { input_surface: "tool", kind: "model" },
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
    });
    const decisionRequestId = randomUUID();
    const displaySha256 = "1".repeat(64);
    await parent.appendDelegationEvent("delegation.decision.recorded", {
      approval_identity_sha256: delegationApprovalIdentity({
        approvalRequestId: decisionRequestId,
        binding: content.binding,
        delegationId: content.delegationId,
        delegationRevision: 1,
        delegationSha256: identity.delegationSha256,
        displaySha256,
      }),
      authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
      decision: "approved",
      decision_request_id: decisionRequestId,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      display_artifact: {
        artifact_id: `sha256:${displaySha256}`,
        bytes: 1,
        object_ref: `objects/${displaySha256}`,
        sha256: displaySha256,
      },
      origin: { input_surface: "cli", kind: "user" },
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      revision_event_id: proposed.eventId,
    });
    await parent.appendDelegationEvent("delegation.queued", {
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      origin: { input_surface: "cli", kind: "user" },
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      queue_request_id: randomUUID(),
    });
    const ref = (digest: string) => ({
      artifact_id: `sha256:${digest}`,
      bytes: 1,
      object_ref: `objects/${digest}`,
      sha256: digest,
    });
    await parent.appendDelegationEvent("delegation.envelope.prepared", {
      context_capsule_artifact: ref(capsuleSha256),
      context_capsule_sha256: capsuleSha256,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      envelope_artifact: ref(preparedEnvelopeSha256),
      envelope_sha256: preparedEnvelopeSha256,
      executable: false,
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
    });
    const budget = phase20Budget();
    const counters = {
      artifact_bytes: budget.maxArtifactBytes,
      attempts: budget.maxAttempts,
      changed_bytes: budget.maxChangedBytes,
      changed_files: budget.maxChangedFiles,
      command_executions: budget.maxCommandExecutions,
      command_output_bytes: budget.maxCommandOutputBytes,
      duration_ms: budget.maxDurationMs,
      model_steps: budget.maxModelSteps,
      reported_tokens: budget.maxReportedTokens,
    };
    const reservationId = randomUUID();
    await parent.appendDelegationEvent("delegation.budget.reserved", {
      child_attempt_id: IDS.attempt,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      reservation_id: reservationId,
      reservation_sha256: "2".repeat(64),
      reserved: counters,
    });
    await parent.appendDelegationEvent("delegation.child.launch_requested", {
      child_actor_id: IDS.actor,
      child_attempt_id: IDS.attempt,
      child_attempt_number: 1,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      envelope_artifact: ref(executableEnvelopeSha256),
      envelope_sha256: executableEnvelopeSha256,
      executable_descriptor_sha256: descriptorSha256,
      operation_id: operationId,
      operation_nonce_sha256: operationNonceSha256,
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      prepared_envelope_sha256: preparedEnvelopeSha256,
    });
    await parent.appendDelegationEvent("delegation.child.started", {
      child_actor_id: IDS.actor,
      child_attempt_id: IDS.attempt,
      child_attempt_number: 1,
      child_run_id: IDS.run,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      envelope_sha256: executableEnvelopeSha256,
      operation_id: operationId,
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      process_id: 42,
      process_start_identity: "pid:42:start:test",
    });
    const parentEvents = parent.events;
    await parent.close();
    const operationContent = { ...operation() };
    Reflect.deleteProperty(operationContent, "operationSha256");
    const childOperation = createDelegationChildOperation({
      ...operationContent,
      operationId,
      delegationId: content.delegationId,
      envelopePath: join(root, "operation", "envelope.json"),
      envelopeArtifactSha256: executableEnvelopeSha256,
      envelopeSha256: executableEnvelopeSha256,
      capsulePath: join(root, "operation", "capsule.json"),
      capsuleArtifactSha256: capsuleSha256,
      capsuleSha256,
      sessionWorkspacePath: root,
      executionWorkspacePath: root,
      executableDescriptorSha256: descriptorSha256,
      nonceSha256: operationNonceSha256,
    });
    await seedChildSessionShard({
      operation: childOperation,
      parentEvents,
      randomUuid: randomUUID,
      timestamp: () => "2026-08-10T00:00:01.000Z",
    });
    const childWriter = await V2SessionWriter.openExisting(
      childSessionShardWorkspace(childOperation),
      IDS.session,
      { createEventId: randomUUID, timestamp: () => "2026-08-10T00:00:02.000Z" },
    );
    const publisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId: IDS.run,
      sessionId: IDS.session,
      timestamp: () => "2026-08-10T00:00:02.000Z",
      writer: childWriter,
    });
    await publisher.publishDelegatedChildRunStarted({
      command: "chat",
      input: { role: "user", text: "bounded child" },
      model: "qwen3:1.7b",
      provider: "ollama",
      timeout_ms: 1_000,
      workspace: root,
    }, {
      actor_id: IDS.actor,
      delegation_id: content.delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      child_attempt_id: IDS.attempt,
      child_attempt_number: 1,
      parent_actor_id: IDS.parent,
      parent_run_id: IDS.parent,
      envelope_sha256: executableEnvelopeSha256,
      operation_nonce_sha256: operationNonceSha256,
    });
    await publisher.publish({
      data: {
        adapter: "deterministic-fake",
        adapter_version: "phase20-v1",
        capabilities: { cancellation: "abort_signal", reasoning: "none", streaming: true, tools: "none", usage: "complete" },
        config_fingerprint: SHA,
        model: "qwen3:1.7b",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await publisher.publish({ data: { delta: "ok" }, type: "text.delta" });
    await publisher.publish({ data: { duration_ms: 1, output_chars: 2 }, type: "run.completed" });
    await childWriter.close();
    await importChildSessionShard({
      context: {
        inputSurface: "cli",
        now: () => "2026-08-10T00:00:03.000Z",
        randomUuid: randomUUID,
        sessionId: IDS.session,
        workspace: root,
      },
      operation: childOperation,
      writerFactory: (context) => V2SessionWriter.openExisting(context.workspace, context.sessionId, {
        createEventId: context.randomUuid,
        timestamp: context.now,
      }),
    });
    const merged = await new SessionCatalog(root).read(IDS.session);
    expect(merged.runs.map((run) => run.runId)).toEqual([IDS.parent, IDS.run]);
    expect(merged.delegations.revisions[0]?.attempts[0]).toMatchObject({
      executableEnvelopeSha256,
      childRunId: IDS.run,
    });
  });
});
