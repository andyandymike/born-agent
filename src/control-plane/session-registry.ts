import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  type ApplicationCommitBindingV1,
  sessionLedgerHeadV1Schema,
  zeroSessionLedgerHead,
  type ResourceScopeV1,
  type SessionLedgerHeadV1,
} from "./application-protocol.js";
import {
  CatalogJournal,
  type CatalogHeadV1,
  type CatalogRecordV1,
  type CatalogSnapshotV1,
} from "./catalog-journal.js";
import {
  durableRecordReferenceV1Schema,
  type DurableRecordReferenceV1,
} from "./control-operation-schema.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import type { RepositoryRegistry } from "./repository-registry.js";
import {
  applicationCancelRequestBindingV1Schema,
  type ApplicationCancelRequestBindingV1,
} from "../events/phase21-run-control-event-schema.js";

const legacySessionAdoptionSchema = z.object({
  eventCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  firstEventId: z.string().uuid(),
  firstRawEventSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sessionStorageIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const sessionEntrySchema = z.object({
  createdOperationId: z.string().uuid(),
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  initialLedgerHead: sessionLedgerHeadV1Schema,
  legacyAdoption: legacySessionAdoptionSchema.optional(),
  repositoryId: z.string().uuid(),
  sessionId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  const { entrySha256, ...content } = value;
  if (sha256Canonical(content) !== entrySha256) {
    context.addIssue({ code: "custom", message: "session catalog entry hash mismatch" });
  }
  if (
    value.initialLedgerHead.sessionId !== value.sessionId ||
    value.initialLedgerHead.sequence !== 0 ||
    value.initialLedgerHead.eventId !== null ||
    value.initialLedgerHead.eventIntegrityToken !== null
  ) {
    context.addIssue({ code: "custom", message: "new session entry must own an exact zero head" });
  }
});

const materializationIntentSchema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u).optional(),
  authorizationDecisionSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedZeroHeadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  intendedStorageIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  materializationIntentId: z.string().uuid(),
  operationId: z.string().uuid(),
  preparedActionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  principalId: z.string().min(1).max(256).optional(),
  repositoryId: z.string().uuid(),
  sessionId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  const { intentSha256, ...content } = value;
  if (sha256Canonical(content) !== intentSha256) {
    context.addIssue({ code: "custom", message: "materialization intent hash mismatch" });
  }
  const binding = [value.actionKind, value.authorizationDecisionSha256, value.principalId];
  if (binding.some((item) => item !== undefined) && !binding.every((item) => item !== undefined)) {
    context.addIssue({ code: "custom", message: "materialization intent application binding is incomplete" });
  }
  if (value.actionKind !== undefined && value.materializationIntentId !== value.operationId) {
    context.addIssue({ code: "custom", message: "application materialization intent must be operation-owned" });
  }
});

const materializationSchema = z.object({
  firstEventActionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u).nullable(),
  firstEventAuthorizationDecisionSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  firstEventId: z.string().uuid(),
  firstEventOperationId: z.string().uuid().nullable(),
  firstEventPreparedActionSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  firstEventPrincipalId: z.string().min(1).max(256).nullable(),
  firstRawEventSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  materializationIntentId: z.string().uuid().nullable(),
  materializationIntentSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  materializationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  origin: z.enum(["phase21_application", "legacy_migration"]),
  repositoryId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sessionStorageIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((value, context) => {
  const { materializationSha256, ...content } = value;
  if (sha256Canonical(content) !== materializationSha256) {
    context.addIssue({ code: "custom", message: "materialization record hash mismatch" });
  }
  const intent = [value.materializationIntentId, value.materializationIntentSha256];
  if (value.origin === "phase21_application" && !intent.every((item) => item !== null)) {
    context.addIssue({ code: "custom", message: "application materialization requires its exact intent" });
  }
  if (value.origin === "legacy_migration" && !intent.every((item) => item === null)) {
    context.addIssue({ code: "custom", message: "legacy materialization cannot invent an intent" });
  }
  const applicationBinding = [
    value.firstEventActionKind,
    value.firstEventAuthorizationDecisionSha256,
    value.firstEventOperationId,
    value.firstEventPreparedActionSha256,
    value.firstEventPrincipalId,
  ];
  if (value.origin === "phase21_application" && !applicationBinding.every((item) => item !== null)) {
    context.addIssue({ code: "custom", message: "application materialization requires its exact first-event binding" });
  }
  if (value.origin === "legacy_migration" && !applicationBinding.every((item) => item === null)) {
    context.addIssue({ code: "custom", message: "legacy materialization cannot invent an application binding" });
  }
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const applicationCommitBindingV1Schema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  authorizationDecisionSha256: sha256Schema,
  operationId: z.string().uuid(),
  preparedActionSha256: sha256Schema,
  principalId: z.string().min(1).max(256),
  schemaVersion: z.literal(1),
}).strict();

const runOwnerRegistrationContentSchema = z.object({
  initialObservedHead: sessionLedgerHeadV1Schema,
  ownerGenerationSha256: sha256Schema,
  ownerOperationId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
}).strict();

const runOwnerRegistrationSchema = runOwnerRegistrationContentSchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...content } = value;
  if (sha256Canonical(content) !== factSha256) {
    context.addIssue({ code: "custom", message: "run owner registration hash mismatch" });
  }
  if (
    value.ownerOperationId !== value.runId ||
    value.initialObservedHead.sessionId !== value.sessionId
  ) {
    context.addIssue({ code: "custom", message: "run owner registration identity mismatch" });
  }
});

