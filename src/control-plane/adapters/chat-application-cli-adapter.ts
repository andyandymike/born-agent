import type { StreamingChatExitCode } from "../../chat/run-streaming-chat.js";
import { runStreamingChat } from "../../chat/run-streaming-chat.js";
import type { ChatCommandOptions } from "../../chat/types.js";
import type { CliIO, CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { isDomainHarnessRuntime } from "../../coordination/domain-harness.js";
import { ConsoleEventRenderer } from "../../render/console-event-renderer.js";
import {
  commitCliSessionMessageWithTypedCancellation,
  contextForRuntime,
  planeForRuntime,
  registerChatExecutionForRuntime,
  registerCurrentRepository,
  reportApplicationFailure,
  reviewPreparedBeforeCommit,
} from "./agent-cli-adapter.js";
import { prepareCliChatExecution } from "./chat-cli-port.js";

const CHAT_EXIT_CODES = new Set<number>([0, 1, 2, 3, 4, 5, 6, 8, 130]);

/**
 * Product `born chat` is a typed Host application operation. The command
 * layer supplies parsed options only; this adapter owns catalog preparation,
 * seq0 targeting, commit, and bounded result rendering.
 */
export async function executeChatThroughApplicationService(
  options: ChatCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<StreamingChatExitCode> {
  if (isDomainHarnessRuntime(runtime)) {
    return await runStreamingChat(
      options,
      runtime,
      new ConsoleEventRenderer(io, options.verbose),
    ) as StreamingChatExitCode;
  }

  const preparedExecution = await prepareCliChatExecution({ io, options, runtime });
  if (!preparedExecution.ok) return preparedExecution.exitCode as StreamingChatExitCode;

  const releaseExecution = await registerChatExecutionForRuntime({
    execution: preparedExecution.execution,
    io,
    payloadSha256: sha256Canonical(preparedExecution.payload),
    runtime,
  });
  try {
    const plane = await planeForRuntime(runtime, io);
    const context = contextForRuntime(plane, runtime, "cli");
    const repository = await registerCurrentRepository(plane, context, runtime, io);
    if (!("repositoryId" in repository)) {
      return reportApplicationFailure(repository, io) as StreamingChatExitCode;
    }

    const sessionCatalogHead = await plane.sessions.head(repository.repositoryId);
  const preparedSession = await plane.actions.prepare(context, {
    actionKind: "session.create",
    payload: {},
    payloadSha256: sha256Canonical({}),
    prepareIdempotencyKey: [
      "chat.session.create.prepare.v1",
      repository.repositoryId,
      String(sessionCatalogHead.revision),
      sessionCatalogHead.catalogSha256,
      runtime.randomUUID(),
    ].join("."),
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      catalogScope: plane.sessions.resourceScope(repository.repositoryId),
      expectedCatalogVersion: {
        kind: "revision",
        revision: sessionCatalogHead.revision,
        sha256: sessionCatalogHead.catalogSha256,
      },
      kind: "new_session",
    },
  });
  if (preparedSession.status !== "ok" || preparedSession.result === null) {
    return reportApplicationFailure(preparedSession, io) as StreamingChatExitCode;
  }
  const sessionReview = await reviewPreparedBeforeCommit(
    preparedSession,
    plane,
    runtime,
    io,
    "cli",
  );
  if (sessionReview !== null) {
    return reportApplicationFailure(sessionReview, io) as StreamingChatExitCode;
  }
  const created = await plane.actions.commit(context, {
    idempotencyKey: `chat.session.create.commit.v1.${preparedSession.result.prepared.preparedActionId}`,
    preparedActionId: preparedSession.result.prepared.preparedActionId,
    preparedActionSha256: preparedSession.result.prepared.preparedActionSha256,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
  });
  if (
    created.status !== "ok" ||
    created.resourceScope?.kind !== "session" ||
    created.ledgerHead === null
  ) {
    return reportApplicationFailure(created, io) as StreamingChatExitCode;
  }

  const payload = preparedExecution.payload;
  const preparedChat = await plane.actions.prepare(context, {
    actionKind: "session.message.submit",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: [
      "session.message.submit.chat.prepare.v1",
      repository.repositoryId,
      created.resourceScope.sessionId,
      String(created.ledgerHead.sequence),
      runtime.randomUUID(),
    ].join("."),
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head: created.ledgerHead, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: created.resourceScope,
    },
  });
  if (preparedChat.status !== "ok" || preparedChat.result === null) {
    return reportApplicationFailure(preparedChat, io) as StreamingChatExitCode;
  }
  const chatReview = await reviewPreparedBeforeCommit(
    preparedChat,
    plane,
    runtime,
    io,
    "cli",
  );
  if (chatReview !== null) {
    return reportApplicationFailure(chatReview, io) as StreamingChatExitCode;
  }
  const committed = await commitCliSessionMessageWithTypedCancellation({
    context,
    idempotencyKey: `session.message.submit.chat.commit.v1.${preparedChat.result.prepared.preparedActionId}`,
    io,
    plane,
    preparedActionId: preparedChat.result.prepared.preparedActionId,
    preparedActionSha256: preparedChat.result.prepared.preparedActionSha256,
    repositoryId: repository.repositoryId,
    requestId: runtime.randomUUID(),
    runtime,
    sessionId: created.resourceScope.sessionId,
  });
  if (committed.status !== "ok" || committed.result === null) {
    return reportApplicationFailure(committed, io) as StreamingChatExitCode;
  }
    const result = committed.result as Readonly<{ readonly exitCode?: unknown }>;
    return typeof result.exitCode === "number" && CHAT_EXIT_CODES.has(result.exitCode)
      ? result.exitCode as StreamingChatExitCode
      : 1;
  } finally {
    releaseExecution();
  }
}
