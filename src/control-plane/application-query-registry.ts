import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type {
  ApplicationPaginationCursorV1,
  ApplicationQueryRequestV1,
  AuthenticatedCallContextV1,
  DeliveryCursorV1,
  ExpectedResourceVersionV1,
  ProjectionIdentityV1,
  ResourceScopeV1,
  SessionLedgerHeadV1,
  SessionLiveObservationV1,
  StrictCodec,
} from "./application-protocol.js";
import type { ApplicationPaginationCursorBindingV1 } from "./pagination-cursor-store.js";
import type { SessionDeliveryQueryDescriptorV1 } from "./delivery-cursor.js";

export interface ApplicationQueryResourceContractV1 {
  readonly acceptedAtVersionKinds: readonly ExpectedResourceVersionV1["kind"][];
  readonly allowCurrentVersion: boolean;
  readonly resourceKind: ResourceScopeV1["kind"];
}

export interface ApplicationStableSnapshotV1<TSnapshot = unknown> {
  readonly resourceScope: ResourceScopeV1;
  readonly resourceVersion: ExpectedResourceVersionV1;
  readonly snapshot: TSnapshot;
  readonly snapshotIdentitySha256: string;
}

export interface ApplicationQuerySnapshotReadContextV1<TPayload = unknown> {
  readonly paginationBinding: ApplicationPaginationCursorBindingV1 | null;
  readonly payload: TPayload;
}

export interface ApplicationQueryExecutionContextV1<TSnapshot = unknown> {
  readonly authorizationDecisionSha256: string;
  readonly authorizedResourceScope: ResourceScopeV1;
  readonly authorizedResourceVersion: ExpectedResourceVersionV1;
  readonly call: AuthenticatedCallContextV1;
  readonly paginationBinding: ApplicationPaginationCursorBindingV1 | null;
  readonly stableSnapshot: ApplicationStableSnapshotV1<TSnapshot>;
}

export interface ApplicationQueryExecutionResultV1<TResult = unknown> {
  readonly deliveryCursor?: DeliveryCursorV1 | null;
  readonly hasMore: boolean;
  readonly lastItemIdentitySha256: string | null;
  readonly ledgerHead?: SessionLedgerHeadV1 | null;
  readonly liveObservation?: SessionLiveObservationV1 | null;
  readonly nextOffset: number;
  readonly projectionIdentity?: ProjectionIdentityV1 | null;
  readonly result: TResult;
  /** Host-only delivery evidence consumed by the application query service. */
  readonly sessionDelivery?: SessionDeliveryQueryDescriptorV1;
}

export interface ApplicationQueryDefinitionV1<TPayload = unknown, TResult = unknown, TSnapshot = unknown> {
  readonly pagination: Readonly<{
    readonly cursorKind: string | null;
    readonly maximumBytes: number;
    readonly maximumCursorLifetimeMs: number;
    readonly maximumItems: number;
  }>;
  readonly payloadCodec: StrictCodec<TPayload>;
  readonly projectionOwner: string;
  readonly queryKind: string;
  readonly redactionProfileId: string;
  readonly requiredScopes: readonly string[];
  readonly resourceContracts: readonly ApplicationQueryResourceContractV1[];
  readonly execute: (
    context: ApplicationQueryExecutionContextV1<TSnapshot>,
    payload: TPayload,
  ) => Promise<ApplicationQueryExecutionResultV1<TResult>>;
  readonly readStableSnapshot: (
    scope: ResourceScopeV1,
    requestedVersion: ExpectedResourceVersionV1 | null,
    context?: ApplicationQuerySnapshotReadContextV1<TPayload>,
  ) => Promise<ApplicationStableSnapshotV1<TSnapshot>>;
}

export interface ApplicationQueryPageV1<TResult> {
  readonly nextPageCursor: ApplicationPaginationCursorV1 | null;
  readonly value: TResult;
}

const BUILTIN_PROJECTION_OWNERS = new Set([
  "ControlArtifactStore",
  "ControlOperationJournal",
  "DelegationProjector+ArtifactStore",
  "DelegationProjector+DelegationOperationStore",
  "RepositoryRegistry",
  "SessionProjectionService",
  "SessionRegistry",
  "TaskExecutionProjector+BackgroundProjector+WorktreeProjector",
  "TaskGraphLogProjection+ArtifactStore",
  "TaskGraphProjector+ArtifactStore",
  "TaskStateProjector",
  "WorktreeProjector",
]);

