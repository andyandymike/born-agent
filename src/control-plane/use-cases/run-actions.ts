import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type {
  ApplicationActionDefinitionV1,
  ApplicationActionExecutionResultV1,
} from "../application-action-registry.js";
import { ApplicationControlError } from "../application-errors.js";
import { createStrictCodec, type SessionLedgerHeadV1 } from "../application-protocol.js";
import type { SessionOwnerBroker } from "../session-owner-broker.js";
import type { SessionProjectionService } from "../session-projection-service.js";
import type { SessionRegistry } from "../session-registry.js";
import { runCancelResultCodec } from "./action-result-codecs.js";

const payloadSchema = z.object({
  reason: z.literal("user"),
  runId: z.string().uuid(),
}).strict();

type RunCancelPayloadV1 = Readonly<z.infer<typeof payloadSchema>>;

function targetOwnerGeneration(targetIdentity: unknown): string {
  if (
    typeof targetIdentity !== "object" ||
    targetIdentity === null ||
    !("owner_generation_sha256" in targetIdentity) ||
    typeof targetIdentity.owner_generation_sha256 !== "string"
  ) {
    throw new ApplicationControlError("control_target_invalid", "run cancel target owner generation is unavailable");
  }
  return targetIdentity.owner_generation_sha256;
}