const runOwnerObservationContentSchema = z.object({
  observationKind: z.enum(["progress", "started"]),
  observedHead: sessionLedgerHeadV1Schema,
  ownerGenerationSha256: sha256Schema,
  repositoryId: z.string().uuid(),
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
}).strict();

const runOwnerObservationSchema = runOwnerObservationContentSchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...content } = value;
  if (sha256Canonical(content) !== factSha256) {
    context.addIssue({ code: "custom", message: "run owner observation hash mismatch" });
  }
  if (value.observedHead.sessionId !== value.sessionId || value.observedHead.sequence < 1) {
    context.addIssue({ code: "custom", message: "run owner observation head mismatch" });
  }
});

const runCancelRequestContentSchema = z.object({
  applicationCommit: applicationCommitBindingV1Schema,
  expectedHead: sessionLedgerHeadV1Schema,
  ownerGenerationSha256: sha256Schema,
  reason: z.literal("user"),
  repositoryId: z.string().uuid(),
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
}).strict();

const runCancelRequestSchema = runCancelRequestContentSchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...content } = value;
  if (sha256Canonical(content) !== factSha256) {
    context.addIssue({ code: "custom", message: "run cancel request hash mismatch" });
  }
  if (
    value.applicationCommit.actionKind !== "run.cancel" ||
    value.expectedHead.sessionId !== value.sessionId
  ) {
    context.addIssue({ code: "custom", message: "run cancel request identity mismatch" });
  }
});

const runCancelSessionBindingContentSchema = z.object({
  cancelOperationId: z.string().uuid(),
  ownerGenerationSha256: sha256Schema,
  repositoryId: z.string().uuid(),
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  sessionRequestReference: durableRecordReferenceV1Schema,
  terminalBinding: applicationCancelRequestBindingV1Schema,
}).strict();

const runCancelSessionBindingSchema = runCancelSessionBindingContentSchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...content } = value;
  if (sha256Canonical(content) !== factSha256) {
    context.addIssue({ code: "custom", message: "run cancel session binding hash mismatch" });
  }
  if (
    value.sessionRequestReference.ownerKind !== "session" ||
    value.sessionRequestReference.recordId !== value.cancelOperationId ||
    value.sessionRequestReference.recordId !== value.terminalBinding.request_event_id ||
    value.sessionRequestReference.recordSha256 !== value.terminalBinding.request_event_sha256 ||
    value.ownerGenerationSha256 !== value.terminalBinding.target_owner_generation_sha256
  ) {
    context.addIssue({ code: "custom", message: "run cancel session binding identity mismatch" });
  }
});

const runCancelTerminalContentSchema = z.object({
  cancelOperationId: z.string().uuid(),
  ownerGenerationSha256: sha256Schema,
  repositoryId: z.string().uuid(),
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  terminalBinding: applicationCancelRequestBindingV1Schema,
  terminalReference: durableRecordReferenceV1Schema,
}).strict();

const runCancelTerminalSchema = runCancelTerminalContentSchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...content } = value;
  if (sha256Canonical(content) !== factSha256) {
    context.addIssue({ code: "custom", message: "run cancel terminal hash mismatch" });
  }
  if (
    value.terminalReference.ownerKind !== "session" ||
    value.ownerGenerationSha256 !== value.terminalBinding.target_owner_generation_sha256 ||
    value.cancelOperationId !== value.terminalBinding.request_event_id
  ) {
    context.addIssue({ code: "custom", message: "run cancel terminal identity mismatch" });
  }
});

export type SessionCatalogEntryV1 = Readonly<z.infer<typeof sessionEntrySchema>>;
export type SessionMaterializationIntentV1 = Readonly<z.infer<typeof materializationIntentSchema>>;
export type SessionMaterializationRecordV1 = Readonly<z.infer<typeof materializationSchema>>;
export type RunOwnerRegistrationV1 = Readonly<z.infer<typeof runOwnerRegistrationSchema>>;
export type RunOwnerObservationV1 = Readonly<z.infer<typeof runOwnerObservationSchema>>;
export type RunCancelRequestV1 = Readonly<z.infer<typeof runCancelRequestSchema>>;
export type RunCancelSessionBindingV1 = Readonly<z.infer<typeof runCancelSessionBindingSchema>>;
export type RunCancelTerminalV1 = Readonly<z.infer<typeof runCancelTerminalSchema>>;

export interface RunCancelBarrierViewV1 {
  readonly binding: Readonly<{
    readonly fact: RunCancelSessionBindingV1;
    readonly reference: DurableRecordReferenceV1;
  }> | null;
  readonly observations: readonly RunOwnerObservationV1[];
  readonly owner: Readonly<{
    readonly fact: RunOwnerRegistrationV1;
    readonly reference: DurableRecordReferenceV1;
  }> | null;
  readonly request: Readonly<{
    readonly fact: RunCancelRequestV1;
    readonly reference: DurableRecordReferenceV1;
  }> | null;
  readonly terminal: Readonly<{
    readonly fact: RunCancelTerminalV1;
    readonly reference: DurableRecordReferenceV1;
  }> | null;
}

export interface SessionCatalogProjectionV1 {
  readonly entries: readonly SessionCatalogEntryV1[];
  readonly head: CatalogHeadV1;
  readonly intents: readonly SessionMaterializationIntentV1[];
  readonly materializations: readonly SessionMaterializationRecordV1[];
}

