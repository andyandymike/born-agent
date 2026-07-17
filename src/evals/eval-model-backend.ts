import { sha256Canonical } from "../completion/canonical-json.js";
import type { BackendCheckpointCodec } from "../model/backend-resume.js";
import {
  BackendContinuation,
  type BackendIdentity,
  type ModelBackend,
  type ModelTurnRequest,
  type PreparedModelTurnRequest,
} from "../model/model-backend.js";
import type { ModelEvent } from "../model/model-events.js";
import type { ContextCapacity } from "../model/model-context-capacity.js";
import { PiModelBackend } from "../providers/pi/pi-model-backend.js";
import { ProductionPiRuntimePort } from "../providers/pi/production-pi-runtime-port.js";
import type { EvalTurnGuard, EvalExecutionSource } from "./eval-no-cost-policy.js";

type EvalContinuationStage =
  | "after_command"
  | "after_finish"
  | "after_mcp"
  | "after_patch";

class EvalContinuation extends BackendContinuation {
  public constructor(readonly stage: EvalContinuationStage) {
    super();
  }
}

function parseContinuationStage(bytes: Uint8Array): EvalContinuationStage {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("eval checkpoint is not valid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "stage" ||
    !("stage" in value) ||
    !["after_command", "after_finish", "after_mcp", "after_patch"].includes(
      String(value.stage),
    )
  ) {
    throw new TypeError("eval checkpoint has an invalid continuation stage");
  }
  return value.stage as EvalContinuationStage;
}

function patchFor(taskId: string, wrong: boolean): string {
  const content = wrong ? "WRONG" : `PASS:${taskId}`;
  return [
    "diff --git a/answer.txt b/answer.txt",
    "--- /dev/null",
    "+++ b/answer.txt",
    "@@ -0,0 +1 @@",
    `+${content}`,
    "",
  ].join("\n");
}

