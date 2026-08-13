import { sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  commitPreparedActionRequestV1Schema,
  createPreparedAction,
  prepareActionRequestV1Schema,
  type ApplicationEnvelopeV1,
  type ApplicationActionTargetV1,
  type AuthenticatedCallContextV1,
  type CommitPreparedActionRequestV1,
  type PrepareActionRequestV1,
  type PreparedActionV1,
} from "./application-protocol.js";
import type {
  ApplicationActionRegistry} from "./application-action-registry.js";
import {
  createLocalAuthorizationDecision,
  type ApplicationActionDefinitionV1,
  type ApplicationActionExecutionResultV1,
  type ResolvedApplicationTargetV1
} from "./application-action-registry.js";
import { ActionDisplayBuilder, type ActionDisplayArtifactV1 } from "./action-display-builder.js";
import type { ControlArtifactStore } from "./control-artifact-store.js";
import type {
  ControlOperationDriverClaimV1,
  ControlOperationJournal,
} from "./control-operation-journal.js";
import type { ControlOperationRecordV1 } from "./control-operation-schema.js";
import type { LocalOwnerPrincipalAuthority } from "./local-owner-principal.js";
import type { PreparedActionStore } from "./prepared-action-store.js";
import type { SessionDeliveryCoordinator } from "./delivery-cursor.js";
import type { ApplicationHostRuntimeV1 } from "./application-host-runtime.js";

export interface PreparedActionResponseV1 {
  readonly display: ActionDisplayArtifactV1;
  readonly prepared: PreparedActionV1;
}

export interface AgentRunApplicationService {
  prepare(
    context: AuthenticatedCallContextV1,
    request: PrepareActionRequestV1,
  ): Promise<ApplicationEnvelopeV1<PreparedActionResponseV1>>;
  commit(
    context: AuthenticatedCallContextV1,
    request: CommitPreparedActionRequestV1,
  ): Promise<ApplicationEnvelopeV1<unknown>>;
  decodeResult(actionKind: string, wireValue: unknown): unknown;
}

function rejectedEnvelope<T>(
  requestId: string,
  error: ApplicationControlError,
  operation: ControlOperationRecordV1 | null = null,
): ApplicationEnvelopeV1<T> {
  return Object.freeze({
    deliveryCursor: null,
    error: Object.freeze({ code: error.code, message: error.message }),
    ledgerHead: null,
    liveObservation: null,
    operationId: operation?.operationId ?? null,
    projectionIdentity: null,
    requestId,
    resourceScope: operation?.resolvedResourceScope ?? null,
    resourceVersion: operation?.resolvedResourceVersion ?? null,
    result: null,
    schemaVersion: 1,
    sessionId: operation?.resolvedResourceScope?.kind === "session"
      ? operation.resolvedResourceScope.sessionId
      : null,
    status: error.code === "control_resync_required" ? "resync_required" : "rejected",
    warnings: Object.freeze([]),
  });
}

function assertCompleteDomainPredicate(execution: ApplicationActionExecutionResultV1): void {
  const primary = execution.primaryDomainRecord;
  if (
    primary === null ||
    execution.domainRecordRefs.length === 0 ||
    !execution.domainRecordRefs.some((reference) =>
      reference.ownerKind === primary.ownerKind &&
      reference.ledgerId === primary.ledgerId &&
      reference.recordId === primary.recordId &&
      reference.recordSha256 === primary.recordSha256 &&
      reference.sequence === primary.sequence
    )
  ) {
    throw new ApplicationControlError(
      "control_operation_corrupt",
      "application action did not return one complete primary domain predicate",
    );
  }
}

function assertReconciledPredicateMatches(
  operation: ControlOperationRecordV1,
  execution: ApplicationActionExecutionResultV1,
): void {
  assertCompleteDomainPredicate(execution);
  if (
    sha256Canonical(operation.primaryDomainRecord) !== sha256Canonical(execution.primaryDomainRecord) ||
    sha256Canonical(operation.domainRecordRefs) !== sha256Canonical(execution.domainRecordRefs) ||
    sha256Canonical(operation.underlyingOperationRefs) !== sha256Canonical(execution.underlyingOperationRefs) ||
    sha256Canonical(operation.resolvedResourceScope) !== sha256Canonical(execution.resolvedResourceScope) ||
    sha256Canonical(operation.resolvedResourceVersion) !== sha256Canonical(execution.resolvedResourceVersion)
  ) {
    throw new ApplicationControlError(
      "control_operation_corrupt",
      "action reconciliation does not match the durable linked domain predicate",
    );
  }
}

