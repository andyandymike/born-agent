import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError, type ApplicationControlErrorCode } from "./application-errors.js";
import {
  applicationQueryRequestV1Schema,
  expectedResourceVersionV1Schema,
  resourceScopeV1Schema,
  type ApplicationEnvelopeV1,
  type ApplicationQueryRequestV1,
  type AuthenticatedCallContextV1,
  type SessionLiveObservationV1,
} from "./application-protocol.js";
import type {
  ApplicationQueryPageV1,
  ApplicationQueryRegistry,
} from "./application-query-registry.js";
import { createLocalAuthorizationDecision } from "./application-action-registry.js";
import type { LocalOwnerPrincipalAuthority } from "./local-owner-principal.js";
import type { PaginationCursorStore } from "./pagination-cursor-store.js";
import type { SessionDeliveryCoordinator } from "./delivery-cursor.js";
import { redactSensitiveText } from "../security/redact.js";
import type { ApplicationHostRuntimeV1 } from "./application-host-runtime.js";

const SHA256 = /^[a-f0-9]{64}$/u;

function sameCanonical(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function redactQueryValue(value: unknown, depth = 0): unknown {
  if (depth > 64) {
    throw new ApplicationControlError("control_payload_invalid", "query result exceeds its structural bound");
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => redactQueryValue(entry, depth + 1)));
  if (typeof value === "object" && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactQueryValue(entry, depth + 1),
    ])));
  }
  return value;
}

function publicQueryErrorMessage(code: ApplicationControlErrorCode): string {
  return `application query rejected (${code})`;
}

export class DefaultApplicationQueryService {
  constructor(private readonly options: {
    readonly createRequestId: () => string;
    readonly cursors: PaginationCursorStore;
    readonly delivery: SessionDeliveryCoordinator;
    readonly hostRuntime: Pick<ApplicationHostRuntimeV1, "now">;
    readonly principalAuthority: LocalOwnerPrincipalAuthority;
    readonly queries: ApplicationQueryRegistry;
  }) {}

