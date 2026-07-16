import type {
  BackendIdentity,
  ModelBackend,
  ModelTurnRequest,
} from "../../model/model-backend.js";
import type { ModelCapabilities } from "../../model/model-capabilities.js";
import type { ModelEvent } from "../../model/model-events.js";
import {
  createPiContinuation,
  type PiContinuationOwner,
  unwrapPiContinuation,
} from "./pi-continuation.js";
import { mapPiError, piProtocolFailure } from "./map-pi-errors.js";
import {
  PiToolCallAggregator,
  PiToolProtocolError,
} from "./map-pi-tools.js";
import { mapPiUsage, PiUsageProtocolError } from "./map-pi-usage.js";
import type {
  PiRuntimeError,
  PiRuntimePort,
  PiRuntimeRequest,
  PiRuntimeUsage,
} from "./pi-runtime-port.js";

export interface PiModelBackendOptions {
  readonly capabilities: ModelCapabilities;
  readonly identity: BackendIdentity;
  readonly runtime: PiRuntimePort;
}

function runtimeError(error: unknown): PiRuntimeError {
  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly code?: unknown;
      readonly requestId?: unknown;
      readonly status?: unknown;
    };
    return {
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      message: error.message,
      ...(typeof candidate.requestId === "string"
        ? { providerRequestId: candidate.requestId }
        : {}),
      ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
    };
  }
  return { message: "unknown pi runtime failure" };
}

function cancelledFailure(): ModelEvent {
  return {
    error: mapPiError(
      { message: "request aborted" },
      { aborted: true },
    ),
    type: "failed",
  };
}

function protocolFailure(code: string): ModelEvent {
  return { error: piProtocolFailure(code), type: "failed" };
}

function assertIdentity(identity: BackendIdentity): void {
  if (
    !["openai", "anthropic", "ollama"].includes(identity.provider) ||
    identity.model.trim().length === 0 ||
    identity.adapter.trim().length === 0 ||
    identity.adapterVersion.trim().length === 0 ||
    !/^[a-f0-9]{64}$/u.test(identity.configFingerprint)
  ) {
    throw new TypeError("invalid backend identity");
  }
}

export class PiModelBackend implements ModelBackend {
  readonly capabilities: ModelCapabilities;
  readonly identity: BackendIdentity;
  readonly resume = Object.freeze({
    capability: "canonical_only",
    supportsCanonicalDegradedResume: true,
  } as const);
  readonly #owner: PiContinuationOwner = Object.freeze({});
  readonly #runtime: PiRuntimePort;

  constructor(options: PiModelBackendOptions) {
    assertIdentity(options.identity);
    this.identity = Object.freeze({ ...options.identity });
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.#runtime = options.runtime;
  }