/** AS3.3: deterministic read-path counters; they do not affect authority. */
export interface SessionRegistryObservationV1 {
  readonly onRunCatalogFullScan?: (recordCount: number) => void;
  readonly onRunCatalogIncrementalRead?: (input: Readonly<{
    readonly anchorRecordCount: number;
    readonly appendedRecordCount: number;
  }>) => void;
}

export class SessionRegistry {
  private readonly journals = new Map<string, Promise<CatalogJournal>>();
  private readonly runSnapshots = new Map<string, CatalogSnapshotV1>();

  constructor(
    private readonly paths: ControlStatePaths,
    private readonly repositories: RepositoryRegistry,
    private readonly observation?: SessionRegistryObservationV1,
  ) {}

  resourceScope(repositoryId: string): Extract<ResourceScopeV1, { readonly kind: "session_catalog" }> {
    return Object.freeze({ kind: "session_catalog", repositoryId, teamId: null });
  }

  async head(repositoryId: string): Promise<CatalogHeadV1> {
    return (await this.journal(repositoryId)).readHead();
  }

  async project(repositoryId: string): Promise<SessionCatalogProjectionV1> {
    const journal = await this.journal(repositoryId);
    const snapshot = await journal.readSnapshot();
    this.rememberRunSnapshot(repositoryId, snapshot);
    const records = snapshot.records;
    const entries: SessionCatalogEntryV1[] = [];
    const intents: SessionMaterializationIntentV1[] = [];
    const materializations: SessionMaterializationRecordV1[] = [];
    for (const record of records) this.projectRecord(record, entries, intents, materializations);
    this.validateProjection(entries, intents, materializations);
    return Object.freeze({
      entries: Object.freeze(entries),
      head: snapshot.head,
      intents: Object.freeze(intents),
      materializations: Object.freeze(materializations),
    });
  }

  /**
   * PHASE21: recover only the session-created record owned by the exact
   * application operation. The projection is observation-only and never
   * substitutes a same-session record created by another operation.
   */
  async findCreatedByOperation(repositoryId: string, operationId: string): Promise<Readonly<{
    readonly catalogRecord: CatalogRecordV1;
    readonly entry: SessionCatalogEntryV1;
    readonly head: CatalogHeadV1;
  }> | null> {
    const journal = await this.journal(repositoryId);
    const snapshot = await journal.readSnapshot();
    this.rememberRunSnapshot(repositoryId, snapshot);
    const entries: SessionCatalogEntryV1[] = [];
    const intents: SessionMaterializationIntentV1[] = [];
    const materializations: SessionMaterializationRecordV1[] = [];
    for (const record of snapshot.records) this.projectRecord(record, entries, intents, materializations);
    this.validateProjection(entries, intents, materializations);
    const entryMatches = entries.filter((entry) => entry.createdOperationId === operationId);
    const recordMatches = snapshot.records.filter((record) => {
      if (record.kind !== "session.created") return false;
      const parsed = sessionEntrySchema.safeParse(record.payload);
      return parsed.success && parsed.data.createdOperationId === operationId;
    });
    if (entryMatches.length > 1 || recordMatches.length > 1 || entryMatches.length !== recordMatches.length) {
      throw new ApplicationControlError("control_catalog_corrupt", "session operation has an inconsistent created record");
    }
    const entry = entryMatches[0];
    const catalogRecord = recordMatches[0];
    return entry === undefined || catalogRecord === undefined
      ? null
      : Object.freeze({ catalogRecord, entry, head: snapshot.head });
  }

  async create(input: {
    readonly expectedHead: CatalogHeadV1;
    readonly operationId: string;
    readonly repositoryId: string;
  }): Promise<{
    readonly catalogRecord: CatalogRecordV1;
    readonly entry: SessionCatalogEntryV1;
    readonly head: CatalogHeadV1;
  }> {
    if (await this.repositories.get(input.repositoryId) === null) {
      throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
    }
    const current = await this.project(input.repositoryId);
    const recovered = current.entries.find((entry) => entry.createdOperationId === input.operationId);
    if (recovered !== undefined) {
      const record = (await (await this.journal(input.repositoryId)).readRecords()).find(
        (candidate) => candidate.kind === "session.created" &&
          sessionEntrySchema.safeParse(candidate.payload).success &&
          sessionEntrySchema.parse(candidate.payload).createdOperationId === input.operationId,
      );
      if (record === undefined) {
        throw new ApplicationControlError("control_catalog_corrupt", "session operation record is missing");
      }
      return Object.freeze({ catalogRecord: record, entry: recovered, head: current.head });
    }
    const sessionId = randomUUID();
    const content = {
      createdOperationId: input.operationId,
      initialLedgerHead: zeroSessionLedgerHead(sessionId),
      repositoryId: input.repositoryId,
      sessionId,
    };
    const entry = Object.freeze(sessionEntrySchema.parse({ ...content, entrySha256: sha256Canonical(content) }));
    const result = await (await this.journal(input.repositoryId)).append({
      expectedHead: input.expectedHead,
      kind: "session.created",
      payload: entry,
    });
    return Object.freeze({ catalogRecord: result.record, entry, head: result.head });
  }