export class DefaultAgentRunApplicationService implements AgentRunApplicationService {
  private readonly display: ActionDisplayBuilder;

  constructor(private readonly options: {
    readonly actions: ApplicationActionRegistry;
    readonly artifacts: ControlArtifactStore;
    readonly createRequestId: () => string;
    readonly delivery: SessionDeliveryCoordinator;
    readonly hostRuntime: ApplicationHostRuntimeV1;
    readonly journal: ControlOperationJournal;
    readonly principalAuthority: LocalOwnerPrincipalAuthority;
    readonly preparedActions: PreparedActionStore;
  }) {
    this.display = new ActionDisplayBuilder(options.artifacts);
  }

  async prepare(
    contextInput: AuthenticatedCallContextV1,
    requestInput: PrepareActionRequestV1,
  ): Promise<ApplicationEnvelopeV1<PreparedActionResponseV1>> {
    const requestId = typeof requestInput === "object" && requestInput !== null && "requestId" in requestInput
      ? String(requestInput.requestId)
      : this.options.createRequestId();
    try {
      const request = prepareActionRequestV1Schema.parse(requestInput) as PrepareActionRequestV1;
      const principal = this.options.principalAuthority.authenticate(contextInput);
      if (sha256Canonical(request.payload) !== request.payloadSha256) {
        throw new ApplicationControlError("control_payload_invalid", "payload hash does not match canonical payload bytes");
      }
      const definition = this.options.actions.validateTarget(request.actionKind, request.target);
      this.assertDeliveryMutationAllowed(contextInput, request.target);
      const payload = definition.payloadCodec.decodeStrict(request.payload);
      const requestIdentitySha256 = sha256Canonical({
        action_kind: request.actionKind,
        payload_sha256: request.payloadSha256,
        principal_id: principal.principalId,
        schema_version: 1,
        target: request.target,
      });
      const preparedActionId = this.options.preparedActions.preparedActionId(
        principal.principalId,
        request.prepareIdempotencyKey,
      );
      const existing = await this.options.preparedActions.read(preparedActionId);
      if (existing !== null) {
        if (existing.requestIdentitySha256 !== requestIdentitySha256) {
          throw new ApplicationControlError("control_idempotency_conflict", "prepare key is bound to another action");
        }
        if (Date.parse(existing.prepared.expiresAt) <= this.now().getTime()) {
          throw new ApplicationControlError("control_prepared_action_expired", "prepared action has expired; use a fresh prepare key");
        }
        return this.preparedEnvelope(request.requestId, existing.prepared);
      }
      const resolved = await definition.resolveTarget(request.target, payload);
      const authorization = this.authorize(contextInput, definition);
      const payloadRecord = await this.options.artifacts.storeJson({
        createdByOperationId: null,
        resourceScope: resolved.resourceScope,
        transportVisibility: "resource_authorized",
        value: payload,
      });
      const payloadArtifact = this.options.artifacts.reference({
        disclosure: "content_authorized",
        disclosureProfileSha256: authorization.decisionSha256,
        record: payloadRecord,
      });
      const displayDescription = definition.display(resolved, payload);
      const display = await this.display.build({
        actionKind: definition.actionKind,
        policyRevision: 1,
        policySha256: this.options.principalAuthority.localPolicySha256,
        preparedActionId,
        principalScope: principal.principalId,
        resourceScope: resolved.resourceScope,
        summary: displayDescription.summary,
        target: request.target,
        targetIdentity: resolved.targetIdentity,
        warnings: displayDescription.warnings,
      });
      const prepared = createPreparedAction({
        actionKind: definition.actionKind,
        confirmation: definition.confirmation,
        displayArtifact: display.artifact,
        displaySha256: display.display.displaySha256,
        expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
        grantSha256: principal.grantSha256,
        payloadArtifact,
        payloadSha256: request.payloadSha256,
        policyRevision: 1,
        policySha256: this.options.principalAuthority.localPolicySha256,
        preparedActionId,
        principalId: principal.principalId,
        singleUse: true,
        target: request.target,
        targetIdentitySha256: resolved.targetIdentitySha256,
      });
      const stored = await this.options.preparedActions.create({
        prepareIdempotencyKey: request.prepareIdempotencyKey,
        prepared,
        requestIdentitySha256,
      });
      return this.preparedEnvelope(request.requestId, stored.record.prepared);
    } catch (error) {
      const normalized = this.normalize(error);
      return rejectedEnvelope(requestId, normalized);
    }
  }

