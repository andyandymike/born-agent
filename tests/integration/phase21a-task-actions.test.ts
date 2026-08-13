import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { queueBackgroundWorkerCancel } from "../../src/background/background-worker-control.js";
import type { AuthenticatedCallContextV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import { ApplicationControlError } from "../../src/control-plane/application-errors.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { CliGraphCancelOwnerPort } from "../../src/control-plane/adapters/graph-cancel-cli-port.js";
import { ForegroundGraphControlRegistry } from "../../src/control-plane/foreground-graph-control-registry.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { phase20Content } from "../phase20-test-helpers.js";
import { createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A authenticated task actions", () => {
  it("routes Goal and Plan mutations through one prepared application operation", async () => {
    const stateRoot = await directory("bornagent-phase21a-task-state-");
    const repositoryRoot = await directory("bornagent-phase21a-task-repo-");
    const workerRoot = await directory("bornagent-phase21a-task-worker-");
    let backgroundQueueCalls = 0;
    let loseFirstBackgroundResponse = true;
    let rejectNextBeforeDurableControl = false;
    const graphCancelRuntime = createRuntime({
      cwd: repositoryRoot,
      observeBackgroundWorkerCancel: async (input) => {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.backgroundOperationId,
          repositoryId: input.repositoryId,
          root: workerRoot,
        });
        const control = await store.readCancelEvidence(input.requestId);
        return control === null ? null : { control, controlSha256: sha256Canonical(control) };
      },
      queueBackgroundWorkerCancel: async (input) => {
        backgroundQueueCalls += 1;
        if (rejectNextBeforeDurableControl) {
          rejectNextBeforeDurableControl = false;
          throw new Error("injected partial background control before durable create");
        }
        const queued = await queueBackgroundWorkerCancel({
          ...(input.authenticatedMutation === undefined ? {} : { authenticatedMutation: input.authenticatedMutation }),
          current: input.current ?? null,
          graphRevision: input.graphRevision,
          graphSha256: input.graphSha256,
          now: () => "2026-08-12T00:00:00.000Z",
          randomUuid: randomUUID,
          reason: input.reason,
          ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
          ...(input.sessionCancel === undefined ? {} : { sessionCancel: input.sessionCancel }),
          sessionId: input.sessionId,
          userStateRoot: workerRoot,
        });
        if (loseFirstBackgroundResponse) {
          loseFirstBackgroundResponse = false;
          throw new Error("injected response loss after durable background control");
        }
        return {
          control: queued.control,
          controlSha256: queued.controlSha256,
          operationId: queued.control.operationId,
          requestId: queued.control.requestId,
          workerId: queued.control.workerId,
        };
      },
    });
    const plane = await createPhase21ALocalControlPlane({
      graphCancelOwnerFactory: (signer) => new CliGraphCancelOwnerPort({
        foregroundGraphControls: new ForegroundGraphControlRegistry(),
        runtime: graphCancelRuntime,
        signer,
      }),
      launcher: {
        launch: async (input) => {
          try {
          const publisher = new EventPublisher({
            randomUUID,
            renderer: { render: () => undefined },
            runId: input.runId,
            sessionId: input.sessionId,
            timestamp: () => new Date().toISOString(),
            writer: input.writer,
          });
          const started = await publisher.publish({
            data: {
              application_commit: {
                action_kind: input.applicationCommit.actionKind,
                authorization_decision_sha256: input.applicationCommit.authorizationDecisionSha256,
                operation_id: input.applicationCommit.operationId,
                prepared_action_sha256: input.applicationCommit.preparedActionSha256,
                principal_id: input.applicationCommit.principalId,
                schema_version: 1,
              },
              command: "agent",
              input: { role: "user", text: input.payload.task },
              max_duration_ms: 1_000,
              max_steps: 1,
              max_tokens: 100,
              max_tool_output_bytes: 1_024,
              model: "phase21a-fake",
              provider: "ollama",
              request_timeout_ms: 1_000,
              tools: [],
              tools_enabled: true,
              workspace: input.repositoryRoot,
            },
            type: "run.started",
          });
          if (started.type !== "run.started") throw new TypeError("expected run start");
          await input.onRunStarted(started);
          await publisher.publish({
            data: {
              adapter: "phase21a-fake",
              adapter_version: "1",
              capabilities: {
                cancellation: "abort_signal",
                reasoning: "none",
                streaming: true,
                tools: "strict",
                usage: "complete",
              },
              config_fingerprint: "c".repeat(64),
              model: "phase21a-fake",
              provider: "ollama",
            },
            type: "backend.selected",
          });
          await publisher.publish({
            data: {
              input_kind: "user_task",
              max_steps: 1,
              remaining_duration_ms: 1_000,
              remaining_tokens: 100,
              remaining_tool_output_bytes: 1_024,
              step: 1,
            },
            type: "agent.step.started",
          });
          await publisher.publish({
            data: { delta: "done" },
            type: "text.delta",
          });
          await publisher.publish({
            data: {
              cache_read_tokens: null,
              cache_write_tokens: null,
              completeness: "complete",
              input_tokens: 1,
              output_tokens: 1,
              provider: "ollama",
              step: 1,
              total_tokens: 2,
            },
            type: "model.usage",
          });
          await publisher.publish({
            data: { duration_ms: 1, outcome: "final", step: 1, text_chars: 4 },
            type: "agent.step.completed",
          });
          await publisher.publish({
            data: {
              input_tokens: 1,
              model_turns: 1,
              output_tokens: 1,
              total_tokens: 2,
              usage_incomplete: false,
            },
            type: "usage",
          });
          await publisher.publish({
            data: {
              completion_mode: "model_final",
              duration_ms: 1,
              model_turns: 1,
              output_chars: 4,
              steps: 1,
              tool_calls: 0,
            },
            type: "run.completed",
          });
          return Object.freeze({ exitCode: 1 });
          } catch (error) {
            throw new ApplicationControlError(
              "control_operation_corrupt",
              error instanceof Error ? error.message : "fixture launch failed",
              { cause: error },
            );
          }
        },
      },
      stateRoot,
    });
    const context = plane.context("cli", "phase21a-task-actions");
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const session = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    const scope = {
      kind: "session" as const,
      repositoryId: repository.registration.repositoryId,
      sessionId: session.entry.sessionId,
      teamId: null,
    };

    const preparedByKey = new Map<string, { readonly preparedActionId: string; readonly preparedActionSha256: string }>();
    const commit = async (
      actionKind: string,
      payload: unknown,
      head: SessionLedgerHeadV1,
      key: string,
      call: AuthenticatedCallContextV1 = context,
    ) => {
      const prepared = await plane.actions.prepare(call, {
        actionKind,
        payload,
        payloadSha256: sha256Canonical(payload),
        prepareIdempotencyKey: `${key}-prepare`,
        requestId: randomUUID(),
        schemaVersion: 1,
        target: { expectedVersion: { head, kind: "session_ledger_head" }, kind: "existing_resource", resourceScope: scope },
      });
      expect(prepared.status).toBe("ok");
      preparedByKey.set(key, prepared.result!.prepared);
      return plane.actions.commit(call, {
        idempotencyKey: `${key}-commit`,
        preparedActionId: prepared.result!.prepared.preparedActionId,
        preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
        requestId: randomUUID(),
        schemaVersion: 1,
      });
    };

    const message = await commit(
      "session.message.submit",
      { command: "agent", task: "establish a legacy task session", verbose: false },
      session.entry.initialLedgerHead,
      "message",
    );
    expect(message.status, JSON.stringify(message)).toBe("ok");
    const goal = await commit(
      "goal.propose",
      { objective: "Ship the authenticated local control plane", operation: "create_initial" },
      message.ledgerHead!,
      "goal",
    );
    expect(goal.status).toBe("ok");
    expect(goal.result).toMatchObject({ content: { objective: "Ship the authenticated local control plane", revision: 1 } });

    const plan = await commit(
      "plan.propose",
      {
        base: null,
        editablePlan: {
          items: [{ acceptance: "Focused tests pass", id: "verify", required: true, title: "Verify the control plane" }],
          schema_version: 1,
          title: "Phase 21A",
        },
        goalId: (goal.result as { content: { goalId: string } }).content.goalId,
        goalRevision: 1,
      },
      goal.ledgerHead!,
      "plan",
    );
    expect(plan.status).toBe("ok");
    expect(plan.result).toMatchObject({ status: "draft", content: { revision: 1, title: "Phase 21A" } });
    const draft = plan.result as { content: { goalId: string; goalRevision: number; planId: string; revision: number }; planSha256: string };
    const approved = await commit(
      "plan.decide",
      {
        decision: "approve",
        goalId: draft.content.goalId,
        goalRevision: draft.content.goalRevision,
        planId: draft.content.planId,
        revision: draft.content.revision,
        sha256: draft.planSha256,
      },
      plan.ledgerHead!,
      "approve",
    );
    expect(approved.status).toBe("ok");
    expect(approved.result).toMatchObject({ status: "active" });

    const graphBudget = {
      maxArtifactBytes: 1_024,
      maxAttempts: 1,
      maxChangedBytes: 0,
      maxChangedFiles: 0,
      maxCommandExecutions: 0,
      maxCommandOutputBytes: 0,
      maxDurationMs: 60_000,
      maxModelSteps: 2,
      maxReportedTokens: 2_048,
    };
    const graph = await commit(
      "graph.propose",
      {
        base: null,
        graph: {
          binding: {
            goalId: draft.content.goalId,
            goalRevision: draft.content.goalRevision,
            planId: draft.content.planId,
            planRevision: draft.content.revision,
            planSha256: draft.planSha256,
            sessionId: session.entry.sessionId,
          },
          graphBudget,
          graphId: randomUUID(),
          nodes: [{
            agent: { mode: "plan", taskProfile: "read-only" },
            budget: graphBudget,
            dependsOn: [],
            kind: "agent",
            nodeId: "verify",
            objective: "Verify the authenticated local control plane.",
            planItemIds: ["verify"],
            requiredCapabilities: [],
            retry: { automaticOn: ["pre_effect_infrastructure_failure"], maxAttempts: 1 },
            sequence: 1,
            title: "Verify Phase 21A",
            workspace: { declaredPathPrefixes: ["."], mode: "origin_read_only" },
          }],
          schemaVersion: 1,
          title: "Phase 21A verification Graph",
        },
      },
      approved.ledgerHead!,
      "graph",
    );
    expect(graph.status).toBe("ok");
    expect(graph.result).toMatchObject({ status: "draft", revision: 1 });
    const graphResult = graph.result as { graphSha256: string; revision: number };
    const graphApproved = await commit(
      "graph.decide",
      { decision: "approve", revision: graphResult.revision, sha256: graphResult.graphSha256 },
      graph.ledgerHead!,
      "graph-approve",
    );
    expect(graphApproved.status, JSON.stringify(graphApproved)).toBe("ok");
    expect(graphApproved.result).toMatchObject({ status: "approved" });
    const graphQueued = await commit(
      "graph.enqueue",
      {
        requestedExecution: "background",
        revision: graphResult.revision,
        runtimeProfileId: "local-free-v1",
        sha256: graphResult.graphSha256,
      },
      graphApproved.ledgerHead!,
      "graph-run",
    );
    expect(graphQueued.status, JSON.stringify(graphQueued)).toBe("ok");
    expect(graphQueued.result).toMatchObject({ status: "queued" });

    const workerRepositoryId = "d".repeat(64);
    const backgroundOperationId = randomUUID();
    const workerId = randomUUID();
    const workerNonceSha256 = "e".repeat(64);
    const descriptor = {
      cliEntryPathSha256: "1".repeat(64),
      cliEntrySha256: "2".repeat(64),
      nodeExecutablePathSha256: "3".repeat(64),
      nodeExecutableSha256: "4".repeat(64),
      nodeVersion: "22.23.1",
      packageName: "bornagent" as const,
      packageRootInventorySha256: "5".repeat(64),
      packageVersion: "0.0.0",
      schemaVersion: 1 as const,
      workerProtocolVersion: 1 as const,
    };
    const workerStore = await BackgroundOperationStore.create({
      operationId: backgroundOperationId,
      repositoryId: workerRepositoryId,
      root: workerRoot,
    });
    await workerStore.createHandoff({
      graphSha256: graphResult.graphSha256,
      operationId: backgroundOperationId,
      owner: "worker",
      ownerPid: 1234,
      ownerProcessStartIdentity: "phase21a-worker",
      parentNonceSha256: "6".repeat(64),
      schemaVersion: 1,
      state: "worker_owned",
      updatedAt: "2026-08-12T00:00:00.000Z",
      workerId,
      workerNonceSha256,
    });
    const backgroundWriter = await V2SessionWriter.openExisting(repositoryRoot, session.entry.sessionId, {
      createEventId: randomUUID,
      timestamp: () => "2026-08-12T00:00:00.000Z",
    });
    await backgroundWriter.appendTaskGraphEvent("task_worker.spawn.requested", {
      descriptor,
      descriptor_sha256: sha256Canonical(descriptor),
      graph_id: (graphApproved.result as { graphId: string }).graphId,
      graph_revision: graphResult.revision,
      graph_sha256: graphResult.graphSha256,
      operation_id: backgroundOperationId,
      repository_id: workerRepositoryId,
      worker_id: workerId,
      worker_nonce_sha256: workerNonceSha256,
    });
    await backgroundWriter.appendTaskGraphEvent("task_worker.started", {
      descriptor_sha256: sha256Canonical(descriptor),
      graph_id: (graphApproved.result as { graphId: string }).graphId,
      graph_revision: graphResult.revision,
      graph_sha256: graphResult.graphSha256,
      handoff_sha256: "7".repeat(64),
      operation_id: backgroundOperationId,
      scheduler_lease_sha256: "8".repeat(64),
      worker_id: workerId,
      worker_nonce_sha256: workerNonceSha256,
    });
    await backgroundWriter.close();
    const backgroundStarted = await plane.sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });

    const parentRunId = (message.result as { runId: string }).runId;
    const delegation = await commit(
      "delegation.propose",
      { base: null, parentRunId, revision: phase20Content() },
      backgroundStarted.head.publicHead,
      "delegation",
    );
    expect(delegation.status, JSON.stringify(delegation)).toBe("ok");
    expect(delegation.result).toMatchObject({ status: "draft", delegationRevision: 1 });
    const delegationResult = delegation.result as { delegationId: string; delegationRevision: number; delegationSha256: string };
    const delegationApproved = await commit(
      "delegation.decide",
      {
        decision: "approve",
        delegationId: delegationResult.delegationId,
        revision: delegationResult.delegationRevision,
        sha256: delegationResult.delegationSha256,
      },
      delegation.ledgerHead!,
      "delegation-approve",
    );
    expect(delegationApproved.status, JSON.stringify(delegationApproved)).toBe("ok");
    const delegationQueued = await commit(
      "delegation.enqueue",
      { delegationId: delegationResult.delegationId },
      delegationApproved.ledgerHead!,
      "delegation-enqueue",
    );
    expect(delegationQueued.status, JSON.stringify(delegationQueued)).toBe("ok");
    expect(delegationQueued.result).toMatchObject({ status: "queued" });
    const delegationCancelled = await commit(
      "delegation.cancel",
      { delegationId: delegationResult.delegationId, reason: "bounded cancellation test" },
      delegationQueued.ledgerHead!,
      "delegation-cancel",
    );
    expect(delegationCancelled.status, JSON.stringify(delegationCancelled)).toBe("ok");
    expect(delegationCancelled.result).toMatchObject({ status: "cancelling" });
    const graphCancelled = await commit(
      "graph.cancel",
      {
        reason: "bounded Graph cancellation test",
        revision: graphResult.revision,
        sha256: graphResult.graphSha256,
      },
      delegationCancelled.ledgerHead!,
      "graph-cancel",
    );
    expect(graphCancelled.status, JSON.stringify(graphCancelled)).toBe("ok");
    expect(graphCancelled.result).toMatchObject({
      delivery: "background_control_queued",
      operationId: backgroundOperationId,
      requestId: graphCancelled.operationId,
      terminal: false,
      workerId,
    });
    expect(backgroundQueueCalls).toBe(1);
    expect(await workerStore.readCancelEvidence(graphCancelled.operationId!)).toMatchObject({
      operationId: backgroundOperationId,
      origin: { application_commit: { operation_id: graphCancelled.operationId } },
      repositoryId: workerRepositoryId,
      schemaVersion: 2,
      sessionId: session.entry.sessionId,
    });
    const graphCancelPrepared = preparedByKey.get("graph-cancel")!;
    expect(await plane.operations.findByPreparedAction(graphCancelPrepared.preparedActionId)).toMatchObject({
      domainRecordRefs: [{ ownerKind: "session", recordId: expect.any(String), sequence: expect.any(Number) }],
      primaryDomainRecord: { ownerKind: "session", recordId: expect.any(String) },
      state: "completed",
      underlyingOperationRefs: [{
        ledgerId: `background:${backgroundOperationId}`,
        ownerKind: "effect",
        recordId: `cancel:${graphCancelled.operationId}`,
        sequence: null,
      }],
    });
    const sameSemanticRetry = await plane.actions.commit(context, {
      idempotencyKey: "graph-cancel-same-semantic-K2",
      preparedActionId: graphCancelPrepared.preparedActionId,
      preparedActionSha256: graphCancelPrepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(sameSemanticRetry.status).toBe("ok");
    expect(sameSemanticRetry.operationId).toBe(graphCancelled.operationId);
    expect(sameSemanticRetry.result).toEqual(graphCancelled.result);
    expect(backgroundQueueCalls).toBe(1);

    const events = await readStoredSession(join(repositoryRoot, ".bornagent", "sessions", `${session.entry.sessionId}.jsonl`));
    const applicationTaskEvents = events.filter((event) =>
      typeof event.data === "object" && event.data !== null && "origin" in event.data &&
      (event.data as { origin?: { kind?: string } }).origin?.kind === "authenticated_surface"
    );
    expect(applicationTaskEvents.map((event) => event.type)).toEqual([
      "goal.created",
      "plan.proposed",
      "plan.approved",
      "task_graph.proposed",
      "task_graph.approved",
      "task_graph.enqueued",
      "delegation.revision.proposed",
      "delegation.decision.recorded",
      "delegation.queued",
      "delegation.cancel.requested",
      "task_graph.cancel.requested",
    ]);
    expect(new Set(applicationTaskEvents.map((event) =>
      (event.data as { origin: { application_commit: { operation_id: string } } }).origin.application_commit.operation_id
    )).size).toBe(11);

    rejectNextBeforeDurableControl = true;
    const beforePartial = await plane.sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });
    const partialCancel = await commit(
      "graph.cancel",
      {
        reason: "partial control must fail closed",
        revision: graphResult.revision,
        sha256: graphResult.graphSha256,
      },
      beforePartial.head.publicHead,
      "graph-cancel-partial",
    );
    expect(partialCancel.status).toBe("rejected");
    expect(backgroundQueueCalls).toBe(2);
    expect(partialCancel.operationId).not.toBeNull();
    expect(await workerStore.readCancelEvidence(partialCancel.operationId!)).toBeNull();

    const afterPartial = await plane.sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });

    const abandonPayload = {
      decision: "abandon" as const,
      goalId: draft.content.goalId,
      reason: "exercise linked-result recovery",
      revision: draft.content.goalRevision,
    };
    const abandonPrepared = await plane.actions.prepare(context, {
      actionKind: "goal.decide",
      payload: abandonPayload,
      payloadSha256: sha256Canonical(abandonPayload),
      prepareIdempotencyKey: "linked-goal-abandon-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: afterPartial.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: scope,
      },
    });
    expect(abandonPrepared.status).toBe("ok");
    const storeJson = plane.artifacts.storeJson.bind(plane.artifacts);
    let failLinkedResult = true;
    const storeSpy = vi.spyOn(plane.artifacts, "storeJson").mockImplementation(async (input) => {
      if (failLinkedResult && input.artifactId !== undefined && input.createdByOperationId !== null) {
        failLinkedResult = false;
        throw new Error("injected linked Goal result-store loss");
      }
      return storeJson(input);
    });
    const abandonRequest = {
      idempotencyKey: "linked-goal-abandon-K1",
      preparedActionId: abandonPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: abandonPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1 as const,
    };
    const lostAbandonResult = await plane.actions.commit(context, abandonRequest);
    expect(lostAbandonResult.status).toBe("rejected");
    const linkedAbandon = await plane.operations.findByPreparedAction(abandonRequest.preparedActionId);
    expect(linkedAbandon).toMatchObject({ resultArtifact: null, state: "domain_records_linked" });

    const afterAbandon = await plane.sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });
    const laterGoal = await commit(
      "goal.propose",
      {
        objective: "A later unrelated application operation",
        operation: "start_new",
        parentGoalId: draft.content.goalId,
        replaceActive: null,
      },
      afterAbandon.head.publicHead,
      "later-unrelated-goal",
    );
    expect(laterGoal.status, JSON.stringify(laterGoal)).toBe("ok");

    const recoveredAbandon = await plane.actions.commit(context, {
      ...abandonRequest,
      idempotencyKey: "linked-goal-abandon-K2",
      requestId: randomUUID(),
    });
    expect(recoveredAbandon.status, JSON.stringify(recoveredAbandon)).toBe("ok");
    expect(recoveredAbandon.result).toMatchObject({ status: "abandoned" });
    expect(recoveredAbandon.resourceVersion).toEqual(linkedAbandon?.resolvedResourceVersion);
    expect(recoveredAbandon.ledgerHead?.sequence).toBeLessThan(laterGoal.ledgerHead!.sequence);
    storeSpy.mockRestore();

    const laterGoalProjection = laterGoal.result as { content: { goalId: string; revision: number } };
    const mismatchedPayload = {
      decision: "abandon" as const,
      goalId: laterGoalProjection.content.goalId,
      reason: "reject an inexact application commit binding",
      revision: laterGoalProjection.content.revision,
    };
    const mismatchedPrepared = await plane.actions.prepare(context, {
      actionKind: "goal.decide",
      payload: mismatchedPayload,
      payloadSha256: sha256Canonical(mismatchedPayload),
      prepareIdempotencyKey: "mismatched-binding-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: laterGoal.ledgerHead!, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: scope,
      },
    });
    expect(mismatchedPrepared.status).toBe("ok");
    const preparedIdentity = mismatchedPrepared.result!.prepared;
    const mismatchedCommitKey = "mismatched-binding-commit";
    const accepted = await plane.operations.accept({
      actionKind: preparedIdentity.actionKind,
      idempotencyKey: mismatchedCommitKey,
      idempotencyNamespace: `application.commit.${context.principal.principalId}`,
      preparedActionId: preparedIdentity.preparedActionId,
      preparedActionSha256: preparedIdentity.preparedActionSha256,
      requestIdentitySha256: sha256Canonical({
        action_kind: preparedIdentity.actionKind,
        idempotency_key: mismatchedCommitKey,
        prepared_action_sha256: preparedIdentity.preparedActionSha256,
        principal_id: context.principal.principalId,
        schema_version: 1,
        target: preparedIdentity.target,
      }),
      target: preparedIdentity.target,
    });
    const driver = await plane.operations.acquireDriver(accepted.operation.operationId, {
      allowPostDispatchReconcile: true,
    });
    if (driver.kind !== "acquired") throw new TypeError("fixture operation driver was not acquired");
    await plane.operations.updateClaimed({ claim: driver.claim, patch: { state: "authority_validated" } });
    await plane.operations.updateClaimed({ claim: driver.claim, patch: { state: "domain_append_started" } });
    await plane.operations.releaseDriver(driver.claim, { allowPostDispatchReconcile: true });

    const forgedWriter = await V2SessionWriter.openExisting(repositoryRoot, session.entry.sessionId, {
      createEventId: randomUUID,
      timestamp: () => "2026-08-12T00:00:03.000Z",
    });
    await forgedWriter.appendTaskEvent("goal.status.changed", {
      from: "active",
      goal_id: laterGoalProjection.content.goalId,
      origin: {
        action_identity_sha256: "a".repeat(64),
        application_commit: {
          action_kind: preparedIdentity.actionKind,
          authorization_decision_sha256: "b".repeat(64),
          operation_id: accepted.operation.operationId,
          prepared_action_sha256: "c".repeat(64),
          principal_id: context.principal.principalId,
          schema_version: 1,
        },
        authentication_id: context.principal.authenticationId,
        client_id: context.surface.clientId,
        kind: "authenticated_surface",
        request_id: randomUUID(),
        surface: "cli",
      },
      reason: mismatchedPayload.reason,
      revision: laterGoalProjection.content.revision,
      to: "abandoned",
    });
    await forgedWriter.close();

    const mismatchedRecovery = await plane.actions.commit(context, {
      idempotencyKey: mismatchedCommitKey,
      preparedActionId: preparedIdentity.preparedActionId,
      preparedActionSha256: preparedIdentity.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(mismatchedRecovery).toMatchObject({
      error: { code: "control_operation_busy" },
      operationId: accepted.operation.operationId,
      status: "rejected",
    });
    expect(await plane.operations.read(accepted.operation.operationId)).toMatchObject({
      resultArtifact: null,
      state: "domain_append_started",
    });
  }, 45_000);
});
