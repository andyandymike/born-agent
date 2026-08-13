import {
  prepareStreamingChat,
  runStreamingChat,
  type PreparedStreamingChatRunV1,
  type StreamingChatRuntime,
} from "../../chat/run-streaming-chat.js";
import type { ChatCommandOptions } from "../../chat/types.js";
import type { CliIO, CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { ConsoleEventRenderer } from "../../render/console-event-renderer.js";
import {
  chatSessionMessagePayloadV1Schema,
  type ChatExecutionPortV1,
  type ChatSessionMessagePayloadV1,
  type SessionMessageApplicationCancellationV1,
} from "../use-cases/session-message-action.js";
import { ApplicationControlError } from "../application-errors.js";

function optionsFromPayload(payload: ChatSessionMessagePayloadV1): ChatCommandOptions {
  return Object.freeze({
    model: payload.model,
    ...(payload.policyConfig === undefined ? {} : { policyConfig: payload.policyConfig }),
    ...(payload.policyProfile === undefined ? {} : { policyProfile: payload.policyProfile }),
    prompt: payload.prompt,
    provider: payload.provider,
    timeoutMs: payload.timeoutMs,
    ...(payload.toolsEnabled === undefined ? {} : { toolsEnabled: payload.toolsEnabled }),
    verbose: payload.verbose,
  });
}

function runtimeAtRepository(
  runtime: CliRuntime,
  repositoryRoot: string,
  applicationCancellation: SessionMessageApplicationCancellationV1,
): StreamingChatRuntime {
  const adapted: StreamingChatRuntime = {
    clearTimer: (handle: unknown) => runtime.clearTimer(handle),
    ...(runtime.createCapabilityPlatform === undefined
      ? {}
      : { createCapabilityPlatform: (workspace: string) => runtime.createCapabilityPlatform!(workspace) }),
    createModelBackend: (request) => runtime.createModelBackend(request),
    createSessionWriter: async () => {
      throw new TypeError("Host-owned Chat execution cannot create a session writer");
    },
    createToolRegistry: (workspace, secrets) => runtime.createToolRegistry(workspace, secrets),
    cwd: repositoryRoot,
    env: runtime.env,
    now: () => runtime.now(),
    onCancel: (listener) => {
      // PHASE21: authenticated Chat cancellation is signalled only after the
      // application service has durably committed the exact run.cancel
      // request. The product surface owns SIGINT and must not bypass it here.
      const forwardApplication = () => listener();
      if (applicationCancellation.signal.aborted) {
        queueMicrotask(listener);
      } else {
        applicationCancellation.signal.addEventListener("abort", forwardApplication, { once: true });
      }
      return () => {
        applicationCancellation.signal.removeEventListener("abort", forwardApplication);
      };
    },
    platform: runtime.platform,
    randomUUID: () => runtime.randomUUID(),
    setTimer: (listener, delayMs) => runtime.setTimer(listener, delayMs),
    timestamp: () => runtime.timestamp(),
  };
  return Object.freeze(adapted);
}

class CliChatExecutionPort implements ChatExecutionPortV1 {
  private readonly payloadSha256: string;

  constructor(private readonly input: Readonly<{
    readonly io: CliIO;
    readonly payload: ChatSessionMessagePayloadV1;
    readonly prepared: PreparedStreamingChatRunV1;
    readonly renderer: ConsoleEventRenderer;
    readonly runtime: CliRuntime;
  }>) {
    this.payloadSha256 = sha256Canonical(input.payload);
  }

  async execute(input: Parameters<ChatExecutionPortV1["execute"]>[0]) {
    if (
      input.applicationCommit.actionKind !== "session.message.submit" ||
      input.applicationCommit.operationId !== input.runId ||
      input.sessionId !== input.writer.readDurableTailIdentity().sessionId ||
      sha256Canonical(input.payload) !== this.payloadSha256
    ) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "Chat execution does not match its exact prepared application binding",
      );
    }
    const runtime = runtimeAtRepository(
      this.input.runtime,
      input.repositoryRoot,
      input.applicationCancellation,
    );
    const exitCode = await runStreamingChat(
      optionsFromPayload(input.payload),
      runtime,
      this.input.renderer,
      {
        applicationCancellation: input.applicationCancellation,
        applicationCommit: input.applicationCommit,
        onRunStarted: input.onRunStarted,
        runId: input.runId,
        sessionId: input.sessionId,
        writer: input.writer,
      },
      this.input.prepared,
    );
    return Object.freeze({ exitCode });
  }
}

export type PreparedCliChatExecutionV1 =
  | Readonly<{ readonly exitCode: number; readonly ok: false }>
  | Readonly<{
      readonly execution: ChatExecutionPortV1;
      readonly ok: true;
      readonly payload: ChatSessionMessagePayloadV1;
    }>;

/**
 * Product composition boundary: preflight has no model/tool effect and runs
 * before catalog creation; the returned Host port owns the one prepared model
 * backend and can execute only the exact strict payload once committed.
 */
export async function prepareCliChatExecution(input: Readonly<{
  readonly io: CliIO;
  readonly options: ChatCommandOptions;
  readonly runtime: CliRuntime;
}>): Promise<PreparedCliChatExecutionV1> {
  const payload = Object.freeze(chatSessionMessagePayloadV1Schema.parse({
    command: "chat",
    model: input.options.model,
    policyConfig: input.options.policyConfig,
    policyProfile: input.options.policyProfile,
    prompt: input.options.prompt,
    provider: input.options.provider,
    timeoutMs: input.options.timeoutMs,
    toolsEnabled: input.options.toolsEnabled,
    verbose: input.options.verbose,
  }));
  const renderer = new ConsoleEventRenderer(input.io, payload.verbose);
  const prepared = await prepareStreamingChat(
    optionsFromPayload(payload),
    input.runtime,
    renderer,
  );
  if (!prepared.ok) return Object.freeze({ exitCode: prepared.exitCode, ok: false });
  return Object.freeze({
    execution: new CliChatExecutionPort({
      io: input.io,
      payload,
      prepared: prepared.value,
      renderer,
      runtime: input.runtime,
    }),
    ok: true,
    payload,
  });
}