  async commit(
    contextInput: AuthenticatedCallContextV1,
    requestInput: CommitPreparedActionRequestV1,
  ): Promise<ApplicationEnvelopeV1<unknown>> {
    const requestId = typeof requestInput === "object" && requestInput !== null && "requestId" in requestInput
      ? String(requestInput.requestId)
      : this.options.createRequestId();
    let operation: ControlOperationRecordV1 | null = null;
    try {
      const request = commitPreparedActionRequestV1Schema.parse(requestInput);
      const principal = this.options.principalAuthority.authenticate(contextInput);
      const preparedRecord = await this.options.preparedActions.read(request.preparedActionId);
      if (preparedRecord === null) {
        throw new ApplicationControlError("control_prepared_action_not_found", "prepared action does not exist");
      }
      const prepared = preparedRecord.prepared;
      if (prepared.preparedActionSha256 !== request.preparedActionSha256) {
        throw new ApplicationControlError("control_prepared_action_mismatch", "prepared action hash does not match its durable record");
      }
      if (prepared.principalId !== principal.principalId) {
        throw new ApplicationControlError("control_authorization_denied", "prepared action belongs to another principal");
      }
      this.assertDeliveryMutationAllowed(contextInput, prepared.target);
      await this.readPreparedDisplay(prepared);
      const definition = this.options.actions.validateTarget(prepared.actionKind, prepared.target);
      const authorization = this.authorize(contextInput, definition);
      operation = await this.options.journal.findByPreparedAction(prepared.preparedActionId);
      let payload: unknown;
      let resolved: ResolvedApplicationTargetV1;
      if (operation === null || ["accepted", "authority_validated", "reserved"].includes(operation.state)) {
        if (prepared.grantSha256 !== principal.grantSha256) {
          throw new ApplicationControlError("control_stale_projection", "prepared grant is no longer current");
        }
        if (Date.parse(prepared.expiresAt) <= this.now().getTime()) {
          throw new ApplicationControlError("control_prepared_action_expired", "prepared action has expired");
        }
        if (
          prepared.policySha256 !== this.options.principalAuthority.localPolicySha256 ||
          prepared.policyRevision !== 1
        ) {
          throw new ApplicationControlError("control_stale_projection", "prepared policy is no longer current");
        }
        payload = await this.readPreparedPayload(prepared, definition);
        resolved = await definition.resolveTarget(prepared.target, payload);
        if (resolved.targetIdentitySha256 !== prepared.targetIdentitySha256) {
          throw new ApplicationControlError("control_stale_projection", "prepared target identity is stale");
        }
      } else {
        payload = await this.readPreparedPayload(prepared, definition);
        resolved = this.recoveryTarget(prepared);
      }
      if (operation === null) {
        const accepted = await this.options.journal.accept({
          actionKind: prepared.actionKind,
          idempotencyKey: request.idempotencyKey,
          idempotencyNamespace: `application.commit.${principal.principalId}`,
          preparedActionId: prepared.preparedActionId,
          preparedActionSha256: prepared.preparedActionSha256,
          requestIdentitySha256: sha256Canonical({
            action_kind: prepared.actionKind,
            idempotency_key: request.idempotencyKey,
            prepared_action_sha256: prepared.preparedActionSha256,
            principal_id: principal.principalId,
            schema_version: 1,
            target: prepared.target,
          }),
          target: prepared.target,
        });
        operation = accepted.operation;
      }
      if (operation.state === "completed") return await this.completedEnvelope(requestId, operation, definition);
      if (["blocked_stale", "blocked_unknown_effect", "failed_internal", "rejected_known_not_started"].includes(operation.state)) {
        throw this.terminalOperationError(operation);
      }
      const driver = await this.options.journal.acquireDriver(operation.operationId, {
        allowPostDispatchReconcile: definition.reconcile !== undefined,
      });
      operation = driver.operation;
      if (driver.kind === "busy") {
        throw new ApplicationControlError("control_operation_busy", "control operation has another durable driver");
      }
      if (driver.kind === "blocked_unknown_effect") {
        throw new ApplicationControlError("control_operation_busy", "control operation owner was lost after dispatch");
      }
      if (driver.kind === "terminal") {
        if (operation.state === "completed") return await this.completedEnvelope(requestId, operation, definition);
        throw this.terminalOperationError(operation);
      }
      return await this.drive({
        authorizationDecisionSha256: authorization.decisionSha256,
        claim: driver.claim,
        contextInput,
        definition,
        operation,
        payload,
        prepared,
        reconcileOnly: driver.reconcileOnly,
        requestId,
        resolved,
      });
    } catch (error) {
      const normalized = this.normalize(error);
      operation = await this.terminalizeKnownPreDispatchFailure(operation, normalized);
      return rejectedEnvelope(requestId, normalized, operation);
    }
  }

