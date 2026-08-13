import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { ApplicationControlError } from "./application-errors.js";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentitySchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  "timestamp must be canonical UTC ISO-8601",
);

export const principalContextV1Schema = z.object({
  authenticationId: boundedIdentitySchema,
  grantRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  grantSha256: sha256Schema,
  kind: z.enum(["human", "service", "worker"]),
  principalId: boundedIdentitySchema,
}).strict();

export type PrincipalContextV1 = Readonly<z.infer<typeof principalContextV1Schema>>;

export const hostControlIdentityV1Schema = z.object({
  controllerId: uuidSchema,
  identitySha256: sha256Schema,
  revision: z.literal(1),
  stateRootIdentitySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { identitySha256, ...content } = value;
  if (sha256Canonical(content) !== identitySha256) {
    context.addIssue({ code: "custom", message: "host control identity hash mismatch" });
  }
});

export type HostControlIdentityV1 = Readonly<z.infer<typeof hostControlIdentityV1Schema>>;

export const surfaceIdentityV1Schema = z.object({
  clientId: boundedIdentitySchema,
  connectionId: boundedIdentitySchema,
  surface: z.enum(["cli", "tui", "local_web", "vscode", "team_api"]),
}).strict();

export type SurfaceIdentityV1 = Readonly<z.infer<typeof surfaceIdentityV1Schema>>;

export const authenticatedCallContextV1Schema = z.object({
  principal: principalContextV1Schema,
  surface: surfaceIdentityV1Schema,
}).strict();

export type AuthenticatedCallContextV1 = Readonly<z.infer<typeof authenticatedCallContextV1Schema>>;

export const resourceScopeV1Schema = z.discriminatedUnion("kind", [
  z.object({ controllerId: uuidSchema, kind: z.literal("controller") }).strict(),
  z.object({ kind: z.literal("team"), teamId: uuidSchema }).strict(),
  z.object({ controllerId: uuidSchema, kind: z.literal("repository_catalog") }).strict(),
  z.object({ kind: z.literal("repository"), repositoryId: uuidSchema, teamId: uuidSchema.nullable() }).strict(),
  z.object({ kind: z.literal("session_catalog"), repositoryId: uuidSchema, teamId: uuidSchema.nullable() }).strict(),
  z.object({ kind: z.literal("session"), repositoryId: uuidSchema, sessionId: uuidSchema, teamId: uuidSchema.nullable() }).strict(),
  z.object({ controllerId: uuidSchema, kind: z.literal("worker"), workerId: uuidSchema }).strict(),
  z.object({ jobId: uuidSchema, kind: z.literal("job"), repositoryId: uuidSchema, sessionId: uuidSchema }).strict(),
]);

export type ResourceScopeV1 = Readonly<z.infer<typeof resourceScopeV1Schema>>;

export const sessionLedgerHeadV1Schema = z.object({
  eventId: uuidSchema.nullable(),
  eventIntegrityToken: z.string().regex(/^slh_v1_[A-Za-z0-9_-]{43}$/u).nullable(),
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sessionId: uuidSchema,
}).strict().superRefine((value, context) => {
  const identities = [value.eventId, value.eventIntegrityToken];
  if (value.sequence === 0) {
    if (!identities.every((identity) => identity === null)) {
      context.addIssue({ code: "custom", message: "zero session head must have null identities" });
    }
  } else if (!identities.every((identity) => identity !== null)) {
    context.addIssue({ code: "custom", message: "positive session head requires complete identities" });
  }
});

export type SessionLedgerHeadV1 = Readonly<z.infer<typeof sessionLedgerHeadV1Schema>>;

export const expectedResourceVersionV1Schema = z.discriminatedUnion("kind", [
  z.object({ generation: z.number().int().nonnegative(), kind: z.literal("controller_generation"), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("revision"), revision: z.number().int().nonnegative(), sha256: sha256Schema }).strict(),
  z.object({ head: sessionLedgerHeadV1Schema, kind: z.literal("session_ledger_head") }).strict(),
]);

