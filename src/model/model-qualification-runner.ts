import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { parseStrictJson } from "../system/strict-json.js";
import { canonicalJson } from "../completion/canonical-json.js";
import {
  assertModeDeclared,
  adapterCapabilityDeclarationSchema,
  type AdapterCapabilityDeclaration,
} from "./model-capability-declaration.js";
import type {
  BackendContinuation,
  ModelBackend,
  ModelTurnInput,
  ModelToolDefinition,
} from "./model-backend.js";
import type { ModelEvent, ModelUsage } from "./model-events.js";
import {
  modelQualificationIdentitySchema,
  modelQualificationIdentitySha256,
  type ModelQualificationIdentity,
} from "./model-qualification-identity.js";
import {
  createModelQualificationRecord,
  type ModelQualificationRecordV1,
  type ProbeResult,
} from "./model-qualification-schema.js";
import {
  CANCELLATION_PROBE_PROMPT,
  MODEL_QUALIFICATION_INSTRUCTIONS,
  MODEL_QUALIFICATION_LIMITS,
  QUALIFICATION_ACKNOWLEDGEMENT,
  QUALIFICATION_NAVIGATION_TOOL,
  QUALIFICATION_SEQUENCE_COMPLETE,
  QUALIFICATION_STEP_TOOL,
  sequentialProbePrompt,
  strictProbePrompt,
} from "./model-qualification-suite.js";

export interface ModelQualificationRunnerRuntime {
  readonly clearTimer: (handle: unknown) => void;
  readonly now: () => number;
  readonly randomNonce: () => string;
  readonly setTimer: (listener: () => void, delayMs: number) => unknown;
  readonly timestamp: () => string;
}

export interface ModelQualificationRunResult {
  readonly record: ModelQualificationRecordV1;
  readonly requestCount: number;
}

interface CapturedToolCall {
  argumentsJson: string;
  readonly callId: string;
  readonly name: string;
}

interface TurnCapture {
  readonly calls: readonly CapturedToolCall[];
  readonly deltaCount: number;
  readonly durationMs: number;
  readonly failureCategory: string | null;
  readonly lateEventCount: number;
  readonly status: "completed" | "failed" | "timeout";
  readonly terminal: BackendContinuation | null;
  readonly terminalOutcome: "text" | "tool_calls" | null;
  readonly text: string;
  readonly usage: readonly ModelUsage[];
}

class TurnLimitError extends Error {
  constructor(readonly code: "request_limit" | "text_limit" | "tool_limit") {
    super(code);
  }
}

function defaultRuntime(): ModelQualificationRunnerRuntime {
  return {
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
    randomNonce: () => randomBytes(24).toString("hex"),
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => new Date().toISOString(),
  };
}

function boundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.trunc(endedAt - startedAt));
}

function failedResult<T extends ProbeResult>(
  result: Omit<T, "code" | "status">,
  code: string,
  status: T["status"] = "failed" as T["status"],
): T {
  return { ...result, code, status } as T;
}

function exactObject(
  input: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return canonicalJson(input) === canonicalJson(expected);
}

function exactCall(
  capture: TurnCapture,
  expected: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
): { readonly callId: string; readonly matches: boolean } {
  const call = capture.calls[0];
  if (capture.calls.length !== 1 || call === undefined || call.callId.length === 0) {
    return { callId: "", matches: false };
  }
  try {
    return {
      callId: call.callId,
      matches:
        call.name === expected.name &&
        exactObject(parseStrictJson(call.argumentsJson), expected.arguments),
    };
  } catch {
    return { callId: call.callId, matches: false };
  }
}

function usageAvailability(
  usage: readonly ModelUsage[],
): "complete" | "partial" | "unavailable" | "mixed" {
  if (usage.length === 0) return "unavailable";
  const values = new Set(usage.map((value) => value.completeness));
  if (values.size !== 1) return "mixed";
  return values.has("complete") ? "complete" : "partial";
}

export class ModelQualificationRunner {
  private requestCount = 0;
  private textCaptureBytes = 0;
  private toolCallCount = 0;

  constructor(
    private readonly runtime: ModelQualificationRunnerRuntime = defaultRuntime(),
  ) {}