  async *runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) {
      yield cancelledFailure();
      return;
    }

    let runtimeRequest: PiRuntimeRequest;
    try {
      runtimeRequest = {
        identity: this.identity,
        input: request.input.kind === "user_prompt"
          ? request.input
          : request.input.kind === "resume_prompt"
            ? {
                continuation: unwrapPiContinuation(
                  request.input.continuation,
                  this.#owner,
                ),
                kind: "resume_prompt" as const,
                text: request.input.text,
              }
            : {
                callId: request.input.callId,
                continuation: unwrapPiContinuation(
                  request.input.continuation,
                  this.#owner,
                ),
                kind: "tool_result",
                output: request.input.output,
              },
        instructions: request.instructions,
        timeoutMs: request.timeoutMs,
        tools: request.tools,
      };
    } catch {
      yield protocolFailure("invalid_backend_continuation");
      return;
    }

    const tools = new PiToolCallAggregator();
    const usageSnapshots: PiRuntimeUsage[] = [];
    let started = false;

    try {
      // PHASE8: raw pi event shapes stop at this adapter boundary. AgentLoop and
      // sessions receive only BornAgent ModelEvent values, never pi messages,
      // SDK errors, thinking blocks, or provider response objects.
      for await (const event of this.#runtime.runTurn(runtimeRequest, signal)) {
        if (signal.aborted) {
          yield cancelledFailure();
          return;
        }
        switch (event.type) {
          case "start":
            if (started) {
              yield protocolFailure("duplicate_stream_start");
              return;
            }
            started = true;
            break;
          case "text_start":
          case "text_end":
            if (!started) {
              yield protocolFailure("content_before_stream_start");
              return;
            }
            break;
          case "text_delta":
            if (!started || typeof event.delta !== "string") {
              yield protocolFailure("invalid_text_delta");
              return;
            }
            if (event.delta.length > 0) {
              yield { text: event.delta, type: "text_delta" };
            }
            break;
          case "thinking_start":
          case "thinking_delta":
          case "thinking_end":
            if (!started) {
              yield protocolFailure("thinking_before_stream_start");
              return;
            }
            // PHASE8: reasoning content is deliberately not translated into
            // visible text. Any signature needed for the next turn survives
            // only inside the opaque continuation supplied by the runtime.
            break;
          case "toolcall_start":
            if (!started) {
              yield protocolFailure("tool_call_before_stream_start");
              return;
            }
            tools.start(event.contentIndex, event.callId, event.name);
            break;
          case "toolcall_delta":
            if (!started) {
              yield protocolFailure("tool_call_before_stream_start");
              return;
            }
            for (const delta of tools.delta(
              event.contentIndex,
              event.argumentsDelta,
              event.callId,
              event.name,
            )) {
              yield delta;
            }
            break;
          case "toolcall_end":
            if (!started) {
              yield protocolFailure("tool_call_before_stream_start");
              return;
            }
            for (const delta of tools.end(
              event.contentIndex,
              event.callId,
              event.name,
              event.arguments,
            )) {
              yield delta;
            }
            break;
          case "usage_snapshot":
            if (!started) {
              yield protocolFailure("usage_before_stream_start");
              return;
            }
            usageSnapshots.push({ ...event.usage });
            break;
          case "done": {
            if (!started || event.continuation === null || event.continuation === undefined) {
              yield protocolFailure("invalid_stream_terminal");
              return;
            }
            if (tools.hasOpenCalls) {
              yield protocolFailure("unfinished_tool_call");
              return;
            }
            if (event.reason === "length") {
              yield protocolFailure("provider_output_truncated");
              return;
            }
            const hasCalls = tools.completedCount > 0;
            if (
              (hasCalls && event.reason !== "toolUse") ||
              (!hasCalls && event.reason !== "stop")
            ) {
              yield protocolFailure("protocol_capability_mismatch");
              return;
            }
            const usage = mapPiUsage(
              this.capabilities.usage,
              usageSnapshots,
              event.usage,
            );
            if (usage !== undefined) yield { type: "usage", usage };
            const providerRequestId =
              event.providerRequestId !== undefined &&
              /^[A-Za-z0-9._:-]{1,200}$/u.test(event.providerRequestId)
                ? event.providerRequestId
                : undefined;
            yield {
              continuation: createPiContinuation(
                this.#owner,
                event.continuation,
              ),
              outcome: hasCalls ? "tool_calls" : "text",
              ...(providerRequestId === undefined ? {} : { providerRequestId }),
              type: "turn_completed",
            };
            return;
          }
          case "error":
            yield {
              error: mapPiError(event.error, {
                aborted: event.reason === "aborted" || signal.aborted,
              }),
              type: "failed",
            };
            return;
          default: {
            const unknownEvent: never = event;
            void unknownEvent;
            yield protocolFailure("unknown_pi_event");
            return;
          }
        }
      }
      yield protocolFailure("stream_missing_terminal");
    } catch (error) {
      if (error instanceof PiToolProtocolError || error instanceof PiUsageProtocolError) {
        yield protocolFailure(error.code);
        return;
      }
      yield {
        error: mapPiError(runtimeError(error), { aborted: signal.aborted }),
        type: "failed",
      };
    }
  }
}