export type ExpectedResourceVersionV1 = Readonly<z.infer<typeof expectedResourceVersionV1Schema>>;

export const applicationActionTargetV1Schema = z.discriminatedUnion("kind", [
  z.object({
    expectedVersion: expectedResourceVersionV1Schema,
    kind: z.literal("existing_resource"),
    resourceScope: resourceScopeV1Schema,
  }).strict(),
  z.object({
    catalogScope: resourceScopeV1Schema.pipe(
      z.custom<Extract<ResourceScopeV1, { readonly kind: "repository_catalog" }>>(
        (value) => typeof value === "object" && value !== null && "kind" in value && value.kind === "repository_catalog",
      ),
    ),
    expectedCatalogVersion: z.object({ kind: z.literal("revision"), revision: z.number().int().nonnegative(), sha256: sha256Schema }).strict(),
    kind: z.literal("new_repository"),
  }).strict(),
  z.object({
    catalogScope: resourceScopeV1Schema.pipe(
      z.custom<Extract<ResourceScopeV1, { readonly kind: "session_catalog" }>>(
        (value) => typeof value === "object" && value !== null && "kind" in value && value.kind === "session_catalog",
      ),
    ),
    expectedCatalogVersion: z.object({ kind: z.literal("revision"), revision: z.number().int().nonnegative(), sha256: sha256Schema }).strict(),
    kind: z.literal("new_session"),
  }).strict(),
]);

export type ApplicationActionTargetV1 = Readonly<z.infer<typeof applicationActionTargetV1Schema>>;

const artifactReferenceBase = {
  artifactId: uuidSchema,
  createdByOperationId: uuidSchema.nullable(),
  owner: z.literal("host_artifact_store"),
  resourceScope: resourceScopeV1Schema,
  schemaVersion: z.literal(1),
  transportVisibility: z.enum(["resource_authorized", "host_internal", "sealed_one_use"]),
} as const;

export const artifactReferenceV1Schema = z.discriminatedUnion("metadataDisclosure", [
  z.object({
    ...artifactReferenceBase,
    artifactSha256: z.null(),
    bytes: z.null(),
    mediaType: z.null(),
    metadataDisclosure: z.literal("opaque"),
    scopedIntegrityToken: z.string().regex(/^artref_v1_[A-Za-z0-9_-]{43}$/u),
  }).strict(),
  z.object({
    ...artifactReferenceBase,
    artifactSha256: sha256Schema,
    bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
    mediaType: z.string().min(1).max(128),
    metadataDisclosure: z.literal("content_authorized"),
    scopedIntegrityToken: z.null(),
  }).strict(),
]);

export type ArtifactReferenceV1 = Readonly<z.infer<typeof artifactReferenceV1Schema>>;
export type ArtifactReference = ArtifactReferenceV1;

export function assertWireArtifactReference(reference: ArtifactReferenceV1): void {
  if (reference.transportVisibility === "host_internal") {
    throw new ApplicationControlError(
      "control_artifact_forbidden",
      "host-internal artifact references cannot cross an application boundary",
    );
  }
}

export const prepareActionRequestV1Schema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  payload: z.unknown(),
  payloadSha256: sha256Schema,
  prepareIdempotencyKey: z.string().min(1).max(256),
  requestId: uuidSchema,
  schemaVersion: z.literal(1),
  target: applicationActionTargetV1Schema,
}).strict();

export type PrepareActionRequestV1<TPayload = unknown> = Readonly<
  Omit<z.infer<typeof prepareActionRequestV1Schema>, "payload"> & { readonly payload: TPayload }
>;

export const preparedActionV1Schema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  confirmation: z.enum(["explicit_human", "show_before_commit", "none"]),
  displayArtifact: artifactReferenceV1Schema,
  displaySha256: sha256Schema,
  expiresAt: timestampSchema,
  grantSha256: sha256Schema,
  payloadArtifact: artifactReferenceV1Schema,
  payloadSha256: sha256Schema,
  policyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  policySha256: sha256Schema,
  preparedActionId: uuidSchema,
  preparedActionSha256: sha256Schema,
  principalId: boundedIdentitySchema,
  singleUse: z.literal(true),
  target: applicationActionTargetV1Schema,
  targetIdentitySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { preparedActionSha256, ...content } = value;
  if (sha256Canonical(content) !== preparedActionSha256) {
    context.addIssue({ code: "custom", message: "prepared action hash mismatch" });
  }
});

