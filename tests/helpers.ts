import { resolve } from "node:path";

import type { CliIO, CliRuntime } from "../src/cli/types.js";
import { createDomainHarness } from "../src/coordination/domain-harness.js";
import { BackendPreflightError } from "../src/model/backend-factory.js";
import type { ProviderId } from "../src/model/model-backend.js";
import type { RunEvent } from "../src/events/run-event.js";
import type { ExecutableResult } from "../src/doctor/types.js";
import type { SessionWriter } from "../src/sessions/jsonl-session-writer.js";
import type { Phase10ArtifactEvent } from "../src/artifacts/artifact-types.js";
import type {
  Phase9RunEventData,
  Phase9RunEventType,
} from "../src/events/stored-event-v2.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "./fakes/fake-chat-client.js";
import type {
  ToolExecution,
  ToolInvocation,
  ToolRegistryLike,
} from "../src/tools/tool-types.js";

export class FakeToolRegistry implements ToolRegistryLike {
  readonly calls: ToolInvocation[] = [];
  readonly modelDefinitions = [
    {
      description: "fake read",
      name: "read_file",
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      },
      strict: true as const,
    },
  ];

  constructor(
    private readonly result: ToolExecution = {
      ok: true,
      output: JSON.stringify({ ok: true, value: "fake tool result" }),
      truncated: false,
    },
  ) {}

  async execute(invocation: ToolInvocation): Promise<ToolExecution> {
    this.calls.push(invocation);
    return this.result;
  }
}

export class InMemorySessionWriter implements SessionWriter {
  readonly events: RunEvent[] = [];
  readonly persistedTypes: string[] = [];
  readonly runEventsV2: Array<{
    readonly data: unknown;
    readonly eventId: string;
    readonly runId: string;
    readonly type: string;
  }> = [];
  closed = false;
  private v2Counter = 0;

  constructor(
    readonly path = "memory://session.jsonl",
    private readonly onWrite?: (event: RunEvent) => Promise<void> | void,
  ) {}

  async write(event: RunEvent): Promise<void> {
    await this.onWrite?.(event);
    this.events.push(event);
    this.persistedTypes.push(event.type);
  }

  async appendRunEvent<TType extends Phase9RunEventType>(
    runId: string,
    type: TType,
    data: Phase9RunEventData<TType>,
  ): Promise<void> {
    this.v2Counter += 1;
    await this.appendRunEventWithId(
      runId,
      `90000000-0000-4000-8000-${String(this.v2Counter).padStart(12, "0")}`,
      type,
      data,
    );
  }

  async appendRunEventWithId<TType extends Phase9RunEventType>(
    runId: string,
    eventId: string,
    type: TType,
    data: Phase9RunEventData<TType>,
  ): Promise<void> {
    this.runEventsV2.push({ data, eventId, runId, type });
    this.persistedTypes.push(type);
  }

  async appendCapabilitySnapshotArtifact(
    runId: string,
    event: Phase10ArtifactEvent,
  ): Promise<void> {
    this.v2Counter += 1;
    this.runEventsV2.push({
      data: event.data,
      eventId: `90000000-0000-4000-8000-${String(this.v2Counter).padStart(12, "0")}`,
      runId,
      type: event.type,
    });
    this.persistedTypes.push(event.type);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function createMemoryIO(): {
  io: CliIO;
  readStderr(): string;
  readStdout(): string;
} {
  let stderr = "";
  let stdout = "";

  return {
    io: {
      stderr: { write: (value) => void (stderr += value) },
      stdout: { write: (value) => void (stdout += value) },
    },
    readStderr: () => stderr,
    readStdout: () => stdout,
  };
}

export function createRuntime(
  overrides: Partial<CliRuntime> = {},
): CliRuntime {
  let uuidCounter = 0;
  const randomUUID = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };

  const environment = overrides.env ?? { OPENAI_API_KEY: "test-api-key" };
  const createModelBackend =
    overrides.createModelBackend ??
    ((request) => {
      if (
        (request.provider === "openai" && !environment.OPENAI_API_KEY) ||
        (request.provider === "anthropic" && !environment.ANTHROPIC_API_KEY) ||
        (request.provider === "deepseek" && !environment.DEEPSEEK_API_KEY)
      ) {
        throw new BackendPreflightError(
          "configuration_credential_missing",
          `${request.provider.toUpperCase()}_API_KEY is not configured`,
        );
      }
      return new FakeStreamingChatClient(fixedStream(), {
        model: request.model,
        provider: request.provider as ProviderId,
      });
    });

  const runtime: CliRuntime = {
    agentModelEvidence: () => ({
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    }),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: () => ({
      request: async () => "denied" as const,
    }),
    createAgentToolRegistry: async () => new FakeToolRegistry(),
    createSessionWriter: async (_workspace, sessionId) =>
      new InMemorySessionWriter(`memory://${sessionId}.jsonl`),
    createToolRegistry: async () => new FakeToolRegistry(),
    cwd: resolve("fixture-workspace"),
    env: environment,
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    isReadableDirectory: async () => true,
    nodeVersion: "22.19.0",
    now: Date.now,
    onCancel: () => () => undefined,
    platform: "win32",
    randomUUID,
    refreshLocalModelCatalog: async () => [],
    runExecutable: async (command): Promise<ExecutableResult> => ({
      kind: "completed",
      exitCode: 0,
      stderr: "",
      stdout:
        command === "git"
          ? "git version 2.30.0.windows.2\n"
          : command === "ollama"
            ? "NAME        ID      SIZE\nqwen3:1.7b  abc123  1.4 GB\n"
            : "ripgrep 15.1.0\n",
    }),
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => "2026-07-16T00:00:00.000Z",
    version: "0.0.0",
    ...overrides,
    createModelBackend: (request) => {
      const backend = createModelBackend(request);
      if (backend instanceof FakeStreamingChatClient) {
        backend.selectIdentity(
          request.provider as ProviderId,
          request.model,
        );
      }
      return backend;
    },
  };
  return runtime.controlPlaneStateRoot === undefined && runtime.domainHarness === undefined
    ? { ...runtime, domainHarness: createDomainHarness() }
    : runtime;
}

/**
 * Pre-Phase21 core fixtures may intentionally exercise executeAgent with an
 * in-memory writer. Keep that test-only embedding outside the Host application
 * adapter; production Node runtimes and Phase21 integration fixtures retain it.
 */
export function withoutApplicationControlPlane(runtime: CliRuntime): CliRuntime {
  const { controlPlaneStateRoot: omitted, domainHarness: prior, ...legacy } = runtime;
  void omitted;
  void prior;
  return { ...legacy, domainHarness: createDomainHarness() };
}
