import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import type { RunEvent } from "../../events/run-event.js";
import type { ApplicationCancelRequestBindingV1 } from "../../events/phase21-run-control-event-schema.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import {
  type ApplicationActionDefinitionV1,
  type ApplicationActionExecutionContextV1,
  type ApplicationActionExecutionResultV1,
} from "../application-action-registry.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  createStrictCodec,
  type ApplicationCommitBindingV1,
  type PreparedActionV1,
  type SessionLedgerHeadV1,
} from "../application-protocol.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type { ApplicationRecurringTaskPortV1 } from "../application-host-runtime.js";
import type { RepositoryRegistry } from "../repository-registry.js";
import type { SessionOwnerBroker } from "../session-owner-broker.js";
import {
  RunCancellationLifecycle,
  validateAndCloseAuthenticatedRunCancellation,
} from "../run-cancellation-lifecycle.js";
import type { SessionProjectionService } from "../session-projection-service.js";
import {
  sessionZeroHeadSha256,
  type SessionCatalogEntryV1,
  type SessionMaterializationIntentV1,
} from "../session-registry.js";
import type { ApplicationSessionRegistryV1 } from "../session-registry-ports.js";
import { sessionMessageResultCodec } from "./action-result-codecs.js";

const boundedOption = z.string().min(1).max(4_096).optional();
export const agentSessionMessagePayloadV1Schema = z.object({
  artifactCaptureBytes: boundedOption,
  command: z.literal("agent"),
  commandApproval: boundedOption,
  commandTimeoutMs: boundedOption,
  completionPolicy: boundedOption,
  contextCompactionThreshold: boundedOption,
  contextReserveOutputTokens: boundedOption,
  contextWindowTokens: boundedOption,
  continueApprovedPlan: z.object({
    goalId: z.string().uuid(),
    goalRevision: z.number().int().positive(),
    planId: z.string().uuid(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    revision: z.number().int().positive(),
  }).strict().optional(),
  dockerImage: boundedOption,
  editApproval: boundedOption,
  executor: boundedOption,
  maxCommandOutputBytes: boundedOption,
  maxDurationMs: boundedOption,
  maxSteps: boundedOption,
  maxTokens: boundedOption,
  maxToolOutputBytes: boundedOption,
  memoryMode: z.enum(["off", "local"]).optional(),
  mcpPromptArgumentsJson: z.string().max(64 * 1024).optional(),
  mcpPromptSelection: boundedOption,
  mcpServerIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u)).max(32).optional(),
  mode: z.enum(["plan", "build"]).optional(),
  modeSelection: z.enum(["explicit", "surface_default"]).optional(),
  model: boundedOption,
  policyConfig: boundedOption,
  policyProfile: boundedOption,
  provider: boundedOption,
  reportFormat: boundedOption,
  requestTimeoutMs: boundedOption,
  requireVerification: boundedOption,
  sandboxCpus: boundedOption,
  sandboxMemoryMiB: boundedOption,
  sandboxPids: boundedOption,
  sandboxTmpMiB: boundedOption,
  skillArguments: z.string().max(64 * 1024).optional(),
  skillSelections: z.array(z.string().min(1).max(512)).max(32).optional(),
  task: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024),
  taskProfile: boundedOption,
  verbose: z.boolean(),
}).strict();

export const chatSessionMessagePayloadV1Schema = z.object({
  command: z.literal("chat"),
  model: boundedOption,
  policyConfig: boundedOption,
  policyProfile: boundedOption,
  prompt: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024),
  provider: boundedOption,
  timeoutMs: boundedOption,
  toolsEnabled: z.boolean().optional(),
  verbose: z.boolean(),
}).strict();

export const sessionMessagePayloadV1Schema = z.discriminatedUnion("command", [
  agentSessionMessagePayloadV1Schema,
  chatSessionMessagePayloadV1Schema,
]);

export type AgentSessionMessagePayloadV1 = Readonly<z.infer<typeof agentSessionMessagePayloadV1Schema>>;
export type ChatSessionMessagePayloadV1 = Readonly<z.infer<typeof chatSessionMessagePayloadV1Schema>>;
export type SessionMessagePayloadV1 = Readonly<z.infer<typeof sessionMessagePayloadV1Schema>>;