  private authorize(
    context: AuthenticatedCallContextV1,
    definition: ApplicationActionDefinitionV1,
  ) {
    const principal = this.options.principalAuthority.authenticate(context);
    const decision = createLocalAuthorizationDecision({
      effectiveScopes: this.options.principalAuthority.scopes,
      localPolicySha256: this.options.principalAuthority.localPolicySha256,
      principalKind: principal.kind,
      requiredPrincipalKind: definition.requiredPrincipalKind,
      requiredScopes: definition.requiredScopes,
    });
    if (!decision.allowed) {
      throw new ApplicationControlError("control_authorization_denied", "principal lacks the required action scope");
    }
    return decision;
  }

  private assertDeliveryMutationAllowed(
    context: AuthenticatedCallContextV1,
    target: ApplicationActionTargetV1,
  ): void {
    if (target.kind === "existing_resource" && target.resourceScope.kind === "session") {
      this.options.delivery.assertMutationAllowed(context, target.resourceScope.sessionId);
    }
  }

  private async drive(input: {
    readonly authorizationDecisionSha256: string;
    readonly claim: ControlOperationDriverClaimV1;
    readonly contextInput: AuthenticatedCallContextV1;
    readonly definition: ApplicationActionDefinitionV1;
    readonly operation: ControlOperationRecordV1;
    readonly payload: unknown;
    readonly prepared: PreparedActionV1;
    readonly reconcileOnly: boolean;
    readonly requestId: string;
    readonly resolved: ResolvedApplicationTargetV1;
  }): Promise<ApplicationEnvelopeV1<unknown>> {
    let operation = input.operation;
    if (operation.state === "completed") return this.completedEnvelope(input.requestId, operation, input.definition);
    if (["blocked_stale", "blocked_unknown_effect", "failed_internal", "rejected_known_not_started"].includes(operation.state)) {
      throw new ApplicationControlError(
        operation.state === "blocked_unknown_effect" ? "control_operation_busy" : "control_stale_projection",
        `control operation is terminal at ${operation.state}`,
      );
    }
    const stopHeartbeat = this.startDriverHeartbeat(input.claim);
    try {
      if (operation.state === "accepted") {
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: { state: "authority_validated" },
        });
      }
      if (
        operation.state === "authority_validated" &&
        input.definition.effectClass !== "control_only"
      ) {
        // PHASE21: runtime/external authority must cross a durable reservation
        // boundary before any domain owner can dispatch. The reservation is a
        // control-plane fact, not evidence that an effect started or stopped.
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: { state: "reserved" },
        });
      }
      if (operation.state === "authority_validated" || operation.state === "reserved") {
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: { state: "domain_append_started" },
        });
      }
      const executionContext = {
        applicationCommit: {
          actionKind: input.prepared.actionKind,
          authorizationDecisionSha256: input.authorizationDecisionSha256,
          operationId: operation.operationId,
          preparedActionSha256: input.prepared.preparedActionSha256,
          principalId: input.prepared.principalId,
          schemaVersion: 1,
        },
        authorizationDecisionSha256: input.authorizationDecisionSha256,
        call: input.contextInput,
        operationId: operation.operationId,
        requestId: input.requestId,
        resolvedTarget: input.resolved,
      } as const;
      let execution: ApplicationActionExecutionResultV1 | null = null;
      if (operation.state === "domain_append_started") {
        if (input.reconcileOnly) {
          execution = await input.definition.reconcile?.(
            executionContext,
            input.payload,
            input.prepared,
          ) ?? null;
        } else {
          try {
            execution = await input.definition.execute(
              executionContext,
              input.payload,
              input.prepared,
            );
          } catch (error) {
            // PHASE21: idempotency is not approval and a lost response is not
            // permission to dispatch again. The action-specific owner may
            // only scan exact facts and return a complete bounded predicate.
            execution = await input.definition.reconcile?.(
              executionContext,
              input.payload,
              input.prepared,
            ).catch(() => null) ?? null;
            if (execution === null) {
              operation = await this.options.journal.updateClaimed({
                claim: input.claim,
                patch: {
                  errorCode: "control_action_reconcile_incomplete",
                  state: "blocked_unknown_effect",
                },
              });
              throw new ApplicationControlError(
                "control_operation_busy",
                "action failed after dispatch and its exact durable result is incomplete",
                { cause: error },
              );
            }
          }
        }
        if (execution === null) {
          operation = await this.options.journal.updateClaimed({
            claim: input.claim,
            patch: {
              errorCode: "control_action_reconcile_incomplete",
              state: "blocked_unknown_effect",
            },
          });
          throw new ApplicationControlError(
            "control_operation_busy",
            "action-specific reconciliation could not prove a complete result",
          );
        }
        execution = this.decodeExecutionResult(input.definition, execution);
        assertCompleteDomainPredicate(execution);
      }
      if (operation.state === "domain_append_started") {
        if (execution === null) throw new Error("application action returned no domain result");
        // PHASE21: publish the complete cross-store predicate before building
        // the result artifact. A crash after this fsync is prefix 11: a later
        // driver may only observe/reconcile these exact refs and build the
        // result; it can never dispatch the domain/effect owner again.
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: {
            domainRecordRefs: execution.domainRecordRefs,
            primaryDomainRecord: execution.primaryDomainRecord,
            resolvedResourceScope: execution.resolvedResourceScope,
            resolvedResourceVersion: execution.resolvedResourceVersion,
            state: "domain_records_linked",
            underlyingOperationRefs: execution.underlyingOperationRefs,
          },
        });
      }
      if (operation.state === "domain_records_linked") {
        if (
          operation.primaryDomainRecord === null ||
          operation.domainRecordRefs.length === 0 ||
          operation.resolvedResourceScope === null ||
          operation.resolvedResourceVersion === null
        ) {
          throw new ApplicationControlError(
            "control_operation_corrupt",
            "linked control operation is missing its complete result predicate",
          );
        }
        if (execution === null) {
          execution = await input.definition.reconcile?.(
            executionContext,
            input.payload,
            input.prepared,
          ) ?? null;
          if (execution === null) {
            operation = await this.options.journal.updateClaimed({
              claim: input.claim,
              patch: {
                errorCode: "control_action_reconcile_incomplete",
                state: "blocked_unknown_effect",
              },
            });
            throw new ApplicationControlError(
              "control_operation_busy",
              "linked action result could not be reconstructed from its exact durable predicate",
            );
          }
        }
        execution = this.decodeExecutionResult(input.definition, execution);
        assertReconciledPredicateMatches(operation, execution);
        const resultRecord = await this.options.artifacts.storeJson({
          // One operation has exactly one bounded application result. Reusing
          // the operation UUID makes prefix 12 idempotent: a crash after the
          // artifact fsync cannot create an orphan/second result record.
          artifactId: operation.operationId,
          createdByOperationId: operation.operationId,
          resourceScope: operation.resolvedResourceScope,
          transportVisibility: "resource_authorized",
          value: execution.result,
        });
        const resultArtifact = this.options.artifacts.reference({
          disclosure: "content_authorized",
          disclosureProfileSha256: input.authorizationDecisionSha256,
          record: resultRecord,
        });
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: { resultArtifact, state: "result_built" },
        });
      }
      if (operation.state === "result_built") {
        if (operation.resultArtifact === null) {
          throw new ApplicationControlError(
            "control_operation_corrupt",
            "result-built control operation has no durable result artifact",
          );
        }
        operation = await this.options.journal.updateClaimed({
          claim: input.claim,
          patch: { state: "completed" },
        });
      }
      return this.completedEnvelope(input.requestId, operation, input.definition);
    } finally {
      await stopHeartbeat();
      await this.options.journal.releaseDriver(input.claim, {
        allowPostDispatchReconcile: input.definition.reconcile !== undefined,
      }).catch(() => undefined);
    }
  }

  private startDriverHeartbeat(claim: ControlOperationDriverClaimV1): () => Promise<void> {
    return this.options.hostRuntime.startRecurringTask(
      this.options.journal.driverHeartbeatIntervalMs,
      async () => {
        await this.options.journal.renewDriver(claim);
      },
    );
  }

  private terminalOperationError(operation: ControlOperationRecordV1): ApplicationControlError {
    return new ApplicationControlError(
      operation.state === "blocked_unknown_effect" ? "control_operation_busy" : "control_stale_projection",
      `control operation is terminal at ${operation.state}`,
    );
  }

  private async terminalizeKnownPreDispatchFailure(
    operation: ControlOperationRecordV1 | null,
    error: ApplicationControlError,
  ): Promise<ControlOperationRecordV1 | null> {
    if (
      operation === null ||
      operation.ownerClaim !== null ||
      !["accepted", "authority_validated", "reserved"].includes(operation.state)
    ) {
      return operation;
    }
    const state = [
      "control_catalog_conflict",
      "control_prepared_action_expired",
      "control_stale_projection",
    ].includes(error.code)
      ? "blocked_stale" as const
      : [
          "control_authentication_failed",
          "control_authorization_denied",
          "control_idempotency_conflict",
          "control_payload_invalid",
          "control_prepared_action_consumed",
          "control_prepared_action_mismatch",
          "control_prepared_action_not_found",
          "control_session_not_started",
          "control_target_invalid",
          "control_unknown_action",
        ].includes(error.code)
        ? "rejected_known_not_started" as const
        : [
            "control_artifact_forbidden",
            "control_artifact_invalid",
            "control_catalog_corrupt",
            "control_identity_corrupt",
            "control_operation_corrupt",
            "control_session_history_missing_or_corrupt",
          ].includes(error.code)
          ? "failed_internal" as const
          : null;
    if (state === null) return operation;
    try {
      return await this.options.journal.update({
        expectedRecordSha256: operation.recordSha256,
        operationId: operation.operationId,
        patch: { errorCode: error.code, state },
      });
    } catch {
      // PHASE21: a failed CAS means another driver or terminal revision won.
      // Observe that authority; never overwrite it from a stale catch path.
      return await this.options.journal.read(operation.operationId) ?? operation;
    }
  }

  private async completedEnvelope(
    requestId: string,
    operation: ControlOperationRecordV1,
    definition: ApplicationActionDefinitionV1,
  ): Promise<ApplicationEnvelopeV1<unknown>> {
    if (operation.state !== "completed" || operation.resultArtifact === null || operation.resolvedResourceScope === null) {
      throw new ApplicationControlError("control_operation_corrupt", "completed operation has no exact result");
    }
    const artifact = await this.options.artifacts.readVerified({
      artifactId: operation.resultArtifact.artifactId,
      expectedResourceScope: operation.resolvedResourceScope,
      maximumBytes: definition.resultCodec.maximumBytes,
    });
    let result: unknown;
    try {
      result = this.decodeActionResult(
        definition,
        parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes)),
      );
    } catch (error) {
      throw new ApplicationControlError("control_operation_corrupt", "operation result artifact is invalid", { cause: error });
    }
    const sessionId = operation.resolvedResourceScope.kind === "session"
      ? operation.resolvedResourceScope.sessionId
      : null;
    const ledgerHead = operation.resolvedResourceVersion?.kind === "session_ledger_head"
      ? operation.resolvedResourceVersion.head
      : null;
    return Object.freeze({
      deliveryCursor: null,
      error: null,
      ledgerHead,
      liveObservation: null,
      operationId: operation.operationId,
      projectionIdentity: operation.resultProjectionIdentity,
      requestId,
      resourceScope: operation.resolvedResourceScope,
      resourceVersion: operation.resolvedResourceVersion,
      result,
      schemaVersion: 1,
      sessionId,
      status: "ok",
      warnings: Object.freeze([]),
    });
  }

  /** Re-validates an already returned result at a surface adapter boundary. */
  decodeResult(actionKind: string, wireValue: unknown): unknown {
    return this.decodeActionResult(this.options.actions.get(actionKind), wireValue);
  }

  private decodeExecutionResult(
    definition: ApplicationActionDefinitionV1,
    execution: ApplicationActionExecutionResultV1,
  ): ApplicationActionExecutionResultV1 {
    return Object.freeze({
      ...execution,
      result: this.decodeActionResult(definition, execution.result),
    });
  }

  private decodeActionResult(
    definition: ApplicationActionDefinitionV1,
    wireValue: unknown,
  ): unknown {
    try {
      return definition.resultCodec.decodeStrict(wireValue);
    } catch (error) {
      throw new ApplicationControlError(
        "control_operation_corrupt",
        `application action ${definition.actionKind} failed its strict result contract`,
        { cause: error },
      );
    }
  }

  private async preparedEnvelope(
    requestId: string,
    prepared: PreparedActionV1,
  ): Promise<ApplicationEnvelopeV1<PreparedActionResponseV1>> {
    const display = await this.readPreparedDisplay(prepared);
    return Object.freeze({
      deliveryCursor: null,
      error: null,
      ledgerHead: null,
      liveObservation: null,
      operationId: null,
      projectionIdentity: null,
      requestId,
      resourceScope: prepared.displayArtifact.resourceScope,
      resourceVersion: prepared.target.kind === "existing_resource"
        ? prepared.target.expectedVersion
        : prepared.target.expectedCatalogVersion,
      result: Object.freeze({ display, prepared }),
      schemaVersion: 1,
      sessionId: prepared.displayArtifact.resourceScope.kind === "session"
        ? prepared.displayArtifact.resourceScope.sessionId
        : null,
      status: "ok",
      warnings: Object.freeze([]),
    });
  }

  private async readPreparedDisplay(prepared: PreparedActionV1): Promise<ActionDisplayArtifactV1> {
    try {
      return await this.display.readAndVerify(prepared);
    } catch (error) {
      if (error instanceof ApplicationControlError) throw error;
      throw new ApplicationControlError("control_operation_corrupt", "prepared display artifact is invalid", { cause: error });
    }
  }

  private async readPreparedPayload(
    prepared: PreparedActionV1,
    definition: ApplicationActionDefinitionV1,
  ): Promise<unknown> {
    const artifact = await this.options.artifacts.readVerified({
      artifactId: prepared.payloadArtifact.artifactId,
      expectedResourceScope: prepared.payloadArtifact.resourceScope,
      maximumBytes: definition.payloadCodec.maximumBytes,
    });
    let value: unknown;
    try {
      value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes));
    } catch (error) {
      throw new ApplicationControlError("control_artifact_invalid", "prepared payload artifact is invalid", { cause: error });
    }
    if (sha256Canonical(value) !== prepared.payloadSha256) {
      throw new ApplicationControlError("control_artifact_invalid", "prepared payload hash mismatch");
    }
    return definition.payloadCodec.decodeStrict(value);
  }

  private recoveryTarget(prepared: PreparedActionV1): ResolvedApplicationTargetV1 {
    const resourceScope = prepared.target.kind === "existing_resource"
      ? prepared.target.resourceScope
      : prepared.target.catalogScope;
    const resourceVersion = prepared.target.kind === "existing_resource"
      ? prepared.target.expectedVersion
      : prepared.target.expectedCatalogVersion;
    return Object.freeze({
      resourceScope,
      resourceVersion,
      targetIdentity: Object.freeze({ recovered_from_prepared_action: prepared.preparedActionId }),
      targetIdentitySha256: prepared.targetIdentitySha256,
    });
  }

  private now(): Date {
    return this.options.hostRuntime.now();
  }

  private normalize(error: unknown): ApplicationControlError {
    if (error instanceof ApplicationControlError) return error;
    return new ApplicationControlError("control_payload_invalid", "application request failed strict validation", { cause: error });
  }
}