  async run(input: {
    readonly backend: ModelBackend;
    readonly declaration: AdapterCapabilityDeclaration;
    readonly identity: ModelQualificationIdentity;
  }): Promise<ModelQualificationRunResult> {
    this.requestCount = 0;
    this.textCaptureBytes = 0;
    this.toolCallCount = 0;
    const startedAt = this.runtime.now();
    const declaration = adapterCapabilityDeclarationSchema.parse(input.declaration);
    const identity = modelQualificationIdentitySchema.parse(input.identity);
    assertModeDeclared(declaration, "plan");
    if (
      declaration.provider !== identity.provider ||
      declaration.adapterId !== identity.adapterId ||
      declaration.adapterVersion !== identity.adapterVersion ||
      declaration.continuationCodecVersion !== identity.continuationCodecVersion ||
      input.backend.identity.provider !== identity.provider ||
      input.backend.identity.model !== identity.model ||
      input.backend.identity.adapter !== identity.adapterId ||
      input.backend.identity.adapterVersion !== identity.adapterVersion
    ) {
      throw new TypeError("qualification backend, declaration, and identity must exact-match");
    }

    const nonce = this.runtime.randomNonce();
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(nonce)) {
      throw new TypeError("qualification nonce generator returned an invalid value");
    }

    const allUsage: ModelUsage[] = [];
    const strict = await this.captureTurn(input.backend, {
      input: { kind: "user_prompt", text: strictProbePrompt(nonce) },
      tools: [QUALIFICATION_NAVIGATION_TOOL],
    });
    allUsage.push(...strict.usage);
    const strictCall = exactCall(strict, {
      arguments: { cursor: null, kinds: null, limit: 1, path_prefix: null, query: nonce },
      name: QUALIFICATION_NAVIGATION_TOOL.name,
    });
    const strictPassed =
      strict.status === "completed" &&
      strict.terminalOutcome === "tool_calls" &&
      strictCall.matches;
    const strictResult: ProbeResult = {
      code: strictPassed ? "passed" : this.turnCode(strict, "strict_tool_invalid"),
      durationMs: strict.durationMs,
      observed: {
        argumentsStrict: strictCall.matches,
        callIdPresent: strictCall.callId.length > 0,
        toolCallCount: strict.calls.length,
      },
      probeId: "strict_tool_args_v1",
      requestCount: 1,
      status: strictPassed ? "passed" : this.turnStatus(strict),
    };

    let continuationCapture: TurnCapture | null = null;
    if (strictPassed && strict.terminal !== null) {
      continuationCapture = await this.captureTurn(input.backend, {
        input: {
          callId: strictCall.callId,
          continuation: strict.terminal,
          kind: "tool_result",
          output: JSON.stringify({ matched: true }),
        },
        tools: [QUALIFICATION_NAVIGATION_TOOL],
      });
      allUsage.push(...continuationCapture.usage);
    }
    const continuationPassed =
      continuationCapture?.status === "completed" &&
      continuationCapture.terminalOutcome === "text" &&
      continuationCapture.text === QUALIFICATION_ACKNOWLEDGEMENT;
    const continuationResult: ProbeResult = {
      code:
        continuationCapture === null
          ? "dependency_not_run"
          : continuationPassed
            ? "passed"
            : this.turnCode(continuationCapture, "continuation_ack_invalid"),
      durationMs: continuationCapture?.durationMs ?? 0,
      observed: {
        acknowledgementMatched:
          continuationCapture?.text === QUALIFICATION_ACKNOWLEDGEMENT,
        terminalText: continuationCapture?.terminalOutcome === "text",
      },
      probeId: "tool_continuation_v1",
      requestCount: continuationCapture === null ? 0 : 1,
      status:
        continuationCapture === null
          ? "not_run"
          : continuationPassed
            ? "passed"
            : this.turnStatus(continuationCapture),
    };
    const streamingPassed =
      continuationPassed && (continuationCapture?.deltaCount ?? 0) > 0;
    const streamingResult: ProbeResult = {
      code: streamingPassed ? "passed" : "streaming_terminal_invalid",
      durationMs: continuationCapture?.durationMs ?? 0,
      observed: {
        deltaCount: continuationCapture?.deltaCount ?? 0,
        terminalText: continuationCapture?.terminalOutcome === "text",
      },
      probeId: "streaming_text_v1",
      requestCount: 0,
      status:
        continuationCapture === null
          ? "not_run"
          : streamingPassed
            ? "passed"
            : this.turnStatus(continuationCapture),
    };