function completeUsage(): ModelEvent {
  return {
    type: "usage",
    usage: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completeness: "complete",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

function toolCall(
  name: string,
  argumentsJson: string,
  callId: string,
): ModelEvent {
  return {
    argumentsDelta: argumentsJson,
    callId,
    name,
    type: "tool_call_delta",
  };
}

function continuationFromRequest(
  request: ModelTurnRequest,
): EvalContinuation | null {
  if (request.input.kind === "user_prompt") return null;
  if (!(request.input.continuation instanceof EvalContinuation)) {
    throw new TypeError("eval backend received a foreign continuation");
  }
  return request.input.continuation;
}

export class DeterministicEvalModelBackend implements ModelBackend {
  readonly capabilities = Object.freeze({
    cancellation: "abort_signal" as const,
    reasoning: "opaque_passthrough" as const,
    streaming: true,
    tools: "strict" as const,
    usage: "complete" as const,
  });
  readonly contextCapacity;
  readonly identity: BackendIdentity;
  readonly resume;
  #turn = 0;

  public constructor(
    private readonly options: {
      readonly contextWindowTokens: number;
      readonly hasMcpService: boolean;
      readonly model: string;
      readonly taskId: string;
      readonly taskVersion: number;
    },
  ) {
    this.contextCapacity = Object.freeze({
      contextWindowTokens: Math.max(131_072, options.contextWindowTokens),
      maximumOutputTokens: 8_192,
      source: "pinned_catalog" as const,
    });
    this.identity = Object.freeze({
      adapter: "bornagent-eval-deterministic",
      adapterVersion: "phase14-v2",
      configFingerprint: sha256Canonical({
        adapter: "bornagent-eval-deterministic",
        hasMcpService: options.hasMcpService,
        model: options.model,
        taskId: options.taskId,
        taskVersion: options.taskVersion,
      }),
      model: options.model,
      // ProviderId intentionally remains `ollama`: the provider-neutral core
      // has no fake provider identity, while EvalExecutionSource remains the
      // authoritative proof that this backend is in-process and socket-free.
      provider: "ollama",
    });
    const identity = this.identity;
    const codec: BackendCheckpointCodec = Object.freeze({
      codecVersion: "phase14-eval-exact-v1",
      decode: async (bytes: Uint8Array, selectedIdentity: BackendIdentity) => {
        if (
          selectedIdentity.adapter !== identity.adapter ||
          selectedIdentity.adapterVersion !== identity.adapterVersion ||
          selectedIdentity.configFingerprint !== identity.configFingerprint ||
          selectedIdentity.model !== identity.model ||
          selectedIdentity.provider !== identity.provider
        ) {
          throw new TypeError("eval checkpoint backend identity changed");
        }
        return new EvalContinuation(parseContinuationStage(bytes));
      },
      encode: async (continuation: BackendContinuation) => {
        if (!(continuation instanceof EvalContinuation)) {
          throw new TypeError("eval backend cannot encode a foreign continuation");
        }
        return Buffer.from(JSON.stringify({ stage: continuation.stage }), "utf8");
      },
      provider: "ollama",
    });
    this.resume = Object.freeze({
      capability: "exact_checkpoint" as const,
      checkpointCodec: codec,
      supportsCanonicalDegradedResume: true,
    });
  }

  prepareTurnRequest(request: ModelTurnRequest): PreparedModelTurnRequest {
    return Object.freeze({
      adapterEncodingVersion: "phase14-eval-request-v1",
      encodedRequestSha256: sha256Canonical({
        canonicalContextSha256: request.canonicalContext?.sha256 ?? null,
        contextEpoch: request.contextPlan?.epoch ?? null,
        inputKind: request.input.kind,
        toolNames: request.tools.map(({ name }) => name),
      }),
      request,
    });
  }

  async *runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    this.#turn += 1;
    const continuation = continuationFromRequest(request);
    let nextStage: EvalContinuationStage;

    if (continuation === null) {
      if (this.options.hasMcpService) {
        const mcpTool = request.tools.find(({ name }) => name.startsWith("mcp__"));
        if (mcpTool === undefined) {
          throw new TypeError("eval MCP scenario did not expose its discovered tool");
        }
        yield toolCall(mcpTool.name, JSON.stringify({ query: "answer" }), "eval_mcp");
        nextStage = "after_mcp";
      } else {
        yield toolCall(
          "apply_patch",
          JSON.stringify({
            patch: patchFor(
              this.options.taskId,
              this.options.model === "false-complete-v1",
            ),
          }),
          "eval_patch",
        );
        nextStage = "after_patch";
      }
    } else if (continuation.stage === "after_mcp") {
      yield toolCall(
        "apply_patch",
        JSON.stringify({
          patch: patchFor(
            this.options.taskId,
            this.options.model === "false-complete-v1",
          ),
        }),
        "eval_patch",
      );
      nextStage = "after_patch";
    } else if (continuation.stage === "after_patch") {
      if (this.options.model === "solved-incomplete-v1") {
        yield { text: "The requested edit is ready.", type: "text_delta" };
        yield completeUsage();
        yield {
          continuation: new EvalContinuation("after_finish"),
          outcome: "text",
          providerRequestId: `eval_${String(this.#turn)}`,
          type: "turn_completed",
        };
        return;
      }
      yield toolCall(
        "run_command",
        JSON.stringify({
          args: ["--version"],
          cwd: ".",
          executable: "node",
          purpose: "verify",
          timeout_ms: 30_000,
        }),
        "eval_command",
      );
      nextStage = "after_command";
    } else if (continuation.stage === "after_command") {
      yield toolCall(
        "finish_task",
        JSON.stringify({
          status: "completed",
          summary: `Created and verified answer.txt for ${this.options.taskId}.`,
        }),
        "eval_finish",
      );
      nextStage = "after_finish";
    } else {
      yield { text: "Task already reached its completion boundary.", type: "text_delta" };
      yield completeUsage();
      yield {
        continuation: new EvalContinuation("after_finish"),
        outcome: "text",
        providerRequestId: `eval_${String(this.#turn)}`,
        type: "turn_completed",
      };
      return;
    }

    yield completeUsage();
    yield {
      continuation: new EvalContinuation(nextStage),
      outcome: "tool_calls",
      providerRequestId: `eval_${String(this.#turn)}`,
      type: "turn_completed",
    };
  }
}

class GuardedEvalBackend implements ModelBackend {
  readonly contextCapacity: ContextCapacity;

  public constructor(
    private readonly backend: ModelBackend,
    private readonly guard: EvalTurnGuard,
    private readonly source: EvalExecutionSource,
  ) {
    if (backend.contextCapacity === undefined) {
      throw new TypeError("eval backend must declare a context capacity");
    }
    this.contextCapacity = backend.contextCapacity;
  }

  get capabilities() {
    return this.backend.capabilities;
  }

  get identity() {
    return this.backend.identity;
  }

  get resume() {
    return this.backend.resume;
  }

  prepareTurnRequest(request: ModelTurnRequest): PreparedModelTurnRequest {
    return this.backend.prepareTurnRequest?.(request) ?? {
      adapterEncodingVersion: this.backend.identity.adapterVersion,
      request,
    };
  }

  async *runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    // PHASE14: provider labels are not a cost boundary. Revalidate the frozen
    // source immediately before every model turn, including continuation turns.
    this.guard.assertBeforeModelTurn(this.source);
    yield* this.backend.runTurn(request, signal);
  }
}

export function createEvalModelBackend(input: {
  readonly contextWindowTokens: number;
  readonly guard: EvalTurnGuard;
  readonly hasMcpService: boolean;
  readonly model: string;
  readonly source: EvalExecutionSource;
  readonly taskId: string;
  readonly taskVersion: number;
}): ModelBackend {
  const backend =
    input.source.kind === "in_process_test"
      ? new DeterministicEvalModelBackend(input)
      : new PiModelBackend({
          capabilities: {
            cancellation: "abort_signal",
            reasoning: "opaque_passthrough",
            streaming: true,
            tools: "strict",
            usage: "complete",
          },
          contextCapacity: {
            contextWindowTokens: 32_768,
            maximumOutputTokens: 8_192,
            source: "pinned_catalog",
          },
          identity: {
            adapter: "pi-ai-ollama-local-eval",
            adapterVersion: "0.80.7",
            configFingerprint: sha256Canonical({
              adapter: "pi-ai-ollama-local-eval",
              endpoint: input.source.endpoint,
              model: input.source.installedModelTag,
              modelDigest: input.source.installedModelDigest,
            }),
            model: input.source.installedModelTag,
            provider: "ollama",
          },
          runtime: new ProductionPiRuntimePort({
            baseUrl: input.source.endpoint,
            model: input.source.installedModelTag,
            provider: "ollama",
          }),
        });
  return new GuardedEvalBackend(backend, input.guard, input.source);
}
