import { randomUUID } from "node:crypto";

import { DefaultApplicationQueryService } from "./application-query-service.js";
import { DefaultAgentRunApplicationService } from "./application-service.js";
import type { AuthenticatedCallContextV1 } from "./application-protocol.js";
import { ControlArtifactStore } from "./control-artifact-store.js";
import { ControlOperationJournal } from "./control-operation-journal.js";
import { loadOrCreateHostControlAuthority, type HostControlAuthorityV1 } from "./host-control-identity.js";
import { LocalOwnerPrincipalAuthority } from "./local-owner-principal.js";
import { PaginationCursorStore } from "./pagination-cursor-store.js";
import { PreparedActionStore } from "./prepared-action-store.js";
import { RepositoryRegistry } from "./repository-registry.js";
import { SessionLedgerHeadSigner } from "./session-ledger-head.js";
import { SessionOwnerBroker } from "./session-owner-broker.js";
import { SessionProjectionService } from "./session-projection-service.js";
import { SessionRegistry } from "./session-registry.js";
import { SessionDeliveryCoordinator } from "./delivery-cursor.js";
import { createCatalogActionRegistry } from "./use-cases/catalog-actions.js";
import { createCatalogQueryRegistry } from "./use-cases/catalog-queries.js";
import {
  createSessionMessageAction,
  type ChatExecutionPortV1,
  type SessionMessageLaunchPortV1,
} from "./use-cases/session-message-action.js";
import { createTaskActionDefinitions } from "./use-cases/task-actions.js";
import { createGraphDelegationActionDefinitions } from "./use-cases/graph-delegation-actions.js";
import { createGraphCancelAction, type GraphCancelOwnerPortV1 } from "./use-cases/graph-cancel-action.js";
import {
  createGraphCompositeActionDefinitions,
  type GraphCompositeOwnerPortV1,
} from "./use-cases/graph-composite-actions.js";
import {
  createDelegationCompositeActionDefinitions,
  type DelegationCompositeOwnerPortV1,
} from "./use-cases/delegation-composite-actions.js";
import { createRunCancelAction } from "./use-cases/run-actions.js";
import {
  createSessionResumeAction,
  type SessionResumeOwnerPortV1,
} from "./use-cases/session-resume-action.js";
import { ApplicationControlError } from "./application-errors.js";
import type { TaskSurfaceQueryOperationPortV1 } from "./use-cases/task-surface-queries.js";
import { createNodeApplicationHostRuntime } from "./application-host-runtime.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { ActiveDelegationRegistryPortV1 } from "./active-owner-router.js";

export type ActiveSessionWriterObserverFactoryV1 = (input: Readonly<{
  readonly repositoryId: string;
  readonly sessionId: string;
}>) => Promise<(writer: V2SessionWriter) => void>;

export interface Phase21ALocalControlPlane {
  readonly actions: DefaultAgentRunApplicationService;
  readonly artifacts: ControlArtifactStore;
  readonly authority: HostControlAuthorityV1;
  readonly broker: SessionOwnerBroker;
  readonly context: (surface: "cli" | "tui", clientId?: string) => AuthenticatedCallContextV1;
  readonly delivery: SessionDeliveryCoordinator;
  readonly operations: ControlOperationJournal;
  readonly queries: DefaultApplicationQueryService;
  readonly repositories: RepositoryRegistry;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: SessionRegistry;
}