export interface SessionMessageApplicationCancellationV1 {
  readonly signal: AbortSignal;
  /** Host-only lifecycle fault; never creates a user cancellation fact. */
  readonly hostEmergencyReason?: () => "tui_surface_fatal" | undefined;
  readonly terminalBinding: () => ApplicationCancelRequestBindingV1 | undefined;
}

export interface SessionMessageLaunchPortV1 {
  launch(input: Readonly<{
    applicationCancellation: SessionMessageApplicationCancellationV1;
    applicationCommit: ApplicationCommitBindingV1;
    authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    onRunStarted: (event: Extract<RunEvent, { type: "run.started" }>) => Promise<void>;
    payload: AgentSessionMessagePayloadV1;
    canonicalRootIdentitySha256: string;
    repositoryId: string;
    repositoryRoot: string;
    requestId: string;
    runId: string;
    sessionId: string;
    surface: "cli" | "tui";
    writer: V2SessionWriter;
  }>): Promise<Readonly<{ readonly exitCode: number }>>;
}

/** A surface-neutral execution owner; composition adapters supply its ports. */
export interface ChatExecutionPortV1 {
  execute(input: Readonly<{
    applicationCancellation: SessionMessageApplicationCancellationV1;
    applicationCommit: ApplicationCommitBindingV1;
    onRunStarted: (event: Extract<RunEvent, { type: "run.started" }>) => Promise<void>;
    payload: ChatSessionMessagePayloadV1;
    repositoryRoot: string;
    runId: string;
    sessionId: string;
    writer: V2SessionWriter;
  }>): Promise<Readonly<{ readonly exitCode: number }>>;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameHead(left: SessionLedgerHeadV1, right: SessionLedgerHeadV1): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function persistedApplicationCommit(event: DecodedStoredEvent): Readonly<Record<string, unknown>> | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const data = event.data as Readonly<Record<string, unknown>>;
  const direct = data.application_commit;
  if (typeof direct === "object" && direct !== null) return direct as Readonly<Record<string, unknown>>;
  const origin = data.origin;
  if (typeof origin !== "object" || origin === null || !("application_commit" in origin)) return null;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof commit === "object" && commit !== null ? commit as Readonly<Record<string, unknown>> : null;
}

function applicationOperationId(event: DecodedStoredEvent): string | null {
  const commit = persistedApplicationCommit(event);
  return commit !== null && typeof commit.operation_id === "string" ? commit.operation_id : null;
}

function hasExactApplicationCommit(event: DecodedStoredEvent, binding: ApplicationCommitBindingV1): boolean {
  const commit = persistedApplicationCommit(event);
  return commit !== null &&
    commit.action_kind === binding.actionKind &&
    commit.authorization_decision_sha256 === binding.authorizationDecisionSha256 &&
    commit.operation_id === binding.operationId &&
    commit.prepared_action_sha256 === binding.preparedActionSha256 &&
    commit.principal_id === binding.principalId &&
    commit.schema_version === 1;
}

function isExactMaterializationFirstEvent(
  event: DecodedStoredEvent,
  binding: ApplicationCommitBindingV1,
): boolean {
  if (!hasExactApplicationCommit(event, binding)) return false;
  if (event.scope === "run") {
    return event.type === "run.started" && event.runId === binding.operationId;
  }
  // PHASE21: Phase16 creates the initial tracked Goal before run.started. The
  // materialization barrier binds that exact authenticated first raw event;
  // the action completion predicate remains the later exact run.started fact.
  return event.type === "goal.created";
}

function eventReference(writer: V2SessionWriter, event: DecodedStoredEvent): DurableRecordReferenceV1 {
  const identity = writer.readDurableEventIdentity(event.eventId);
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session",
    recordId: event.eventId,
    recordSha256: identity.rawEventSha256,
    sequence: event.sessionSeq,
  });
}

function chatExitCodeFromTerminal(event: DecodedStoredEvent): number {
  if (event.scope !== "run") return 1;
  if (event.type === "run.completed") return 0;
  if (event.type === "run.cancelled") return 130;
  if (event.type !== "run.failed") return 1;
  if (event.data.category === "authentication" || event.data.category === "auth") return 4;
  if (event.data.category === "timeout") return 6;
  if (event.data.category === "internal" || event.data.category === "storage") return 1;
  return 5;
}