export type PreparedActionV1 = Readonly<z.infer<typeof preparedActionV1Schema>>;

export const commitPreparedActionRequestV1Schema = z.object({
  idempotencyKey: z.string().min(1).max(256),
  preparedActionId: uuidSchema,
  preparedActionSha256: sha256Schema,
  requestId: uuidSchema,
  schemaVersion: z.literal(1),
}).strict();

export type CommitPreparedActionRequestV1 = Readonly<z.infer<typeof commitPreparedActionRequestV1Schema>>;

export interface AuthenticatedApplicationCommandV1 {
  readonly commit: CommitPreparedActionRequestV1;
  readonly context: AuthenticatedCallContextV1;
  readonly prepared: PreparedActionV1;
}

export const applicationPaginationCursorV1Schema = z.object({
  cursorAuthenticator: z.string().regex(/^pg_v1_[A-Za-z0-9_-]{43}$/u),
  cursorId: uuidSchema,
  schemaVersion: z.literal(1),
}).strict();

export type ApplicationPaginationCursorV1 = Readonly<z.infer<typeof applicationPaginationCursorV1Schema>>;

export const deliveryCursorV1Schema = z.object({
  afterEventId: uuidSchema.nullable(),
  afterEventIntegrityToken: z.string().regex(/^slh_v1_[A-Za-z0-9_-]{43}$/u).nullable(),
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deliveryGeneration: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 128),
  schemaVersion: z.literal(1),
  sessionId: uuidSchema,
}).strict().superRefine((value, context) => {
  const invalid = value.afterSequence === 0
    ? value.afterEventId !== null || value.afterEventIntegrityToken !== null
    : value.afterEventId === null || value.afterEventIntegrityToken === null;
  if (invalid) context.addIssue({ code: "custom", message: "delivery cursor zero/null identity is invalid" });
});

export type DeliveryCursorV1 = Readonly<z.infer<typeof deliveryCursorV1Schema>>;

export const applicationQueryRequestV1Schema = z.object({
  atVersion: expectedResourceVersionV1Schema.nullable(),
  deliveryCursor: deliveryCursorV1Schema.nullable().optional(),
  pageCursor: applicationPaginationCursorV1Schema.nullable(),
  payload: z.unknown(),
  queryKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  requestId: uuidSchema,
  resourceScope: resourceScopeV1Schema,
  schemaVersion: z.literal(1),
}).strict();

export type ApplicationQueryRequestV1<TPayload = unknown> = Readonly<
  Omit<z.infer<typeof applicationQueryRequestV1Schema>, "payload"> & { readonly payload: TPayload }
>;

export interface AuthenticatedApplicationQueryV1<TPayload = unknown> {
  readonly context: AuthenticatedCallContextV1;
  readonly request: ApplicationQueryRequestV1<TPayload>;
}

export interface StrictCodec<TPayload> {
  readonly maximumBytes: number;
  readonly schemaSha256: string;
  readonly decodeStrict: (wireValue: unknown) => TPayload;
}

export function createStrictCodec<TPayload>(input: {
  readonly maximumBytes: number;
  readonly schemaId: string;
  readonly schema: z.ZodType<TPayload>;
}): StrictCodec<TPayload> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 2 || input.maximumBytes > 16 * 1024 * 1024) {
    throw new RangeError("strict codec maximum bytes are invalid");
  }
  const schemaSha256 = sha256Canonical({ schema_id: input.schemaId, maximum_bytes: input.maximumBytes });
  return Object.freeze({
    decodeStrict: (wireValue: unknown) => {
      let bytes: number;
      try {
        bytes = new TextEncoder().encode(canonicalJson(wireValue)).byteLength;
      } catch (error) {
        throw new ApplicationControlError("control_payload_invalid", "payload is not canonical JSON", { cause: error });
      }
      if (bytes > input.maximumBytes) {
        throw new ApplicationControlError("control_payload_invalid", "payload exceeds its hard byte bound");
      }
      const result = input.schema.safeParse(wireValue);
      if (!result.success) {
        throw new ApplicationControlError("control_payload_invalid", "payload failed strict schema validation", { cause: result.error });
      }
      return result.data;
    },
    maximumBytes: input.maximumBytes,
    schemaSha256,
  });
}