export async function createPhase21ALocalControlPlane(input: {
  readonly activeDelegations?: ActiveDelegationRegistryPortV1;
  readonly broker?: SessionOwnerBroker;
  readonly chatExecution?: ChatExecutionPortV1;
  readonly delivery?: SessionDeliveryCoordinator;
  readonly delegationCompositeOwner?: DelegationCompositeOwnerPortV1;
  readonly delegationCompositeOwnerFactory?: (
    signer: SessionLedgerHeadSigner,
    activeSessionWriterObserverFactory: ActiveSessionWriterObserverFactoryV1,
  ) => DelegationCompositeOwnerPortV1;
  readonly graphCompositeOwner?: GraphCompositeOwnerPortV1;
  readonly graphCompositeOwnerFactory?: (signer: SessionLedgerHeadSigner) => GraphCompositeOwnerPortV1;
  readonly graphCancelOwnerFactory?: (signer: SessionLedgerHeadSigner) => GraphCancelOwnerPortV1;
  readonly launcher: SessionMessageLaunchPortV1;
  readonly sessionResumeOwner?: SessionResumeOwnerPortV1;
  readonly stateRoot: string;
  readonly taskSurfaceOperations?: TaskSurfaceQueryOperationPortV1;
}): Promise<Phase21ALocalControlPlane> {
  const authority = await loadOrCreateHostControlAuthority({ root: input.stateRoot });
  const surfaceContexts = new Map<"cli" | "tui", AuthenticatedCallContextV1>();
  const hostRuntime = createNodeApplicationHostRuntime();
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
  const sessions = new SessionRegistry(authority.paths, repositories);
  const broker = input.broker ?? new SessionOwnerBroker();
  const principalAuthority = new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes);
  const sessionHeadSigner = new SessionLedgerHeadSigner(authority.integrityKey);
  const sessionProjection = new SessionProjectionService({
    broker,
    disclosureProfileSha256: principalAuthority.localPolicySha256,
    repositories,
    sessions,
    signer: sessionHeadSigner,
  });
  const activeSessionWriterObserverFactory: ActiveSessionWriterObserverFactoryV1 = async ({
    repositoryId,
    sessionId,
  }) => {
    const catalog = await sessions.project(repositoryId);
    const entries = catalog.entries.filter((candidate) => candidate.sessionId === sessionId);
    if (entries.length !== 1) {
      throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
    }
    const entry = entries[0]!;
    return (writer) => {
      if (writer.readDurableTailIdentity().sessionId !== sessionId) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "active writer belongs to another session",
        );
      }
      const release = broker.register(
        sessionId,
        sessionProjection.activeReadPort({ entry, writer }),
      );
      try {
        writer.subscribeClose(release);
      } catch (error) {
        release();
        throw error;
      }
    };
  };
  const operations = new ControlOperationJournal(authority.paths);
  // PHASE21: storage head, immutable projection, per-client delivery progress,
  // and live owner observation are four different authorities. They may share
  // one response envelope, but none may be reconstructed from or substituted
  // for another; this coordinator owns delivery only and never advances the
  // session ledger or manufactures a terminal/live fact.
  const delivery = input.delivery ?? new SessionDeliveryCoordinator();
  const message = createSessionMessageAction({
    broker,
    ...(input.chatExecution === undefined ? {} : { chatExecution: input.chatExecution }),
    launcher: input.launcher,
    recurringTasks: hostRuntime,
    repositories,
    sessionProjection,
    sessions,
  });
  const domainDependencies = Object.freeze({
    broker,
    createEventId: randomUUID,
    repositories,
    sessionProjection,
    sessions,
    timestamp: () => hostRuntime.now().toISOString(),
    waitForRetry: hostRuntime.wait,
  });
  const taskActions = createTaskActionDefinitions(domainDependencies);
  const graphDelegationActions = createGraphDelegationActionDefinitions(
    domainDependencies,
    input.activeDelegations,
  );
  const graphCancel = createGraphCancelAction({
    dependencies: domainDependencies,
    owner: input.graphCancelOwnerFactory?.(sessionHeadSigner) ?? Object.freeze({
      execute: async () => {
        throw new ApplicationControlError("control_target_invalid", "Graph cancel runtime authority is unavailable");
      },
    }),
  });
  const graphCompositeActions = createGraphCompositeActionDefinitions({
    dependencies: domainDependencies,
    owner: input.graphCompositeOwnerFactory?.(sessionHeadSigner) ?? input.graphCompositeOwner ?? Object.freeze({
      preflight: async () => {
        throw new ApplicationControlError("control_target_invalid", "Graph composite runtime authority is unavailable");
      },
      execute: async () => {
        throw new ApplicationControlError("control_target_invalid", "Graph composite runtime authority is unavailable");
      },
    }),
  });
  const delegationCompositeActions = createDelegationCompositeActionDefinitions({
    dependencies: domainDependencies,
    owner: input.delegationCompositeOwnerFactory?.(
      sessionHeadSigner,
      activeSessionWriterObserverFactory,
    ) ?? input.delegationCompositeOwner ?? Object.freeze({
      execute: async () => {
        throw new ApplicationControlError("control_target_invalid", "Delegation composite runtime authority is unavailable");
      },
    }),
  });
  const runCancel = createRunCancelAction({ broker, sessionProjection, sessions });
  const sessionResume = createSessionResumeAction({
    broker,
    owner: input.sessionResumeOwner ?? Object.freeze({
      execute: async () => {
        throw new ApplicationControlError("control_target_invalid", "session resume runtime authority is unavailable");
      },
    }),
    repositories,
    recurringTasks: hostRuntime,
    sessionProjection,
    sessions,
  });
  return Object.freeze({
    actions: new DefaultAgentRunApplicationService({
      actions: createCatalogActionRegistry({
        additionalDefinitions: [message, sessionResume, runCancel, ...taskActions, ...graphDelegationActions, graphCancel, ...graphCompositeActions, ...delegationCompositeActions],
        repositories,
        sessions,
      }),
      artifacts,
      createRequestId: randomUUID,
      delivery,
      hostRuntime,
      journal: operations,
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority,
    }),
    artifacts,
    authority,
    broker,
    context: (surface: "cli" | "tui", clientId?: string) => {
      const existing = clientId === undefined ? surfaceContexts.get(surface) : undefined;
      if (existing !== undefined) return existing;
      const created = Object.freeze({
        principal: authority.localOwner,
        surface: Object.freeze({ clientId: clientId ?? randomUUID(), connectionId: randomUUID(), surface }),
      });
      if (clientId === undefined) surfaceContexts.set(surface, created);
      return created;
    },
    delivery,
    operations,
    queries: new DefaultApplicationQueryService({
      createRequestId: randomUUID,
      cursors: new PaginationCursorStore(authority.integrityKey, authority.paths),
      delivery,
      hostRuntime,
      principalAuthority,
      queries: createCatalogQueryRegistry({
        artifacts,
        controllerId: authority.identity.controllerId,
        disclosureProfileSha256: principalAuthority.localPolicySha256,
        operations,
        repositories,
        sessionProjection,
        sessions,
        ...(input.taskSurfaceOperations === undefined ? {} : { taskSurfaceOperations: input.taskSurfaceOperations }),
      }),
    }),
    repositories,
    sessionProjection,
    sessions,
  });
}
