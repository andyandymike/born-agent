import type {
  BackendIdentity,
  ModelToolDefinition,
  ModelTurnInput,
} from "../../model/model-backend.js";

export type PiRuntimeUsage = {
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
};

export type PiRuntimeError = {
  readonly code?: string;
  readonly message: string;
  readonly providerRequestId?: string;
  readonly status?: number;
};

export type PiRuntimeEvent =
  | { readonly type: "start" }
  | { readonly type: "text_start" }
  | { readonly delta: string; readonly type: "text_delta" }
  | { readonly type: "text_end" }
  | { readonly type: "thinking_start" }
  | { readonly delta: string; readonly type: "thinking_delta" }
  | { readonly type: "thinking_end" }
  | {
      readonly callId?: string;
      readonly contentIndex: number;
      readonly name?: string;
      readonly type: "toolcall_start";
    }
  | {
      readonly argumentsDelta: string;
      readonly callId?: string;
      readonly contentIndex: number;
      readonly name?: string;
      readonly type: "toolcall_delta";
    }
  | {
      readonly arguments: unknown;
      readonly callId: string;
      readonly contentIndex: number;
      readonly name: string;
      readonly type: "toolcall_end";
    }
  | { readonly type: "usage_snapshot"; readonly usage: PiRuntimeUsage }
  | {
      readonly continuation: unknown;
      readonly providerRequestId?: string;
      readonly reason: "stop" | "length" | "toolUse";
      readonly type: "done";
      readonly usage?: PiRuntimeUsage;
    }
  | {
      readonly error: PiRuntimeError;
      readonly reason: "aborted" | "error";
      readonly type: "error";
    };

export type PiRuntimeRequest = {
  readonly identity: BackendIdentity;
  readonly input:
    | Extract<ModelTurnInput, { readonly kind: "user_prompt" }>
    | {
        readonly continuation: unknown;
        readonly kind: "resume_prompt";
        readonly text: string;
      }
    | {
        readonly callId: string;
        readonly continuation: unknown;
        readonly kind: "tool_result";
        readonly output: string;
      };
  readonly instructions: string;
  readonly timeoutMs: number;
  readonly tools: readonly ModelToolDefinition[];
};

export interface PiRuntimePort {
  // PHASE8: deterministic fake ports exercise the production PiModelBackend
  // mapper. Remote-provider contract tests must not replace that mapper with a
  // FakeModelBackend or create a real request/socket.
  runTurn(
    request: PiRuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<PiRuntimeEvent>;
}