    const sequential = declaration.supports.sequentialToolCalls
      ? await this.runSequential(input.backend, nonce)
      : {
          result: {
            code: "adapter_sequential_tools_unsupported",
            durationMs: 0,
            observed: { ordered: false, toolCallCount: 0 },
            probeId: "sequential_tools_v1" as const,
            requestCount: 0,
            status: "not_run" as const,
          },
          usage: [],
        };
    allUsage.push(...sequential.usage);

    const cancellation = await this.runCancellation(input.backend);
    allUsage.push(...cancellation.usage);

    const availability = usageAvailability(allUsage);
    const expectedUsage = declaration.supports.usage;
    const usagePassed = availability !== "mixed" && availability === expectedUsage;
    const usageResult: ProbeResult = {
      code: usagePassed ? "passed" : "usage_declaration_mismatch",
      durationMs: 0,
      observed: {
        availability: availability === "mixed" ? "unavailable" : availability,
      },
      probeId: "usage_semantics_v1",
      requestCount: 0,
      status: usagePassed ? "passed" : "failed",
    };

    const probeResults = [
      streamingResult,
      strictResult,
      continuationResult,
      sequential.result,
      cancellation.result,
      usageResult,
    ] as const;
    const passed = new Set(
      probeResults
        .filter((result) => result.status === "passed")
        .map((result) => result.probeId),
    );
    const planQualified = [
      "streaming_text_v1",
      "strict_tool_args_v1",
      "tool_continuation_v1",
      "cancellation_v1",
    ].every((probeId) => passed.has(probeId as ProbeResult["probeId"]));
    const buildQualified = planQualified && passed.has("sequential_tools_v1");
    const record = createModelQualificationRecord({
      createdAt: this.runtime.timestamp(),
      identity,
      identitySha256: modelQualificationIdentitySha256(identity),
      probeResults: [...probeResults],
      qualifiedModes: [
        ...(planQualified ? (["plan"] as const) : []),
        ...(buildQualified ? (["build"] as const) : []),
      ],
      schemaVersion: 1,
      totalDurationMs: boundedDuration(startedAt, this.runtime.now()),
      totalRequestCount: this.requestCount,
    });
    return Object.freeze({ record, requestCount: this.requestCount });
  }

  private async runSequential(
    backend: ModelBackend,
    nonce: string,
  ): Promise<{ readonly result: ProbeResult; readonly usage: readonly ModelUsage[] }> {
    const usage: ModelUsage[] = [];
    let requestCount = 0;
    let durationMs = 0;
    const first = await this.captureTurn(backend, {
      input: { kind: "user_prompt", text: sequentialProbePrompt(nonce) },
      tools: [QUALIFICATION_STEP_TOOL],
    });
    requestCount += 1;
    durationMs += first.durationMs;
    usage.push(...first.usage);
    const firstCall = exactCall(first, {
      arguments: { index: 1, nonce },
      name: QUALIFICATION_STEP_TOOL.name,
    });
    if (
      first.status !== "completed" ||
      first.terminalOutcome !== "tool_calls" ||
      first.terminal === null ||
      !firstCall.matches
    ) {
      return {
        result: failedResult(
          {
            durationMs,
            observed: { ordered: false, toolCallCount: first.calls.length },
            probeId: "sequential_tools_v1",
            requestCount,
          },
          this.turnCode(first, "sequence_step_1_invalid"),
          this.turnStatus(first),
        ),
        usage,
      };
    }
    const second = await this.captureTurn(backend, {
      input: {
        callId: firstCall.callId,
        continuation: first.terminal,
        kind: "tool_result",
        output: JSON.stringify({ index: 1, ok: true }),
      },
      tools: [QUALIFICATION_STEP_TOOL],
    });
    requestCount += 1;
    durationMs += second.durationMs;
    usage.push(...second.usage);
    const secondCall = exactCall(second, {
      arguments: { index: 2, nonce },
      name: QUALIFICATION_STEP_TOOL.name,
    });
    if (
      second.status !== "completed" ||
      second.terminalOutcome !== "tool_calls" ||
      second.terminal === null ||
      !secondCall.matches
    ) {
      return {
        result: failedResult(
          {
            durationMs,
            observed: {
              ordered: false,
              toolCallCount: first.calls.length + second.calls.length,
            },
            probeId: "sequential_tools_v1",
            requestCount,
          },
          this.turnCode(second, "sequence_step_2_invalid"),
          this.turnStatus(second),
        ),
        usage,
      };
    }
    const terminal = await this.captureTurn(backend, {
      input: {
        callId: secondCall.callId,
        continuation: second.terminal,
        kind: "tool_result",
        output: JSON.stringify({ index: 2, ok: true }),
      },
      tools: [QUALIFICATION_STEP_TOOL],
    });
    requestCount += 1;
    durationMs += terminal.durationMs;
    usage.push(...terminal.usage);
    const passed =
      terminal.status === "completed" &&
      terminal.terminalOutcome === "text" &&
      terminal.text === QUALIFICATION_SEQUENCE_COMPLETE &&
      terminal.calls.length === 0;
    return {
      result: {
        code: passed ? "passed" : this.turnCode(terminal, "sequence_terminal_invalid"),
        durationMs,
        observed: {
          ordered: passed,
          toolCallCount:
            first.calls.length + second.calls.length + terminal.calls.length,
        },
        probeId: "sequential_tools_v1",
        requestCount,
        status: passed ? "passed" : this.turnStatus(terminal),
      },
      usage,
    };
  }

  private async runCancellation(
    backend: ModelBackend,
  ): Promise<{ readonly result: ProbeResult; readonly usage: readonly ModelUsage[] }> {
    const startedAt = this.runtime.now();
    const capture = await this.captureTurn(
      backend,
      {
        input: { kind: "user_prompt", text: CANCELLATION_PROBE_PROMPT },
        tools: [],
      },
      true,
    );
    const abortObserved =
      capture.deltaCount > 0 &&
      capture.terminal === null &&
      (capture.status === "completed" || capture.failureCategory === "cancelled");
    const passed = abortObserved && capture.lateEventCount === 0;
    return {
      result: {
        code: passed ? "passed" : this.turnCode(capture, "cancellation_not_observed"),
        durationMs: capture.durationMs,
        observed: {
          abortObserved,
          cancelLatencyMs: boundedDuration(startedAt, this.runtime.now()),
          lateEventCount: capture.lateEventCount,
        },
        probeId: "cancellation_v1",
        requestCount: 1,
        status: passed ? "passed" : this.turnStatus(capture),
      },
      usage: capture.usage,
    };
  }

  private async captureTurn(
    backend: ModelBackend,
    request: {
      readonly input: ModelTurnInput;
      readonly tools: readonly ModelToolDefinition[];
    },
    abortAfterFirstDelta = false,
  ): Promise<TurnCapture> {
    if (this.requestCount >= MODEL_QUALIFICATION_LIMITS.maxProviderRequests) {
      throw new TurnLimitError("request_limit");
    }
    this.requestCount += 1;
    const startedAt = this.runtime.now();
    const controller = new AbortController();
    const iterator = (
      backend.runTurn(
        {
          input: request.input,
          instructions: MODEL_QUALIFICATION_INSTRUCTIONS,
          timeoutMs: MODEL_QUALIFICATION_LIMITS.perRequestTimeoutMs,
          tools: request.tools,
        },
        controller.signal,
      )
    )[Symbol.asyncIterator]();
    const calls: CapturedToolCall[] = [];
    const usage: ModelUsage[] = [];
    let deltaCount = 0;
    let failureCategory: string | null = null;
    let lateEventCount = 0;
    let text = "";
    let terminal: BackendContinuation | null = null;
    let terminalOutcome: "text" | "tool_calls" | null = null;
    let abortedAt: number | null = null;
    try {
      for (;;) {
        const waitMs =
          abortedAt === null
            ? MODEL_QUALIFICATION_LIMITS.perRequestTimeoutMs
            : MODEL_QUALIFICATION_LIMITS.cancellationDeadlineMs;
        const next = await this.nextWithin(iterator, waitMs);
        if (next === null) {
          controller.abort();
          void iterator.return?.();
          return {
            calls,
            deltaCount,
            durationMs: boundedDuration(startedAt, this.runtime.now()),
            failureCategory,
            lateEventCount,
            status: "timeout",
            terminal,
            terminalOutcome,
            text,
            usage,
          };
        }
        if (next.done) break;
        const event = next.value;
        if (abortedAt !== null && event.type !== "failed") lateEventCount += 1;
        switch (event.type) {
          case "text_delta":
            deltaCount += 1;
            this.textCaptureBytes += Buffer.byteLength(event.text, "utf8");
            if (this.textCaptureBytes > MODEL_QUALIFICATION_LIMITS.maxTextCaptureBytes) {
              throw new TurnLimitError("text_limit");
            }
            text += event.text;
            if (abortAfterFirstDelta && abortedAt === null) {
              abortedAt = this.runtime.now();
              controller.abort();
            }
            break;
          case "tool_call_delta": {
            let call = calls.find((candidate) => candidate.callId === event.callId);
            if (call === undefined) {
              call = {
                argumentsJson: "",
                callId: event.callId,
                name: event.name,
              };
              calls.push(call);
              this.toolCallCount += 1;
              if (this.toolCallCount > MODEL_QUALIFICATION_LIMITS.maxToolCalls) {
                throw new TurnLimitError("tool_limit");
              }
            }
            if (call.name !== event.name) throw new TurnLimitError("tool_limit");
            call.argumentsJson += event.argumentsDelta;
            if (Buffer.byteLength(call.argumentsJson, "utf8") > 8 * 1_024) {
              throw new TurnLimitError("tool_limit");
            }
            break;
          }
          case "usage":
            usage.push(event.usage);
            break;
          case "turn_completed":
            terminal = event.continuation;
            terminalOutcome = event.outcome;
            break;
          case "failed":
            failureCategory = event.error.category;
            break;
          default: {
            const exhaustive: never = event;
            void exhaustive;
          }
        }
      }
      return {
        calls,
        deltaCount,
        durationMs: boundedDuration(startedAt, this.runtime.now()),
        failureCategory,
        lateEventCount,
        status: failureCategory === null ? "completed" : "failed",
        terminal,
        terminalOutcome,
        text,
        usage,
      };
    } catch (error) {
      controller.abort();
      void iterator.return?.();
      if (error instanceof TurnLimitError) {
        return {
          calls,
          deltaCount,
          durationMs: boundedDuration(startedAt, this.runtime.now()),
          failureCategory: error.code,
          lateEventCount,
          status: "failed",
          terminal,
          terminalOutcome,
          text: "",
          usage,
        };
      }
      return {
        calls,
        deltaCount,
        durationMs: boundedDuration(startedAt, this.runtime.now()),
        failureCategory: "backend_exception",
        lateEventCount,
        status: "failed",
        terminal,
        terminalOutcome,
        text: "",
        usage,
      };
    }
  }

  private async nextWithin(
    iterator: AsyncIterator<ModelEvent>,
    timeoutMs: number,
  ): Promise<IteratorResult<ModelEvent> | null> {
    let timer: unknown;
    const timeout = new Promise<null>((resolve) => {
      timer = this.runtime.setTimer(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([iterator.next(), timeout]);
    } finally {
      this.runtime.clearTimer(timer);
    }
  }

  private turnCode(capture: TurnCapture, fallback: string): string {
    return capture.status === "timeout"
      ? "request_timeout"
      : capture.failureCategory === null
        ? fallback
        : `provider_${capture.failureCategory}`;
  }

  private turnStatus(capture: TurnCapture): ProbeResult["status"] {
    if (capture.status === "timeout") return "timeout";
    return capture.failureCategory === "cancelled" ? "cancelled" : "failed";
  }
}