export function decodeStrictJsonBytes<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  maximumBytes: number,
): T {
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    throw new ApplicationControlError("control_payload_invalid", "wire request has an invalid byte length");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ApplicationControlError("control_payload_invalid", "wire request is not valid UTF-8", { cause: error });
  }
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    throw new ApplicationControlError("control_payload_invalid", "wire request is not strict JSON", { cause: error });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationControlError("control_payload_invalid", "wire request failed strict schema validation", { cause: result.error });
  }
  return result.data;
}

export interface ProjectionIdentityV1 {
  readonly disclosureProfileSha256: string;
  readonly ledgerHead: SessionLedgerHeadV1;
  readonly projectionSha256: string;
  readonly projectorId: string;
  readonly projectorVersion: number;
  readonly schemaVersion: 1;
  readonly sessionId: string;
}

export interface SessionProjectionSnapshotV1<TProjection> {
  readonly identity: ProjectionIdentityV1;
  readonly projection: TProjection;
}

export interface SessionLiveObservationV1 {
  readonly coordinator: LiveSubjectObservationV1 | null;
  readonly evidenceLevel: "observation";
  readonly observedAt: string;
  readonly owner: LiveSubjectObservationV1 | null;
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly source: string;
}

export interface LiveSubjectObservationV1 {
  readonly identitySha256: string | null;
  readonly kind: "run_owner" | "background_worker" | "delegation_coordinator" | "controller";
  readonly state: "observed_alive" | "observed_absent" | "unknown";
}

export interface ApplicationEnvelopeV1<T> {
  readonly deliveryCursor: DeliveryCursorV1 | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly ledgerHead: SessionLedgerHeadV1 | null;
  readonly liveObservation: SessionLiveObservationV1 | null;
  readonly operationId: string | null;
  readonly projectionIdentity: ProjectionIdentityV1 | null;
  readonly requestId: string;
  readonly resourceScope: ResourceScopeV1 | null;
  readonly resourceVersion: ExpectedResourceVersionV1 | null;
  readonly result: T | null;
  readonly schemaVersion: 1;
  readonly sessionId: string | null;
  readonly status: "ok" | "accepted" | "rejected" | "resync_required";
  readonly warnings: readonly string[];
}

export interface ApplicationCommitBindingV1 {
  readonly actionKind: string;
  readonly authorizationDecisionSha256: string;
  readonly operationId: string;
  readonly preparedActionSha256: string;
  readonly principalId: string;
  readonly schemaVersion: 1;
}

export interface PersistedApplicationCommitBindingV1 {
  readonly action_kind: string;
  readonly authorization_decision_sha256: string;
  readonly operation_id: string;
  readonly prepared_action_sha256: string;
  readonly principal_id: string;
  readonly schema_version: 1;
}

export const persistedApplicationCommitBindingV1Schema = z.object({
  action_kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  authorization_decision_sha256: sha256Schema,
  operation_id: uuidSchema,
  prepared_action_sha256: sha256Schema,
  principal_id: boundedIdentitySchema,
  schema_version: z.literal(1),
}).strict();

export const persistedUserActionOriginV2Schema = z.union([
  z.object({ input_surface: z.enum(["cli", "tui"]), kind: z.literal("user") }).strict(),
  z.object({
    action_identity_sha256: sha256Schema,
    application_commit: persistedApplicationCommitBindingV1Schema,
    authentication_id: boundedIdentitySchema,
    client_id: boundedIdentitySchema,
    kind: z.literal("authenticated_surface"),
    request_id: uuidSchema,
    surface: z.enum(["cli", "tui", "local_web", "vscode", "team_api"]),
  }).strict().superRefine((value, context) => {
    if (value.application_commit.principal_id.length === 0) {
      context.addIssue({ code: "custom", message: "application principal identity is missing" });
    }
  }),
]);