  async query(
    contextInput: AuthenticatedCallContextV1,
    requestInput: ApplicationQueryRequestV1,
  ): Promise<ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>> {
    const requestId = typeof requestInput === "object" && requestInput !== null && "requestId" in requestInput
      ? String(requestInput.requestId)
      : this.options.createRequestId();
    try {
      const request = applicationQueryRequestV1Schema.parse(requestInput) as ApplicationQueryRequestV1;
      const principal = this.options.principalAuthority.authenticate(contextInput);
      const definition = this.options.queries.resolve(request);
      if (request.deliveryCursor !== undefined && request.deliveryCursor !== null && request.queryKind !== "session.events_page") {
        throw new ApplicationControlError("control_target_invalid", "delivery continuation is only valid for session events");
      }
      const payload = definition.payloadCodec.decodeStrict(request.payload);
      const authorization = createLocalAuthorizationDecision({
        effectiveScopes: this.options.principalAuthority.scopes,
        localPolicySha256: this.options.principalAuthority.localPolicySha256,
        principalKind: principal.kind,
        requiredPrincipalKind: "human",
        requiredScopes: definition.requiredScopes,
      });
      if (!authorization.allowed) {
        throw new ApplicationControlError("control_authorization_denied", "principal lacks the required query scope");
      }
      const disclosureProfileSha256 = sha256Canonical({
        grant_sha256: principal.grantSha256,
        local_policy_sha256: this.options.principalAuthority.localPolicySha256,
        redaction_profile_id: definition.redactionProfileId,
        schema_version: 1,
      });
      const payloadSha256 = sha256Canonical(payload);
      let paginationBinding = null;
      if (request.pageCursor !== null) {
        if (request.atVersion === null) {
          throw new ApplicationControlError("control_resync_required", "paginated continuation requires its exact version");
        }
        paginationBinding = await this.options.cursors.validate({
          call: contextInput,
          cursor: request.pageCursor,
          disclosureProfileSha256,
          exactVersion: request.atVersion,
          now: this.now(),
          payloadSha256,
          queryKind: request.queryKind,
          redactionProfileId: definition.redactionProfileId,
          resourceScope: request.resourceScope,
        });
      }
      const snapshot = await definition.readStableSnapshot(request.resourceScope, request.atVersion, {
        paginationBinding,
        payload,
      });
      const returnedScope = resourceScopeV1Schema.safeParse(snapshot.resourceScope);
      const returnedVersion = expectedResourceVersionV1Schema.safeParse(snapshot.resourceVersion);
      const returnedContract = returnedScope.success
        ? definition.resourceContracts.find((candidate) => candidate.resourceKind === returnedScope.data.kind)
        : undefined;
      if (
        !returnedScope.success ||
        !returnedVersion.success ||
        !sameCanonical(returnedScope.data, request.resourceScope) ||
        returnedContract === undefined ||
        !returnedContract.acceptedAtVersionKinds.includes(returnedVersion.data.kind) ||
        (request.atVersion !== null && !sameCanonical(returnedVersion.data, request.atVersion)) ||
        typeof snapshot.snapshotIdentitySha256 !== "string" ||
        !SHA256.test(snapshot.snapshotIdentitySha256)
      ) {
        throw new ApplicationControlError(
          "control_operation_corrupt",
          "query projection owner returned a snapshot outside its authorized contract",
        );
      }
      if (
        paginationBinding !== null &&
        paginationBinding.snapshotIdentitySha256 !== snapshot.snapshotIdentitySha256
      ) {
        throw new ApplicationControlError("control_resync_required", "paginated snapshot is no longer available exactly");
      }
      const execution = await definition.execute({
        authorizationDecisionSha256: authorization.decisionSha256,
        authorizedResourceScope: snapshot.resourceScope,
        authorizedResourceVersion: snapshot.resourceVersion,
        call: contextInput,
        paginationBinding,
        stableSnapshot: snapshot,
      }, payload);
      const startingOffset = paginationBinding?.nextOffset ?? 0;
      const pageCount = execution.nextOffset - startingOffset;
      if (
        typeof execution.hasMore !== "boolean" ||
        !Number.isSafeInteger(execution.nextOffset) ||
        execution.nextOffset < startingOffset ||
        pageCount > definition.pagination.maximumItems ||
        (execution.hasMore && pageCount < 1) ||
        (execution.lastItemIdentitySha256 !== null && (
          typeof execution.lastItemIdentitySha256 !== "string" ||
          !SHA256.test(execution.lastItemIdentitySha256)
        ))
      ) {
        throw new ApplicationControlError(
          "control_operation_corrupt",
          "query projection owner returned an invalid bounded page",
        );
      }
      const redactedResult = redactQueryValue(execution.result);
      const redactedLiveObservation: SessionLiveObservationV1 | null = execution.liveObservation === undefined || execution.liveObservation === null
        ? null
        : redactQueryValue(execution.liveObservation) as SessionLiveObservationV1;
      if (Buffer.byteLength(canonicalJson(redactedResult), "utf8") > definition.pagination.maximumBytes) {
        throw new ApplicationControlError("control_payload_invalid", "query result exceeds its hard byte bound");
      }
      if (
        redactedLiveObservation !== null &&
        Buffer.byteLength(canonicalJson(redactedLiveObservation), "utf8") > 8 * 1024
      ) {
        throw new ApplicationControlError("control_payload_invalid", "live observation exceeds its hard byte bound");
      }
      let deliveryCursor = execution.deliveryCursor ?? null;
      if (execution.sessionDelivery !== undefined) {
        if (deliveryCursor !== null) {
          throw new ApplicationControlError("control_operation_corrupt", "query returned two delivery authorities");
        }
        deliveryCursor = execution.sessionDelivery.kind === "full_snapshot"
          ? this.options.delivery.installFullSnapshot(contextInput, execution.sessionDelivery)
          : this.options.delivery.deliverEventPage(contextInput, {
              ...execution.sessionDelivery,
              continuationCursor: request.deliveryCursor ?? null,
            });
      }
      let nextPageCursor = null;
      if (execution.hasMore) {
        if (definition.pagination.cursorKind === null || execution.lastItemIdentitySha256 === null) {
          throw new ApplicationControlError("control_operation_corrupt", "paginated query returned an incomplete continuation identity");
        }
        const issuedAt = this.now();
        nextPageCursor = (await this.options.cursors.mint({
          afterItemIdentitySha256: execution.lastItemIdentitySha256,
          cursorKind: definition.pagination.cursorKind,
          disclosureProfileSha256,
          expiresAt: new Date(issuedAt.getTime() + definition.pagination.maximumCursorLifetimeMs).toISOString(),
          grantSha256: principal.grantSha256,
          issuedAt: issuedAt.toISOString(),
          maximumItems: definition.pagination.maximumItems,
          nextOffset: execution.nextOffset,
          principalId: principal.principalId,
          queryKind: request.queryKind,
          redactionProfileId: definition.redactionProfileId,
          requestPayloadSha256: payloadSha256,
          resourceScope: snapshot.resourceScope,
          resourceVersion: snapshot.resourceVersion,
          snapshotIdentitySha256: snapshot.snapshotIdentitySha256,
        })).cursor;
      }
      const sessionId = snapshot.resourceScope.kind === "session" ? snapshot.resourceScope.sessionId : null;
      return Object.freeze({
        deliveryCursor,
        error: null,
        ledgerHead: execution.ledgerHead ?? null,
        liveObservation: redactedLiveObservation,
        operationId: null,
        projectionIdentity: execution.projectionIdentity ?? null,
        requestId: request.requestId,
        resourceScope: snapshot.resourceScope,
        resourceVersion: snapshot.resourceVersion,
        result: Object.freeze({ nextPageCursor, value: redactedResult }),
        schemaVersion: 1,
        sessionId,
        status: "ok",
        warnings: Object.freeze([]),
      });
    } catch (error) {
      const normalized = error instanceof ApplicationControlError
        ? error
        : new ApplicationControlError("control_payload_invalid", "application query failed strict validation", { cause: error });
      return Object.freeze({
        deliveryCursor: null,
        error: Object.freeze({ code: normalized.code, message: publicQueryErrorMessage(normalized.code) }),
        ledgerHead: null,
        liveObservation: null,
        operationId: null,
        projectionIdentity: null,
        requestId,
        resourceScope: null,
        resourceVersion: null,
        result: null,
        schemaVersion: 1,
        sessionId: null,
        status: normalized.code === "control_resync_required" ? "resync_required" : "rejected",
        warnings: Object.freeze([]),
      });
    }
  }

  private now(): Date {
    return this.options.hostRuntime.now();
  }
}