async function sessionStorageIdentitySha256(input: {
  readonly entry: SessionCatalogEntryV1;
  readonly writer: V2SessionWriter;
}): Promise<string> {
  const metadata = await lstat(input.writer.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session storage identity is unsafe");
  }
  return sha256Canonical({
    dev: metadata.dev,
    ino: metadata.ino,
    real_path: await realpath(input.writer.path),
    repository_id: input.entry.repositoryId,
    schema_version: 1,
    session_id: input.entry.sessionId,
  });
}

export function createSessionMessageAction(input: {
  readonly broker: SessionOwnerBroker;
  readonly chatExecution?: ChatExecutionPortV1;
  readonly recurringTasks: ApplicationRecurringTaskPortV1;
  readonly launcher: SessionMessageLaunchPortV1;
  readonly repositories: RepositoryRegistry;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: ApplicationSessionRegistryV1;
}): ApplicationActionDefinitionV1<SessionMessagePayloadV1> {
  const readEntry = async (repositoryId: string, sessionId: string): Promise<SessionCatalogEntryV1> => {
    const catalog = await input.sessions.project(repositoryId);
    const entry = catalog.entries.find((candidate) => candidate.sessionId === sessionId);
    if (entry === undefined) throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
    return entry;
  };

  const ensureIntent = async (
    context: ApplicationActionExecutionContextV1,
    entry: SessionCatalogEntryV1,
    prepared: PreparedActionV1,
    repositoryRoot: string,
  ): Promise<Readonly<{ readonly created: boolean; readonly intent: SessionMaterializationIntentV1 }>> => {
    const current = await input.sessions.project(entry.repositoryId);
    const existing = current.intents.find((candidate) => candidate.sessionId === entry.sessionId);
    if (existing !== undefined) {
      if (
        existing.operationId !== context.operationId ||
        existing.preparedActionSha256 !== prepared.preparedActionSha256 ||
        existing.actionKind !== context.applicationCommit.actionKind ||
        existing.authorizationDecisionSha256 !== context.applicationCommit.authorizationDecisionSha256 ||
        existing.principalId !== context.applicationCommit.principalId
      ) {
        throw new ApplicationControlError("control_operation_busy", "session has another materialization winner");
      }
      return Object.freeze({ created: false, intent: existing });
    }
    const sessionPath = resolve(repositoryRoot, ".bornagent", "sessions", `${entry.sessionId}.jsonl`);
    const created = (await input.sessions.appendMaterializationIntent({
      expectedHead: current.head,
      intent: {
        actionKind: context.applicationCommit.actionKind,
        authorizationDecisionSha256: context.applicationCommit.authorizationDecisionSha256,
        expectedZeroHeadSha256: sessionZeroHeadSha256(entry.initialLedgerHead),
        intendedStorageIdentitySha256: sha256Canonical({
          repository_id: entry.repositoryId,
          schema_version: 1,
          session_id: entry.sessionId,
          storage_path: sessionPath,
        }),
        materializationIntentId: context.operationId,
        operationId: context.operationId,
        preparedActionSha256: prepared.preparedActionSha256,
        principalId: context.applicationCommit.principalId,
        repositoryId: entry.repositoryId,
        sessionId: entry.sessionId,
      },
    })).intent;
    return Object.freeze({ created: true, intent: created });
  };

  const ensureMarker = async (
    context: ApplicationActionExecutionContextV1,
    entry: SessionCatalogEntryV1,
    intent: SessionMaterializationIntentV1,
    writer: V2SessionWriter,
  ): Promise<void> => {
    const first = writer.readDurableFirstIdentity();
    if (first.eventId === null || first.rawEventSha256 === null || first.sequence !== 1) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization has no durable first event");
    }
    const firstEvent = writer.events[0];
    if (
      firstEvent === undefined ||
      firstEvent.eventId !== first.eventId ||
      !isExactMaterializationFirstEvent(firstEvent, context.applicationCommit) ||
      intent.operationId !== context.operationId ||
      intent.actionKind !== context.applicationCommit.actionKind ||
      intent.authorizationDecisionSha256 !== context.applicationCommit.authorizationDecisionSha256 ||
      intent.preparedActionSha256 !== context.applicationCommit.preparedActionSha256 ||
      intent.principalId !== context.applicationCommit.principalId
    ) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization first event does not match its exact application binding");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await input.sessions.project(entry.repositoryId);
      const existing = current.materializations.find((candidate) => candidate.sessionId === entry.sessionId);
      if (existing !== undefined) {
        if (
          existing.firstEventId !== first.eventId ||
          existing.firstRawEventSha256 !== first.rawEventSha256 ||
          existing.firstEventOperationId !== context.operationId ||
          existing.firstEventActionKind !== context.applicationCommit.actionKind ||
          existing.firstEventAuthorizationDecisionSha256 !== context.applicationCommit.authorizationDecisionSha256 ||
          existing.firstEventPreparedActionSha256 !== context.applicationCommit.preparedActionSha256 ||
          existing.firstEventPrincipalId !== context.applicationCommit.principalId ||
          existing.materializationIntentSha256 !== intent.intentSha256
        ) {
          throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization marker conflicts with first event");
        }
        return;
      }
      try {
        await input.sessions.appendMaterialization({
          expectedHead: current.head,
          materialization: {
            firstEventActionKind: context.applicationCommit.actionKind,
            firstEventAuthorizationDecisionSha256: context.applicationCommit.authorizationDecisionSha256,
            firstEventId: first.eventId,
            firstEventOperationId: context.operationId,
            firstEventPreparedActionSha256: context.applicationCommit.preparedActionSha256,
            firstEventPrincipalId: context.applicationCommit.principalId,
            firstRawEventSha256: first.rawEventSha256,
            materializationIntentId: intent.materializationIntentId,
            materializationIntentSha256: intent.intentSha256,
            origin: "phase21_application",
            repositoryId: entry.repositoryId,
            sessionId: entry.sessionId,
            sessionStorageIdentitySha256: await sessionStorageIdentitySha256({ entry, writer }),
          },
        });
        return;
      } catch (error) {
        if (!(error instanceof ApplicationControlError) || error.code !== "control_catalog_conflict" || attempt === 2) throw error;
      }
    }
  };

  const recoverExisting = async (
    context: ApplicationActionExecutionContextV1,
    entry: SessionCatalogEntryV1,
    intent: SessionMaterializationIntentV1 | null,
    payload: SessionMessagePayloadV1,
    writer: V2SessionWriter,
  ): Promise<ApplicationActionExecutionResultV1 | null> => {
    const owned = writer.events.filter((event) => applicationOperationId(event) === context.operationId);
    if (owned.length === 0) return null;
    const started = owned.find((event) => event.scope === "run" && event.type === "run.started");
    if (started === undefined || started.scope !== "run") {
      throw new ApplicationControlError("control_operation_busy", "application materialization stopped before run start reconciliation");
    }
    if (!hasExactApplicationCommit(started, context.applicationCommit)) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "run start does not match the exact application operation binding");
    }
    if (
      started.data.command !== payload.command ||
      (payload.command === "chat" && (
        started.runId !== context.operationId ||
        started.data.input.text !== payload.prompt
      ))
    ) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "run start does not match the prepared session message command",
      );
    }
    if (intent !== null) await ensureMarker(context, entry, intent, writer);
    const terminal = writer.events.find((event) =>
      event.scope === "run" &&
      event.runId === started.runId &&
      ["run.completed", "run.incomplete", "run.failed", "run.cancelled", "run.budget_exceeded"].includes(event.type)
    );
    if (terminal === undefined) {
      throw new ApplicationControlError("control_operation_busy", "application run has no reconciled terminal fact");
    }
    if (
      payload.command === "chat" &&
      terminal.type !== "run.completed" &&
      terminal.type !== "run.failed" &&
      terminal.type !== "run.cancelled"
    ) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "Chat operation has a terminal fact that its owner cannot produce",
      );
    }
    await validateAuthenticatedCancellationTerminal(entry, started, terminal, writer);
    const refs = Object.freeze([eventReference(writer, started), eventReference(writer, terminal)]);
    const resolvedHead = payload.command === "chat"
      ? input.sessionProjection.hostHeadForExactWriterEvent({
          eventId: terminal.eventId,
          rawEventSha256: refs[1]!.recordSha256,
          sequence: terminal.sessionSeq,
          sessionId: entry.sessionId,
          writer,
        })
      : (await input.sessionProjection.read({
          repositoryId: entry.repositoryId,
          requestedHead: null,
          sessionId: entry.sessionId,
        })).head.publicHead;
    return Object.freeze({
      domainRecordRefs: refs,
      primaryDomainRecord: refs[0]!,
      resolvedResourceScope: Object.freeze({
        kind: "session" as const,
        repositoryId: entry.repositoryId,
        sessionId: entry.sessionId,
        teamId: null,
      }),
      resolvedResourceVersion: { head: resolvedHead, kind: "session_ledger_head" as const },
      result: Object.freeze({
        ...(payload.command === "chat" ? { exitCode: chatExitCodeFromTerminal(terminal) } : {}),
        recovered: true,
        runId: started.runId,
        terminal: terminal.type,
      }),
      underlyingOperationRefs: Object.freeze([]),
    });
  };

  const validateAuthenticatedCancellationTerminal = async (
    entry: SessionCatalogEntryV1,
    started: Extract<DecodedStoredEvent, { readonly scope: "run" }>,
    terminal: DecodedStoredEvent,
    writer: V2SessionWriter,
  ): Promise<void> => {
    if (terminal.type !== "run.cancelled") return;
    await validateAndCloseAuthenticatedRunCancellation({
      repositoryId: entry.repositoryId,
      runId: started.runId,
      sessionId: entry.sessionId,
      sessions: input.sessions,
      terminal,
      writer,
    });
  };

  const definition: ApplicationActionDefinitionV1<SessionMessagePayloadV1> = {
    actionKind: "session.message.submit",
    confirmation: "show_before_commit",
    display: (resolved, payload) => Object.freeze({
      summary: payload.command === "chat"
        ? `Start a Chat run in session ${resolved.resourceScope.kind === "session" ? resolved.resourceScope.sessionId : "unknown"}`
        : `Submit a ${payload.mode ?? "build"} Agent task to session ${resolved.resourceScope.kind === "session" ? resolved.resourceScope.sessionId : "unknown"}`,
      warnings: Object.freeze([]),
    }),
    effectClass: "runtime_effect",
    execute: async (context, payload, prepared) => {
      if (context.resolvedTarget.resourceScope.kind !== "session") {
        throw new ApplicationControlError("control_target_invalid", "session message requires a session target");
      }
      const scope = context.resolvedTarget.resourceScope;
      return input.broker.serialize(scope.sessionId, async () => {
        if (input.broker.activePort(scope.sessionId) !== null) {
          throw new ApplicationControlError("control_operation_busy", "session already has an active in-process owner");
        }
        const entry = await readEntry(scope.repositoryId, scope.sessionId);
        const repository = await input.repositories.get(scope.repositoryId);
        if (repository === null || repository.status !== "active") {
          throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
        }
        const repositoryRoot = await input.repositories.readRoot(repository);
        const expected = context.resolvedTarget.resourceVersion.kind === "session_ledger_head"
          ? context.resolvedTarget.resourceVersion.head
          : null;
        if (expected === null) throw new ApplicationControlError("control_target_invalid", "session message requires a ledger head");
        const current = await input.sessionProjection.read({ repositoryId: scope.repositoryId, requestedHead: null, sessionId: scope.sessionId });
        const currentMatchesPreparedHead = sameHead(current.head.publicHead, expected);
        let intent: SessionMaterializationIntentV1 | null = null;
        let intentCreated = false;
        if (expected.sequence === 0) {
          if (!currentMatchesPreparedHead) {
            const catalog = await input.sessions.project(entry.repositoryId);
            const existingIntent = catalog.intents.find((candidate) => candidate.sessionId === entry.sessionId);
            if (
              existingIntent === undefined ||
              existingIntent.operationId !== context.operationId ||
              existingIntent.preparedActionSha256 !== prepared.preparedActionSha256
            ) {
              throw new ApplicationControlError("control_stale_projection", "session changed before materialization ownership");
            }
          }
          const ensured = await ensureIntent(context, entry, prepared, repositoryRoot);
          intent = ensured.intent;
          intentCreated = ensured.created;
        }
        const sessionPath = join(repositoryRoot, ".bornagent", "sessions", `${entry.sessionId}.jsonl`);
        let present = false;
        let empty = false;
        try {
          const metadata = await lstat(sessionPath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session storage is unsafe");
          }
          present = true;
          empty = metadata.size === 0;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (intent !== null && !intentCreated && (!present || empty)) {
          throw new ApplicationControlError(
            "control_session_history_missing_or_corrupt",
            present
              ? "durable materialization intent has no recoverable first event"
              : "durable materialization intent exists but session storage is missing",
          );
        }
        const writer = !present
          ? await V2SessionWriter.createNew(repositoryRoot, entry.sessionId)
          : empty
            ? await V2SessionWriter.openMaterializationResidue(repositoryRoot, entry.sessionId)
            : await V2SessionWriter.openExisting(repositoryRoot, entry.sessionId);
        const activeRead = input.sessionProjection.activeReadPort({ entry, writer });
        const lifecycle = new RunCancellationLifecycle({
          acceptsObservedHead: (head) => input.sessionProjection.verifyOwnerObservedHead(writer, head),
          activeRead,
          broker: input.broker,
          ownerApplicationOperationId: context.operationId,
          ownerRegistryOperationId: context.operationId,
          recurringTasks: input.recurringTasks,
          repositoryId: entry.repositoryId,
          runId: context.operationId,
          sessionId: entry.sessionId,
          sessions: input.sessions,
          writer,
        });
        try {
          const recovered = await recoverExisting(context, entry, intent, payload, writer);
          if (recovered !== null) return recovered;
          if (expected.sequence > 0) {
            const actual = input.sessionProjection.activeReadPort({ entry, writer });
            const owned = await actual.readStableSnapshot();
            if (!sameHead(owned.head.publicHead, expected)) {
              throw new ApplicationControlError("control_stale_projection", "session changed before run launch");
            }
          } else if (!intentCreated || !currentMatchesPreparedHead || writer.events.length !== 0) {
            throw new ApplicationControlError("control_session_history_missing_or_corrupt", "materialization residue belongs to another operation");
          }
          await lifecycle.activate(expected);
          const onRunStarted = async () => {
            if (intent !== null) await ensureMarker(context, entry, intent, writer);
            await lifecycle.observeStarted();
          };
          const launched = payload.command === "agent"
            ? await input.launcher.launch({
                applicationCancellation: lifecycle.applicationCancellation,
                applicationCommit: context.applicationCommit,
                authenticatedMutation: Object.freeze({
                  actionIdentitySha256: sha256Canonical({
                    application_commit: context.applicationCommit,
                    resource_scope: scope,
                    schema_version: 1,
                  }),
                  applicationCommit: context.applicationCommit,
                  authenticationId: context.call.principal.authenticationId,
                  requestId: context.requestId,
                  surface: context.call.surface,
                }),
                onRunStarted,
                payload,
                canonicalRootIdentitySha256: repository.canonicalRootIdentitySha256,
                repositoryId: repository.repositoryId,
                repositoryRoot,
                requestId: context.requestId,
                runId: context.operationId,
                sessionId: entry.sessionId,
                surface: context.call.surface.surface === "tui" ? "tui" : "cli",
                writer,
              })
            : await (input.chatExecution ?? {
                execute: async () => {
                  throw new ApplicationControlError(
                    "control_target_invalid",
                    "Chat execution authority is unavailable",
                  );
                },
              }).execute({
                applicationCancellation: lifecycle.applicationCancellation,
                applicationCommit: context.applicationCommit,
                onRunStarted,
                payload,
                repositoryRoot,
                runId: context.operationId,
                sessionId: entry.sessionId,
                writer,
              });
          const started = writer.events.find((event) =>
            event.scope === "run" && event.type === "run.started" && applicationOperationId(event) === context.operationId
          );
          if (started === undefined || started.scope !== "run") {
            throw new ApplicationControlError("control_operation_busy", "run launch returned without a canonical application start fact");
          }
          if (intent !== null) await ensureMarker(context, entry, intent, writer);
          const terminal = writer.events.find((event) =>
            event.scope === "run" && event.runId === started.runId &&
            ["run.completed", "run.incomplete", "run.failed", "run.cancelled", "run.budget_exceeded"].includes(event.type)
          );
          if (payload.command === "chat" && terminal === undefined) {
            throw new ApplicationControlError(
              "control_operation_busy",
              "Chat execution returned without a canonical terminal fact",
            );
          }
          if (
            payload.command === "chat" &&
            terminal !== undefined &&
            terminal.type !== "run.completed" &&
            terminal.type !== "run.failed" &&
            terminal.type !== "run.cancelled"
          ) {
            throw new ApplicationControlError(
              "control_session_history_missing_or_corrupt",
              "Chat execution produced an unsupported terminal fact",
            );
          }
          if (
            payload.command === "chat" &&
            terminal !== undefined &&
            launched.exitCode !== chatExitCodeFromTerminal(terminal)
          ) {
            throw new ApplicationControlError(
              "control_session_history_missing_or_corrupt",
              "Chat execution result does not match its durable terminal fact",
            );
          }
          if (terminal !== undefined) {
            await validateAuthenticatedCancellationTerminal(entry, started, terminal, writer);
          }
          const refs = Object.freeze([
            eventReference(writer, started),
            ...(terminal === undefined ? [] : [eventReference(writer, terminal)]),
          ]);
          const resolvedHead = payload.command === "chat" && terminal !== undefined
            ? input.sessionProjection.hostHeadForExactWriterEvent({
                eventId: terminal.eventId,
                rawEventSha256: refs.at(-1)!.recordSha256,
                sequence: terminal.sessionSeq,
                sessionId: entry.sessionId,
                writer,
              })
            : (await input.sessionProjection.activeReadPort({ entry, writer }).readStableSnapshot()).head.publicHead;
          return Object.freeze({
            domainRecordRefs: refs,
            primaryDomainRecord: refs[0]!,
            resolvedResourceScope: scope,
            resolvedResourceVersion: { head: resolvedHead, kind: "session_ledger_head" as const },
            result: Object.freeze({
              exitCode: payload.command === "chat" && terminal !== undefined
                ? chatExitCodeFromTerminal(terminal)
                : launched.exitCode,
              recovered: false,
              runId: started.runId,
              terminal: terminal?.type ?? "interrupted",
            }),
            underlyingOperationRefs: Object.freeze([]),
          });
        } finally {
          await lifecycle.finish();
          await writer.close().catch(() => undefined);
        }
      });
    },
    reconcile: async (context, payload) => {
      if (context.resolvedTarget.resourceScope.kind !== "session") {
        throw new ApplicationControlError("control_target_invalid", "session message requires a session target");
      }
      const scope = context.resolvedTarget.resourceScope;
      return input.broker.serialize(scope.sessionId, async () => {
        // PHASE21: cross-store recovery scans only the exact application
        // operation's durable run facts. It never calls the launcher and an
        // active writer remains busy rather than degrading to a stale read.
        if (input.broker.activePort(scope.sessionId) !== null) {
          throw new ApplicationControlError("control_operation_busy", "session already has an active in-process owner");
        }
        const entry = await readEntry(scope.repositoryId, scope.sessionId);
        const repository = await input.repositories.get(scope.repositoryId);
        if (repository === null || repository.status !== "active") {
          throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
        }
        const repositoryRoot = await input.repositories.readRoot(repository);
        const catalog = await input.sessions.project(entry.repositoryId);
        const intent = catalog.intents.find((candidate) => candidate.sessionId === entry.sessionId) ?? null;
        const writer = await V2SessionWriter.openExisting(repositoryRoot, entry.sessionId);
        const activeRead = input.sessionProjection.activeReadPort({ entry, writer });
        const release = input.broker.register(entry.sessionId, activeRead);
        try {
          return await recoverExisting(context, entry, intent, payload, writer);
        } finally {
          release();
          await writer.close().catch(() => undefined);
        }
      });
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 256 * 1024,
      schema: sessionMessagePayloadV1Schema,
      schemaId: "phase21a.session-message.payload.v1",
    }),
    resultCodec: sessionMessageResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: async (target) => {
      if (
        target.kind !== "existing_resource" ||
        target.resourceScope.kind !== "session" ||
        target.expectedVersion.kind !== "session_ledger_head"
      ) {
        throw new ApplicationControlError("control_target_invalid", "session message target is invalid");
      }
      const snapshot = await input.sessionProjection.read({
        repositoryId: target.resourceScope.repositoryId,
        requestedHead: target.expectedVersion.head,
        sessionId: target.resourceScope.sessionId,
      });
      return Object.freeze({
        resourceScope: snapshot.resourceScope,
        resourceVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" as const },
        targetIdentity: Object.freeze({
          projection_identity: snapshot.projection.identity,
          session_id: target.resourceScope.sessionId,
        }),
        targetIdentitySha256: sha256Canonical({
          projection_identity: snapshot.projection.identity,
          session_id: target.resourceScope.sessionId,
        }),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["session_ledger_head"],
      resourceKinds: ["session"],
      targetKind: "existing_resource",
    }],
    zeroHeadPolicy: "create_first_event",
  };
  return Object.freeze(definition);
}