export type PersistedUserActionOriginV2 =
  | Readonly<{ readonly input_surface: "cli" | "tui"; readonly kind: "user" }>
  | Readonly<{
      readonly action_identity_sha256: string;
      readonly application_commit: PersistedApplicationCommitBindingV1;
      readonly authentication_id: string;
      readonly client_id: string;
      readonly kind: "authenticated_surface";
      readonly request_id: string;
      readonly surface: "cli" | "tui" | "local_web" | "vscode" | "team_api";
    }>;

export type ProjectedUserActionOriginV2 =
  | Readonly<{
      readonly auditAvailability: "not_available_legacy";
      readonly authenticationId: null;
      readonly inputSurface: "cli" | "tui";
      readonly kind: "legacy_surface";
      readonly operationId: null;
      readonly principalId: "legacy_local_owner";
      readonly requestId: null;
    }>
  | Readonly<{
      readonly actionIdentitySha256: string;
      readonly applicationCommit: ApplicationCommitBindingV1;
      readonly authenticationId: string;
      readonly clientId: string;
      readonly kind: "authenticated_surface";
      readonly principalId: string;
      readonly requestId: string;
      readonly surface: "cli" | "tui" | "local_web" | "vscode" | "team_api";
    }>;

/**
 * PHASE21: replay never upgrades a historical CLI/TUI event into a current
 * authenticated principal. New authenticated origins retain their exact
 * persisted application binding instead of consulting ambient caller state;
 * a legacy local-owner projection can therefore never manufacture a current
 * team principal, grant, or audit fact.
 */
export function projectUserActionOrigin(
  input: PersistedUserActionOriginV2,
): ProjectedUserActionOriginV2 {
  const origin = persistedUserActionOriginV2Schema.parse(input) as PersistedUserActionOriginV2;
  if (origin.kind === "user") {
    return Object.freeze({
      auditAvailability: "not_available_legacy",
      authenticationId: null,
      inputSurface: origin.input_surface,
      kind: "legacy_surface",
      operationId: null,
      principalId: "legacy_local_owner",
      requestId: null,
    });
  }
  const commit = Object.freeze({
    actionKind: origin.application_commit.action_kind,
    authorizationDecisionSha256: origin.application_commit.authorization_decision_sha256,
    operationId: origin.application_commit.operation_id,
    preparedActionSha256: origin.application_commit.prepared_action_sha256,
    principalId: origin.application_commit.principal_id,
    schemaVersion: 1 as const,
  });
  return Object.freeze({
    actionIdentitySha256: origin.action_identity_sha256,
    applicationCommit: commit,
    authenticationId: origin.authentication_id,
    clientId: origin.client_id,
    kind: "authenticated_surface",
    principalId: commit.principalId,
    requestId: origin.request_id,
    surface: origin.surface,
  });
}

export function createPreparedAction(
  content: Omit<PreparedActionV1, "preparedActionSha256">,
): PreparedActionV1 {
  return Object.freeze(preparedActionV1Schema.parse({
    ...content,
    preparedActionSha256: sha256Canonical(content),
  }));
}

export function zeroSessionLedgerHead(sessionId: string): SessionLedgerHeadV1 {
  return Object.freeze(sessionLedgerHeadV1Schema.parse({
    eventId: null,
    eventIntegrityToken: null,
    schemaVersion: 1,
    sequence: 0,
    sessionId,
  }));
}

export function resourceScopeSha256(scope: ResourceScopeV1): string {
  return sha256Canonical(resourceScopeV1Schema.parse(scope));
}

export function expectedResourceVersionSha256(version: ExpectedResourceVersionV1): string {
  return sha256Canonical(expectedResourceVersionV1Schema.parse(version));
}