  /**
   * PHASE21: bind one already-existing, strictly decoded workspace session to
   * its registered repository without rewriting historical JSONL bytes.
   */
  async adoptLegacy(input: {
    readonly eventCount: number;
    readonly expectedHead: CatalogHeadV1;
    readonly firstEventId: string;
    readonly firstRawEventSha256: string;
    readonly operationId: string;
    readonly repositoryId: string;
    readonly sessionId: string;
    readonly sessionStorageIdentitySha256: string;
  }): Promise<{
    readonly catalogRecord: CatalogRecordV1;
    readonly entry: SessionCatalogEntryV1;
    readonly head: CatalogHeadV1;
  }> {
    if (await this.repositories.get(input.repositoryId) === null) {
      throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
    }
    const current = await this.project(input.repositoryId);
    const recovered = current.entries.find((entry) => entry.createdOperationId === input.operationId);
    if (recovered !== undefined) {
      if (
        recovered.sessionId !== input.sessionId ||
        recovered.repositoryId !== input.repositoryId ||
        recovered.legacyAdoption?.eventCount !== input.eventCount ||
        recovered.legacyAdoption?.firstEventId !== input.firstEventId ||
        recovered.legacyAdoption.firstRawEventSha256 !== input.firstRawEventSha256 ||
        recovered.legacyAdoption.sessionStorageIdentitySha256 !== input.sessionStorageIdentitySha256
      ) {
        throw new ApplicationControlError("control_catalog_corrupt", "legacy adoption operation is bound to another session identity");
      }
      const record = (await (await this.journal(input.repositoryId)).readRecords()).find(
        (candidate) => candidate.kind === "session.created" &&
          sessionEntrySchema.safeParse(candidate.payload).success &&
          sessionEntrySchema.parse(candidate.payload).createdOperationId === input.operationId,
      );
      if (record === undefined) throw new ApplicationControlError("control_catalog_corrupt", "legacy adoption operation record is missing");
      return Object.freeze({ catalogRecord: record, entry: recovered, head: current.head });
    }
    const existing = current.entries.find((entry) => entry.sessionId === input.sessionId);
    if (existing !== undefined) {
      throw new ApplicationControlError("control_catalog_conflict", "session is already cataloged by another operation");
    }
    if (
      !z.string().uuid().safeParse(input.firstEventId).success ||
      !z.string().uuid().safeParse(input.operationId).success ||
      !z.string().uuid().safeParse(input.sessionId).success ||
      !z.string().regex(/^[a-f0-9]{64}$/u).safeParse(input.firstRawEventSha256).success ||
      !z.string().regex(/^[a-f0-9]{64}$/u).safeParse(input.sessionStorageIdentitySha256).success
    ) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy session identity is invalid");
    }
    const content = {
      createdOperationId: input.operationId,
      initialLedgerHead: zeroSessionLedgerHead(input.sessionId),
      legacyAdoption: {
        eventCount: input.eventCount,
        firstEventId: input.firstEventId,
        firstRawEventSha256: input.firstRawEventSha256,
        sessionStorageIdentitySha256: input.sessionStorageIdentitySha256,
      },
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
    };
    const entry = Object.freeze(sessionEntrySchema.parse({ ...content, entrySha256: sha256Canonical(content) }));
    const result = await (await this.journal(input.repositoryId)).append({
      expectedHead: input.expectedHead,
      kind: "session.created",
      payload: entry,
    });
    return Object.freeze({ catalogRecord: result.record, entry, head: result.head });
  }

  async appendMaterializationIntent(input: {
    readonly expectedHead: CatalogHeadV1;
    readonly intent: Omit<SessionMaterializationIntentV1, "intentSha256">;
  }): Promise<{ readonly head: CatalogHeadV1; readonly intent: SessionMaterializationIntentV1 }> {
    const current = await this.project(input.intent.repositoryId);
    const entry = current.entries.find((candidate) => candidate.sessionId === input.intent.sessionId);
    if (entry === undefined) {
      throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
    }
    if (input.intent.expectedZeroHeadSha256 !== sessionZeroHeadSha256(entry.initialLedgerHead)) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization intent does not bind the catalog zero head");
    }
    if (current.intents.some((intent) => intent.sessionId === input.intent.sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "session already has a materialization intent");
    }
    const intent = Object.freeze(materializationIntentSchema.parse({
      ...input.intent,
      intentSha256: sha256Canonical(input.intent),
    }));
    const result = await (await this.journal(input.intent.repositoryId)).append({
      expectedHead: input.expectedHead,
      kind: "session.materialization.intent",
      payload: intent,
    });
    return Object.freeze({ head: result.head, intent });
  }

  async appendMaterialization(input: {
    readonly expectedHead: CatalogHeadV1;
    readonly materialization: Omit<SessionMaterializationRecordV1, "materializationSha256">;
  }): Promise<{ readonly head: CatalogHeadV1; readonly materialization: SessionMaterializationRecordV1 }> {
    const materialization = Object.freeze(materializationSchema.parse({
      ...input.materialization,
      materializationSha256: sha256Canonical(input.materialization),
    }));
    const current = await this.project(materialization.repositoryId);
    const existing = current.materializations.find((entry) => entry.sessionId === materialization.sessionId);
    if (existing !== undefined) {
      if (existing.materializationSha256 !== materialization.materializationSha256) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session has conflicting materialization facts");
      }
      return Object.freeze({ head: current.head, materialization: existing });
    }
    const intent = current.intents.find((entry) => entry.sessionId === materialization.sessionId);
    if (materialization.origin === "phase21_application") {
      if (
        intent === undefined ||
        intent.intentSha256 !== materialization.materializationIntentSha256 ||
        intent.materializationIntentId !== materialization.materializationIntentId ||
        intent.operationId !== materialization.firstEventOperationId ||
        intent.actionKind === undefined ||
        intent.actionKind !== materialization.firstEventActionKind ||
        intent.authorizationDecisionSha256 === undefined ||
        intent.authorizationDecisionSha256 !== materialization.firstEventAuthorizationDecisionSha256 ||
        intent.preparedActionSha256 !== materialization.firstEventPreparedActionSha256 ||
        intent.principalId === undefined ||
        intent.principalId !== materialization.firstEventPrincipalId
      ) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization does not match its durable intent and first-event binding");
      }
    } else if (intent !== undefined) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy materialization conflicts with a durable application intent");
    }
    const result = await (await this.journal(materialization.repositoryId)).append({
      expectedHead: input.expectedHead,
      kind: "session.materialized",
      payload: materialization,
    });
    return Object.freeze({ head: result.head, materialization });
  }

  /**
   * Register the one durable owner generation allowed to dispatch this run.
   * A surviving record is deliberately not treated as a liveness assertion;
   * it is an ownership fence that a replacement process must reconcile first.
   */
  async registerRunOwner(input: {
    readonly initialObservedHead: SessionLedgerHeadV1;
    readonly ownerGenerationSha256: string;
    readonly ownerOperationId: string;
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<RunCancelBarrierViewV1> {
    const catalog = await this.project(input.repositoryId);
    if (!catalog.entries.some((entry) => entry.sessionId === input.sessionId)) {
      throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
      if (current.view.owner !== null) {
        const owner = current.view.owner.fact;
        if (
          owner.ownerGenerationSha256 === input.ownerGenerationSha256 &&
          owner.ownerOperationId === input.ownerOperationId &&
          sha256Canonical(owner.initialObservedHead) === sha256Canonical(input.initialObservedHead)
        ) return current.view;
        throw new ApplicationControlError(
          "control_operation_busy",
          current.view.request === null
            ? "run already has another durable owner generation"
            : "durable cancellation barrier forbids a replacement owner generation",
        );
      }
      const content = runOwnerRegistrationContentSchema.parse({ ...input, schemaVersion: 1 });
      const fact = runOwnerRegistrationSchema.parse({ ...content, factSha256: sha256Canonical(content) });
      try {
        await (await this.journal(input.repositoryId)).append({
          expectedHead: current.head,
          kind: "session.run.owner.registered",
          payload: fact,
          recordId: input.ownerOperationId,
        });
        return (await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId)).view;
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 7) throw error;
      }
    }
    throw new ApplicationControlError("control_operation_busy", "run owner registration did not converge");
  }

  async observeRunOwner(input: {
    readonly observationKind: "progress" | "started";
    readonly observedHead: SessionLedgerHeadV1;
    readonly ownerGenerationSha256: string;
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<RunCancelBarrierViewV1> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
      this.assertRunOwner(current.view, input.ownerGenerationSha256);
      if (current.view.terminal !== null) {
        throw new ApplicationControlError("control_stale_projection", "run cancellation barrier is terminal");
      }
      if (
        input.observationKind === "progress" &&
        !current.view.observations.some((observation) => observation.observationKind === "started")
      ) {
        throw new ApplicationControlError("control_operation_busy", "run owner has not published its durable start");
      }
      if (current.view.observations.some((observation) =>
        observation.observationKind === input.observationKind &&
        sha256Canonical(observation.observedHead) === sha256Canonical(input.observedHead)
      )) return current.view;
      const content = runOwnerObservationContentSchema.parse({ ...input, schemaVersion: 1 });
      const fact = runOwnerObservationSchema.parse({ ...content, factSha256: sha256Canonical(content) });
      try {
        await (await this.journal(input.repositoryId)).append({
          expectedHead: current.head,
          kind: "session.run.owner.observed",
          payload: fact,
        });
        return (await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId)).view;
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 7) throw error;
      }
    }
    throw new ApplicationControlError("control_operation_busy", "run owner observation did not converge");
  }

  async requestRunCancel(input: {
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly ownerGenerationSha256: string;
    readonly reason: "user";
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<Readonly<{
    readonly barrier: RunCancelBarrierViewV1;
    readonly requestReference: DurableRecordReferenceV1;
  }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
      this.assertRunOwner(current.view, input.ownerGenerationSha256);
      if (current.view.terminal !== null) {
        throw new ApplicationControlError("control_stale_projection", "run cancellation barrier is terminal");
      }
      const started = current.view.observations.some((observation) => observation.observationKind === "started");
      if (!started) throw new ApplicationControlError("control_operation_busy", "run owner has not published its durable start");
      if (!this.runOwnerObservedHead(current.view, input.expectedHead)) {
        throw new ApplicationControlError("control_stale_projection", "cancel target head was not durably observed by this owner");
      }
      const content = runCancelRequestContentSchema.parse({ ...input, schemaVersion: 1 });
      const fact = runCancelRequestSchema.parse({ ...content, factSha256: sha256Canonical(content) });
      if (current.view.request !== null) {
        if (current.view.request.fact.factSha256 !== fact.factSha256) {
          throw new ApplicationControlError("control_operation_busy", "run already has another durable cancel request");
        }
        return Object.freeze({ barrier: current.view, requestReference: current.view.request.reference });
      }
      try {
        await (await this.journal(input.repositoryId)).append({
          expectedHead: current.head,
          kind: "session.run.cancel.requested",
          payload: fact,
          recordId: input.applicationCommit.operationId,
        });
        const committed = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
        if (committed.view.request === null) {
          throw new ApplicationControlError("control_catalog_corrupt", "durable cancel request disappeared after append");
        }
        return Object.freeze({ barrier: committed.view, requestReference: committed.view.request.reference });
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 7) throw error;
      }
    }
    throw new ApplicationControlError("control_operation_busy", "run cancel request did not converge");
  }

  async bindRunCancelRequest(input: {
    readonly cancelOperationId: string;
    readonly ownerGenerationSha256: string;
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly sessionRequestReference: DurableRecordReferenceV1;
    readonly terminalBinding: ApplicationCancelRequestBindingV1;
  }): Promise<RunCancelBarrierViewV1> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
      this.assertRunOwner(current.view, input.ownerGenerationSha256);
      if (current.view.request?.fact.applicationCommit.operationId !== input.cancelOperationId) {
        throw new ApplicationControlError("control_operation_busy", "exact durable cancel request is unavailable");
      }
      const content = runCancelSessionBindingContentSchema.parse({ ...input, schemaVersion: 1 });
      const fact = runCancelSessionBindingSchema.parse({ ...content, factSha256: sha256Canonical(content) });
      if (current.view.binding !== null) {
        if (current.view.binding.fact.factSha256 !== fact.factSha256) {
          throw new ApplicationControlError("control_session_history_missing_or_corrupt", "cancel request has a conflicting session binding");
        }
        return current.view;
      }
      if (current.view.terminal !== null) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "terminal cancel barrier has no session binding");
      }
      try {
        await (await this.journal(input.repositoryId)).append({
          expectedHead: current.head,
          kind: "session.run.cancel.session_bound",
          payload: fact,
        });
        return (await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId)).view;
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 7) throw error;
      }
    }
    throw new ApplicationControlError("control_operation_busy", "run cancel session binding did not converge");
  }

  async closeRunCancelBarrier(input: {
    readonly cancelOperationId: string;
    readonly ownerGenerationSha256: string;
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly terminalBinding: ApplicationCancelRequestBindingV1;
    readonly terminalReference: DurableRecordReferenceV1;
  }): Promise<RunCancelBarrierViewV1> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId);
      this.assertRunOwner(current.view, input.ownerGenerationSha256);
      if (
        current.view.binding === null ||
        sha256Canonical(current.view.binding.fact.terminalBinding) !== sha256Canonical(input.terminalBinding)
      ) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "terminal does not bind the exact durable cancel request");
      }
      const content = runCancelTerminalContentSchema.parse({ ...input, schemaVersion: 1 });
      const fact = runCancelTerminalSchema.parse({ ...content, factSha256: sha256Canonical(content) });
      if (current.view.terminal !== null) {
        if (current.view.terminal.fact.factSha256 !== fact.factSha256) {
          throw new ApplicationControlError("control_session_history_missing_or_corrupt", "cancel barrier has a conflicting terminal binding");
        }
        return current.view;
      }
      try {
        await (await this.journal(input.repositoryId)).append({
          expectedHead: current.head,
          kind: "session.run.cancel.terminal",
          payload: fact,
        });
        return (await this.readRunBarrierSnapshot(input.repositoryId, input.sessionId, input.runId)).view;
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 7) throw error;
      }
    }
    throw new ApplicationControlError("control_operation_busy", "run cancel terminal binding did not converge");
  }

  async readRunCancelBarrier(
    repositoryId: string,
    sessionId: string,
    runId: string,
  ): Promise<RunCancelBarrierViewV1> {
    return (await this.readRunBarrierSnapshot(repositoryId, sessionId, runId)).view;
  }

  private assertRunOwner(view: RunCancelBarrierViewV1, ownerGenerationSha256: string): void {
    if (view.owner === null || view.owner.fact.ownerGenerationSha256 !== ownerGenerationSha256) {
      throw new ApplicationControlError("control_stale_projection", "exact durable run owner generation is unavailable");
    }
  }

  private runOwnerObservedHead(view: RunCancelBarrierViewV1, head: SessionLedgerHeadV1): boolean {
    if (view.owner !== null && sha256Canonical(view.owner.fact.initialObservedHead) === sha256Canonical(head)) return true;
    return view.observations.some((observation) =>
      sha256Canonical(observation.observedHead) === sha256Canonical(head)
    );
  }

  private catalogRecordReference(repositoryId: string, record: CatalogRecordV1): DurableRecordReferenceV1 {
    return Object.freeze({
      ledgerId: `session-catalog:${repositoryId}`,
      ownerKind: "catalog" as const,
      recordId: record.recordId,
      recordSha256: record.recordSha256,
      sequence: record.revision,
    });
  }

  private async readRunBarrierSnapshot(
    repositoryId: string,
    sessionId: string,
    runId: string,
  ): Promise<Readonly<{ readonly head: CatalogHeadV1; readonly view: RunCancelBarrierViewV1 }>> {
    if (
      !z.string().uuid().safeParse(repositoryId).success ||
      !z.string().uuid().safeParse(sessionId).success ||
      !z.string().uuid().safeParse(runId).success
    ) {
      throw new ApplicationControlError("control_target_invalid", "run cancellation barrier identity is invalid");
    }
    const journal = await this.journal(repositoryId);
    const snapshot = await journal.readIncrementalSnapshot(this.runSnapshots.get(repositoryId) ?? null);
    this.rememberRunSnapshot(repositoryId, snapshot);
    const owners: Array<Readonly<{ fact: RunOwnerRegistrationV1; record: CatalogRecordV1 }>> = [];
    const observations: Array<Readonly<{ fact: RunOwnerObservationV1; record: CatalogRecordV1 }>> = [];
    const requests: Array<Readonly<{ fact: RunCancelRequestV1; record: CatalogRecordV1 }>> = [];
    const bindings: Array<Readonly<{ fact: RunCancelSessionBindingV1; record: CatalogRecordV1 }>> = [];
    const terminals: Array<Readonly<{ fact: RunCancelTerminalV1; record: CatalogRecordV1 }>> = [];
    try {
      for (const record of snapshot.records) {
        if (record.kind === "session.run.owner.registered") {
          const fact = runOwnerRegistrationSchema.parse(record.payload);
          if (fact.sessionId === sessionId && fact.runId === runId) owners.push({ fact, record });
        } else if (record.kind === "session.run.owner.observed") {
          const fact = runOwnerObservationSchema.parse(record.payload);
          if (fact.sessionId === sessionId && fact.runId === runId) observations.push({ fact, record });
        } else if (record.kind === "session.run.cancel.requested") {
          const fact = runCancelRequestSchema.parse(record.payload);
          if (fact.sessionId === sessionId && fact.runId === runId) requests.push({ fact, record });
        } else if (record.kind === "session.run.cancel.session_bound") {
          const fact = runCancelSessionBindingSchema.parse(record.payload);
          if (fact.sessionId === sessionId && fact.runId === runId) bindings.push({ fact, record });
        } else if (record.kind === "session.run.cancel.terminal") {
          const fact = runCancelTerminalSchema.parse(record.payload);
          if (fact.sessionId === sessionId && fact.runId === runId) terminals.push({ fact, record });
        }
      }
    } catch (error) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancellation control fact is invalid", { cause: error });
    }
    if (owners.length > 1 || requests.length > 1 || bindings.length > 1 || terminals.length > 1) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancellation barrier has duplicate singleton facts");
    }
    const owner = owners[0] ?? null;
    const request = requests[0] ?? null;
    const binding = bindings[0] ?? null;
    const terminal = terminals[0] ?? null;
    const facts = [
      ...owners.map((item) => item.fact),
      ...observations.map((item) => item.fact),
      ...requests.map((item) => item.fact),
      ...bindings.map((item) => item.fact),
      ...terminals.map((item) => item.fact),
    ];
    if (facts.some((fact) => fact.repositoryId !== repositoryId)) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancellation fact belongs to another repository");
    }
    if (owner === null && facts.length > 0) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancellation barrier has no owner registration");
    }
    if (owner !== null && observations.some((item) => item.fact.ownerGenerationSha256 !== owner.fact.ownerGenerationSha256)) {
      throw new ApplicationControlError("control_catalog_corrupt", "run owner observation changed generation");
    }
    const started = observations.some((item) => item.fact.observationKind === "started");
    if (request !== null && (
      owner === null ||
      !started ||
      request.fact.ownerGenerationSha256 !== owner.fact.ownerGenerationSha256 ||
      !this.runOwnerObservedHead(Object.freeze({
        binding: null,
        observations: observations.map((item) => item.fact),
        owner: owner === null ? null : Object.freeze({ fact: owner.fact, reference: this.catalogRecordReference(repositoryId, owner.record) }),
        request: null,
        terminal: null,
      }), request.fact.expectedHead)
    )) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancel request is not bound to a started observed owner");
    }
    if (binding !== null && (
      request === null ||
      binding.fact.cancelOperationId !== request.fact.applicationCommit.operationId ||
      binding.fact.ownerGenerationSha256 !== request.fact.ownerGenerationSha256
    )) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancel session binding does not match its request");
    }
    if (terminal !== null && (
      binding === null ||
      terminal.fact.cancelOperationId !== binding.fact.cancelOperationId ||
      terminal.fact.ownerGenerationSha256 !== binding.fact.ownerGenerationSha256 ||
      sha256Canonical(terminal.fact.terminalBinding) !== sha256Canonical(binding.fact.terminalBinding)
    )) {
      throw new ApplicationControlError("control_catalog_corrupt", "run cancel terminal does not match its exact session binding");
    }
    const view: RunCancelBarrierViewV1 = Object.freeze({
      binding: binding === null ? null : Object.freeze({
        fact: binding.fact,
        reference: this.catalogRecordReference(repositoryId, binding.record),
      }),
      observations: Object.freeze(observations.map((item) => item.fact)),
      owner: owner === null ? null : Object.freeze({
        fact: owner.fact,
        reference: this.catalogRecordReference(repositoryId, owner.record),
      }),
      request: request === null ? null : Object.freeze({
        fact: request.fact,
        reference: this.catalogRecordReference(repositoryId, request.record),
      }),
      terminal: terminal === null ? null : Object.freeze({
        fact: terminal.fact,
        reference: this.catalogRecordReference(repositoryId, terminal.record),
      }),
    });
    return Object.freeze({ head: snapshot.head, view });
  }

  private async journal(repositoryId: string): Promise<CatalogJournal> {
    if (!z.string().uuid().safeParse(repositoryId).success) {
      throw new ApplicationControlError("control_target_invalid", "repository ID is invalid");
    }
    const existing = this.journals.get(repositoryId);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const directory = join(this.paths.sessionCatalogRoot, repositoryId);
      await mkdir(directory, { mode: 0o700, recursive: true });
      return CatalogJournal.create({
        directory,
        observation: {
          onFullRecordScan: (recordCount) => this.observation?.onRunCatalogFullScan?.(recordCount),
          onIncrementalRecordRead: (input) => this.observation?.onRunCatalogIncrementalRead?.(input),
        },
        paths: this.paths,
        resourceScope: this.resourceScope(repositoryId),
      });
    })();
    this.journals.set(repositoryId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.journals.get(repositoryId) === pending) this.journals.delete(repositoryId);
      throw error;
    }
  }

  private rememberRunSnapshot(repositoryId: string, snapshot: CatalogSnapshotV1): void {
    const current = this.runSnapshots.get(repositoryId);
    if (current === undefined || snapshot.head.revision >= current.head.revision) {
      this.runSnapshots.set(repositoryId, snapshot);
    }
  }

  private projectRecord(
    record: CatalogRecordV1,
    entries: SessionCatalogEntryV1[],
    intents: SessionMaterializationIntentV1[],
    materializations: SessionMaterializationRecordV1[],
  ): void {
    try {
      if (record.kind === "session.created") entries.push(Object.freeze(sessionEntrySchema.parse(record.payload)));
      else if (record.kind === "session.materialization.intent") intents.push(Object.freeze(materializationIntentSchema.parse(record.payload)));
      else if (record.kind === "session.materialized") materializations.push(Object.freeze(materializationSchema.parse(record.payload)));
      else if (record.kind === "session.run.owner.registered") runOwnerRegistrationSchema.parse(record.payload);
      else if (record.kind === "session.run.owner.observed") runOwnerObservationSchema.parse(record.payload);
      else if (record.kind === "session.run.cancel.requested") runCancelRequestSchema.parse(record.payload);
      else if (record.kind === "session.run.cancel.session_bound") runCancelSessionBindingSchema.parse(record.payload);
      else if (record.kind === "session.run.cancel.terminal") runCancelTerminalSchema.parse(record.payload);
      else throw new Error("unknown session catalog record kind");
    } catch (error) {
      throw new ApplicationControlError("control_catalog_corrupt", "session catalog record is invalid", { cause: error });
    }
  }

  private validateProjection(
    entries: readonly SessionCatalogEntryV1[],
    intents: readonly SessionMaterializationIntentV1[],
    materializations: readonly SessionMaterializationRecordV1[],
  ): void {
    const unique = <T>(items: readonly T[], identity: (item: T) => string, label: string): void => {
      const seen = new Set<string>();
      for (const item of items) {
        const key = identity(item);
        if (seen.has(key)) throw new ApplicationControlError("control_catalog_corrupt", `session catalog has duplicate ${label}`);
        seen.add(key);
      }
    };
    unique(entries, (entry) => entry.sessionId, "session entry");
    unique(intents, (intent) => intent.sessionId, "materialization intent");
    unique(materializations, (marker) => marker.sessionId, "materialization marker");
    for (const intent of intents) {
      const entry = entries.find((candidate) => candidate.sessionId === intent.sessionId);
      if (
        entry === undefined ||
        entry.repositoryId !== intent.repositoryId ||
        intent.expectedZeroHeadSha256 !== sessionZeroHeadSha256(entry.initialLedgerHead)
      ) {
        throw new ApplicationControlError("control_catalog_corrupt", "materialization intent does not match its session entry");
      }
    }
    for (const marker of materializations) {
      const entry = entries.find((candidate) => candidate.sessionId === marker.sessionId);
      if (entry === undefined || entry.repositoryId !== marker.repositoryId) {
        throw new ApplicationControlError("control_catalog_corrupt", "materialization marker does not match its session entry");
      }
      const intent = intents.find((candidate) => candidate.sessionId === marker.sessionId);
      if (marker.origin === "legacy_migration") {
        if (intent !== undefined) throw new ApplicationControlError("control_catalog_corrupt", "legacy marker conflicts with an application intent");
        continue;
      }
      if (
        intent === undefined ||
        intent.intentSha256 !== marker.materializationIntentSha256 ||
        intent.materializationIntentId !== marker.materializationIntentId ||
        intent.operationId !== marker.firstEventOperationId ||
        intent.actionKind === undefined ||
        intent.actionKind !== marker.firstEventActionKind ||
        intent.authorizationDecisionSha256 === undefined ||
        intent.authorizationDecisionSha256 !== marker.firstEventAuthorizationDecisionSha256 ||
        intent.preparedActionSha256 !== marker.firstEventPreparedActionSha256 ||
        intent.principalId === undefined ||
        intent.principalId !== marker.firstEventPrincipalId
      ) {
        throw new ApplicationControlError("control_catalog_corrupt", "application marker does not match its exact materialization intent");
      }
    }
  }
}

export function sessionZeroHeadSha256(head: SessionLedgerHeadV1): string {
  if (head.sequence !== 0) throw new TypeError("session head is not zero");
  return sha256Canonical(head);
}
