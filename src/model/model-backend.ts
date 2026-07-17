import type { ModelCapabilities } from "./model-capabilities.js";
import type { ModelEvent } from "./model-events.js";
import type { BackendResumeDeclaration } from "./backend-resume.js";
import type { ContextCapacity } from "./model-context-capacity.js";

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
  // PHASE12: MCP schemas may be valid locally without satisfying every
  // provider's strict-generation subset. This flag is a generation hint only;
  // ToolRegistry still performs local validation before every execution.
  readonly strict: boolean;
}

export type ModelTurnInput =
  | { readonly kind: "user_prompt"; readonly text: string }
  | {
      readonly continuation: BackendContinuation;
      readonly kind: "resume_prompt";
      readonly output?: never;
      readonly text: string;
    }
  | {
      readonly callId: string;
      readonly continuation: BackendContinuation;
      readonly kind: "tool_result";
      readonly output: string;
    };

export interface ModelTurnRequest {
  readonly canonicalContext?: ModelCanonicalContextPayload;
  readonly contextPlan?: ModelContextPlanReference;
  readonly input: ModelTurnInput;
  readonly instructions: string;
  readonly timeoutMs: number;
  readonly tools: readonly ModelToolDefinition[];
}

export interface ModelCanonicalContextPayload {
  readonly conversationMode: "augment" | "replace";
  readonly encoding: "bornagent.context.v1+json";
  readonly sha256: string;
  readonly text: string;
}

export interface ModelContextPlanReference {
  readonly canonicalContextSha256: string;
  readonly epoch: number;
  readonly estimatedInputTokens: number;
  readonly includedItemIds: readonly string[];
  readonly plannerVersion: string;
  readonly protectedFactIds: readonly string[];
}

export interface PreparedModelTurnRequest {
  readonly adapterEncodingVersion: string;
  readonly encodedRequestSha256?: string;
  readonly request: ModelTurnRequest;
}

export interface ModelBackend {
  readonly capabilities: ModelCapabilities;
  readonly contextCapacity?: ContextCapacity;
  readonly identity: BackendIdentity;
  readonly resume: BackendResumeDeclaration;
  prepareTurnRequest?(request: ModelTurnRequest): PreparedModelTurnRequest;
  runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