export function createRunCancelAction(input: {
  readonly broker: SessionOwnerBroker;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: SessionRegistry;
}): ApplicationActionDefinitionV1<RunCancelPayloadV1> {
  const definition: ApplicationActionDefinitionV1<RunCancelPayloadV1> = {
    actionKind: "run.cancel",
    confirmation: "none",
    display: (resolved, payload) => Object.freeze({
      summary: `Request cancellation for run ${payload.runId}.`,
      warnings: Object.freeze([
        `The request targets owner generation ${String((resolved.targetIdentity as Readonly<Record<string, unknown>>).owner_generation_sha256 ?? "unknown")}.`,
      ]),
    }),
    effectClass: "runtime_effect",
    execute: async (context, payload) => {
      try {
        if (
          context.resolvedTarget.resourceScope.kind !== "session" ||
          context.resolvedTarget.resourceVersion.kind !== "session_ledger_head"
        ) {
          throw new ApplicationControlError("control_target_invalid", "run cancel requires a session ledger target");
        }
        const scope = context.resolvedTarget.resourceScope;
        const ownerGenerationSha256 = targetOwnerGeneration(context.resolvedTarget.targetIdentity);
        const durable = await input.sessions.requestRunCancel({
          applicationCommit: context.applicationCommit,
          expectedHead: context.resolvedTarget.resourceVersion.head,
          ownerGenerationSha256,
          reason: payload.reason,
          repositoryId: scope.repositoryId,
          runId: payload.runId,
          sessionId: scope.sessionId,
        });

        const active = input.broker.activePort(scope.sessionId)?.runControl;
        if (
          active === undefined ||
          active.runId !== payload.runId ||
          active.ownerGenerationSha256 !== ownerGenerationSha256
        ) {
          // The catalog request is durable, but absence from this process is
          // not proof that a cross-process owner is dead. Do not complete the
          // application operation as though cancellation succeeded. The
          // action-specific reconciler may complete only after the exact owner
          // publishes its session binding and canonical terminal; otherwise
          // ApplicationService records a durable blocked_unknown_effect.
          throw new ApplicationControlError(
            "control_operation_busy",
            "run cancel request is durable but exact owner signalling is unproven",
          );
        }

        const signalled = await active.requestCancel({
          applicationCommit: context.applicationCommit,
          reason: payload.reason,
        });
        return Object.freeze({
          domainRecordRefs: Object.freeze([durable.requestReference, signalled.recordReference]),
          primaryDomainRecord: durable.requestReference,
          resolvedResourceScope: scope,
          resolvedResourceVersion: { head: signalled.head.publicHead, kind: "session_ledger_head" as const },
          result: Object.freeze({
            ownerGenerationSha256,
            requestEventId: signalled.recordReference.recordId,
            runId: payload.runId,
            signalStatus: "exact_owner_signalled",
            terminalBinding: signalled.terminalBinding,
          }),
          underlyingOperationRefs: Object.freeze([]),
        });
      } catch (error) {
        if (error instanceof ApplicationControlError) throw error;
        throw new ApplicationControlError(
          "control_operation_corrupt",
          error instanceof Error ? error.message : "run cancel execution failed",
          { cause: error },
        );
      }
    },
    reconcile: async (context, payload, prepared) => {
      // PHASE21: post-dispatch recovery scans the exact request, session
      // binding, and terminal. It owns no authority to signal the run again.
      const scope = context.resolvedTarget.resourceScope;
      if (
        scope.kind !== "session" ||
        context.resolvedTarget.resourceVersion.kind !== "session_ledger_head" ||
        prepared.target.kind !== "existing_resource" ||
        prepared.target.resourceScope.kind !== "session" ||
        prepared.target.expectedVersion.kind !== "session_ledger_head" ||
        prepared.target.resourceScope.repositoryId !== scope.repositoryId ||
        prepared.target.resourceScope.sessionId !== scope.sessionId
      ) {
        throw new ApplicationControlError("control_target_invalid", "run cancel reconciliation target is invalid");
      }
      const barrier = await input.sessions.readRunCancelBarrier(scope.repositoryId, scope.sessionId, payload.runId);
      const request = barrier.request;
      if (request === null) return null;
      const ownerGenerationSha256 = request.fact.ownerGenerationSha256;
      const exactTargetIdentity = Object.freeze({
        owner_generation_sha256: ownerGenerationSha256,
        run_id: payload.runId,
        session_id: scope.sessionId,
      });
      if (
        sha256Canonical(exactTargetIdentity) !== prepared.targetIdentitySha256 ||
        barrier.owner?.fact.ownerGenerationSha256 !== ownerGenerationSha256 ||
        request.fact.repositoryId !== scope.repositoryId ||
        request.fact.sessionId !== scope.sessionId ||
        request.fact.runId !== payload.runId ||
        request.fact.reason !== payload.reason ||
        sha256Canonical(request.fact.expectedHead) !== sha256Canonical(prepared.target.expectedVersion.head) ||
        sha256Canonical(request.fact.applicationCommit) !== sha256Canonical(context.applicationCommit)
      ) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "run cancel request is not bound to this exact application operation",
        );
      }

      if (barrier.binding === null && barrier.terminal === null) {
        const active = input.broker.activePort(scope.sessionId)?.runControl;
        if (
          active !== undefined &&
          active.runId === payload.runId &&
          active.ownerGenerationSha256 === ownerGenerationSha256
        ) {
          // A matching owner can still be between observing the durable
          // request and publishing its session binding. Observation-only
          // recovery must not signal it or invent the completed branch.
          return null;
        }
        // Broker absence is observation only, never owner-death proof. Keep
        // the request barrier and the application operation blocked unknown.
        return null;
      }
      if (barrier.binding === null || barrier.terminal === null) return null;
      const binding = barrier.binding;
      const terminal = barrier.terminal;
      if (
        binding.fact.cancelOperationId !== context.operationId ||
        terminal.fact.cancelOperationId !== context.operationId ||
        binding.fact.ownerGenerationSha256 !== ownerGenerationSha256 ||
        terminal.fact.ownerGenerationSha256 !== ownerGenerationSha256 ||
        binding.fact.sessionRequestReference.ledgerId !== `session:${scope.sessionId}` ||
        terminal.fact.terminalReference.ledgerId !== `session:${scope.sessionId}` ||
        sha256Canonical(binding.fact.terminalBinding) !== sha256Canonical(terminal.fact.terminalBinding)
      ) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "run cancel binding and terminal do not belong to this exact request",
        );
      }
      const snapshot = await input.sessionProjection.read({
        repositoryId: scope.repositoryId,
        requestedHead: null,
        sessionId: scope.sessionId,
      });
      const requestCheckpoint = snapshot.deliveryEvents.find((event) =>
        event.eventId === binding.fact.sessionRequestReference.recordId &&
        event.sequence === binding.fact.sessionRequestReference.sequence &&
        event.rawEventSha256 === binding.fact.sessionRequestReference.recordSha256
      );
      const terminalCheckpoint = snapshot.deliveryEvents.find((event) =>
        event.eventId === terminal.fact.terminalReference.recordId &&
        event.sequence === terminal.fact.terminalReference.sequence &&
        event.rawEventSha256 === terminal.fact.terminalReference.recordSha256
      );
      const requestMetadata = snapshot.eventMetadata.find((event) =>
        event.eventId === binding.fact.sessionRequestReference.recordId &&
        event.sequence === binding.fact.sessionRequestReference.sequence
      );
      const terminalMetadata = snapshot.eventMetadata.find((event) =>
        event.eventId === terminal.fact.terminalReference.recordId &&
        event.sequence === terminal.fact.terminalReference.sequence
      );
      if (
        requestCheckpoint === undefined ||
        terminalCheckpoint === undefined ||
        requestMetadata?.type !== "run.cancel.requested" ||
        requestMetadata.runId !== payload.runId ||
        terminalMetadata?.runId !== payload.runId ||
        !["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete"].includes(
          terminalMetadata.type,
        ) ||
        terminalCheckpoint.sequence <= requestCheckpoint.sequence
      ) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "run cancel terminal references are not present in the exact session history",
        );
      }
      const requestHead = Object.freeze({
        eventId: requestCheckpoint.eventId,
        eventIntegrityToken: requestCheckpoint.eventIntegrityToken,
        schemaVersion: 1 as const,
        sequence: requestCheckpoint.sequence,
        sessionId: requestCheckpoint.sessionId,
      });
      return Object.freeze({
        domainRecordRefs: Object.freeze([request.reference, binding.fact.sessionRequestReference]),
        primaryDomainRecord: request.reference,
        resolvedResourceScope: scope,
        resolvedResourceVersion: { head: requestHead, kind: "session_ledger_head" as const },
        result: Object.freeze({
          ownerGenerationSha256,
          requestEventId: binding.fact.sessionRequestReference.recordId,
          runId: payload.runId,
          signalStatus: "exact_owner_signalled",
          terminalBinding: binding.fact.terminalBinding,
        }),
        underlyingOperationRefs: Object.freeze([]),
      } satisfies ApplicationActionExecutionResultV1);
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 4 * 1024,
      schema: payloadSchema,
      schemaId: "phase21a.run-cancel.payload.v1",
    }),
    resultCodec: runCancelResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: async (target, payload) => {
      if (
        target.kind !== "existing_resource" ||
        target.resourceScope.kind !== "session" ||
        target.expectedVersion.kind !== "session_ledger_head"
      ) {
        throw new ApplicationControlError("control_target_invalid", "run cancel target is invalid");
      }
      const scope = target.resourceScope;
      const expected: SessionLedgerHeadV1 = target.expectedVersion.head;
      let barrier = await input.sessions.readRunCancelBarrier(scope.repositoryId, scope.sessionId, payload.runId);
      if (barrier.owner === null || barrier.terminal !== null) {
        throw new ApplicationControlError("control_stale_projection", "cancel target run has no open durable owner fence");
      }
      const durableOwner = barrier.owner.fact;
      const active = input.broker.activePort(scope.sessionId)?.runControl;
      if (
        active !== undefined &&
        active.runId === payload.runId &&
        active.ownerGenerationSha256 === durableOwner.ownerGenerationSha256 &&
        active.acceptsObservedHead(expected)
      ) {
        barrier = await input.sessions.observeRunOwner({
          observationKind: "progress",
          observedHead: expected,
          ownerGenerationSha256: active.ownerGenerationSha256,
          repositoryId: scope.repositoryId,
          runId: payload.runId,
          sessionId: scope.sessionId,
        });
      }
      const observed = [
        durableOwner.initialObservedHead,
        ...barrier.observations.map((observation) => observation.observedHead),
      ].some((head) => sha256Canonical(head) === sha256Canonical(expected));
      if (!observed || !barrier.observations.some((observation) => observation.observationKind === "started")) {
        throw new ApplicationControlError("control_stale_projection", "cancel target head was not durably observed by the started owner");
      }
      const targetIdentity = Object.freeze({
        owner_generation_sha256: durableOwner.ownerGenerationSha256,
        run_id: payload.runId,
        session_id: scope.sessionId,
      });
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: target.expectedVersion,
        targetIdentity,
        targetIdentitySha256: sha256Canonical(targetIdentity),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["session_ledger_head"],
      resourceKinds: ["session"],
      targetKind: "existing_resource",
    }],
    zeroHeadPolicy: "deny",
  };
  return Object.freeze(definition);
}
