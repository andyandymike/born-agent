import type { ModelCapabilities } from "./model-capabilities.js";
import type { ModelEvent } from "./model-events.js";

export type ProviderId = "openai" | "anthropic" | "ollama";

export interface BackendIdentity {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly configFingerprint: string;
  readonly model: string;
  readonly provider: ProviderId;
}

export abstract class BackendContinuation {
  declare private readonly backendContinuationBrand: "BackendContinuation";

  // PHASE8: continuation can contain provider reasoning signatures. Throwing on
  // JSON serialization keeps core/session code from accidentally inspecting or
  // persisting data that is only valid as opaque same-backend passthrough.
  toJSON(): never {
    throw new TypeError("backend continuation is opaque and cannot be serialized");
  }
}

export interface ModelToolDefinition {
  readonly description: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export type ModelTurnInput =
  | { readonly kind: "user_prompt"; readonly text: string }
  | {
      readonly callId: string;
      readonly continuation: BackendContinuation;
      readonly kind: "tool_result";
      readonly output: string;
    };

export interface ModelTurnRequest {
  readonly input: ModelTurnInput;
  readonly instructions: string;
  readonly timeoutMs: number;
  readonly tools: readonly ModelToolDefinition[];
}

export interface ModelBackend {
  readonly capabilities: ModelCapabilities;
  readonly identity: BackendIdentity;
  runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}