const BUILTIN_REDACTION_PROFILES = new Set([
  "phase21a.artifact.metadata-opaque.v1",
  "phase21a.delegation.doctor.local-owner.v1",
  "phase21a.delegation.parent.local-owner.v1",
  "phase21a.delegation.receipt.local-owner.v1",
  "phase21a.delegation.summaries.local-owner.v1",
  "phase21a.graph.logs.local-owner.v1",
  "phase21a.graph.revisions.local-owner.v1",
  "phase21a.graph.status.local-owner.v1",
  "phase21a.graph.worktrees.local-owner.v1",
  "phase21a.operation.local-owner.v1",
  "phase21a.plan.review.local-owner.v1",
  "phase21a.repository.public.v1",
  "phase21a.session.catalog.v1",
  "phase21a.session.local-owner-events.v1",
  "phase21a.session.local-owner.v1",
  "phase21a.session.tui-display.v1",
]);

export class ApplicationQueryRegistry {
  private readonly definitions: ReadonlyMap<string, ApplicationQueryDefinitionV1>;

  constructor(definitions: readonly ApplicationQueryDefinitionV1[]) {
    const entries = new Map<string, ApplicationQueryDefinitionV1>();
    for (const definition of definitions) {
      if (entries.has(definition.queryKind)) throw new TypeError(`duplicate application query ${definition.queryKind}`);
      if (
        definition.resourceContracts.length === 0 ||
        definition.requiredScopes.length === 0 ||
        definition.projectionOwner.length === 0 ||
        definition.redactionProfileId.length === 0 ||
        definition.pagination.maximumItems < 1 ||
        definition.pagination.maximumBytes < 1 ||
        definition.pagination.maximumCursorLifetimeMs < 1
      ) {
        throw new TypeError(`application query ${definition.queryKind} has an incomplete static contract`);
      }
      if (
        !BUILTIN_PROJECTION_OWNERS.has(definition.projectionOwner) ||
        !BUILTIN_REDACTION_PROFILES.has(definition.redactionProfileId)
      ) {
        throw new TypeError(`application query ${definition.queryKind} uses an unregistered built-in owner or redaction profile`);
      }
      entries.set(definition.queryKind, Object.freeze({
        ...definition,
        pagination: Object.freeze({ ...definition.pagination }),
        requiredScopes: Object.freeze([...definition.requiredScopes]),
        resourceContracts: Object.freeze(definition.resourceContracts.map((contract) => Object.freeze({
          ...contract,
          acceptedAtVersionKinds: Object.freeze([...contract.acceptedAtVersionKinds]),
        }))),
      }));
    }
    this.definitions = entries;
    Object.freeze(this);
  }

  resolve(request: ApplicationQueryRequestV1): ApplicationQueryDefinitionV1 {
    const definition = this.definitions.get(request.queryKind);
    if (definition === undefined) {
      throw new ApplicationControlError("control_query_unknown", "application query is not registered");
    }
    const contract = definition.resourceContracts.find(
      (candidate) => candidate.resourceKind === request.resourceScope.kind,
    );
    if (contract === undefined) {
      throw new ApplicationControlError("control_target_invalid", "query resource kind is not registered");
    }
    if (request.atVersion === null) {
      if (!contract.allowCurrentVersion || request.pageCursor !== null) {
        throw new ApplicationControlError("control_stale_projection", "query requires an exact resource version");
      }
    } else if (!contract.acceptedAtVersionKinds.includes(request.atVersion.kind)) {
      throw new ApplicationControlError("control_target_invalid", "query resource/version matrix is not registered");
    }
    return definition;
  }

  identitySha256(): string {
    return sha256Canonical([...this.definitions.values()].map((definition) => ({
      pagination: definition.pagination,
      payload_schema_sha256: definition.payloadCodec.schemaSha256,
      projection_owner: definition.projectionOwner,
      query_kind: definition.queryKind,
      redaction_profile_id: definition.redactionProfileId,
      required_scopes: definition.requiredScopes,
      resource_contracts: definition.resourceContracts,
    })));
  }

  queryKinds(): readonly string[] {
    return Object.freeze([...this.definitions.keys()].sort());
  }
}
