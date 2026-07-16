import type { ModelCapabilities } from "../../model/model-capabilities.js";
import type { ProviderId } from "../../model/model-backend.js";
import type { ContextCapacity } from "../../model/model-context-capacity.js";

export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
export const PI_AI_PACKAGE_VERSION = "0.80.7";
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

export type ModelEvidenceStatus =
  | "contract_verified"
  | "local_live_verified"
  | "not_run_by_local_capability"
  | "not_run_by_policy";

export interface ModelCatalogEntry {
  readonly capabilities: ModelCapabilities;
  readonly credentialVariable: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | null;
  readonly contextCapacity?: ContextCapacity;
  readonly displayName: string;
  readonly evidenceStatus: ModelEvidenceStatus;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly sourcePackage: typeof PI_AI_PACKAGE_NAME;
  readonly sourcePackageVersion: typeof PI_AI_PACKAGE_VERSION;
}

export const KNOWN_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "ollama",
] as const satisfies readonly ProviderId[];

export function isKnownProviderId(value: string): value is ProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value);
}

const COMPLETE_STRICT_CAPABILITIES = {
  cancellation: "abort_signal",
  reasoning: "opaque_passthrough",
  streaming: true,
  tools: "strict",
  usage: "complete",
} as const satisfies ModelCapabilities;

const CATALOG = [
  {
    // PHASE8: pi-ai 0.80.7's simple OpenAI mapping does not forward the
    // domain strict flag, so generation is honestly best-effort; ToolRegistry
    // remains the authoritative local schema validator.
    capabilities: {
      ...COMPLETE_STRICT_CAPABILITIES,
      tools: "best_effort",
    },
    credentialVariable: "OPENAI_API_KEY",
    contextCapacity: {
      contextWindowTokens: 272_000,
      maximumOutputTokens: 128_000,
      source: "pinned_catalog",
    },
    displayName: "GPT-5.6 Terra",
    evidenceStatus: "contract_verified",
    modelId: "gpt-5.6-terra",
    provider: "openai",
    sourcePackage: PI_AI_PACKAGE_NAME,
    sourcePackageVersion: PI_AI_PACKAGE_VERSION,
  },
  {
    capabilities: {
      ...COMPLETE_STRICT_CAPABILITIES,
      tools: "best_effort",
    },
    credentialVariable: "ANTHROPIC_API_KEY",
    contextCapacity: {
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 128_000,
      source: "pinned_catalog",
    },
    displayName: "Claude Sonnet 5",
    evidenceStatus: "contract_verified",
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    sourcePackage: PI_AI_PACKAGE_NAME,
    sourcePackageVersion: PI_AI_PACKAGE_VERSION,
  },
  {
    capabilities: {
      ...COMPLETE_STRICT_CAPABILITIES,
      reasoning: "none",
      tools: "best_effort",
    },
    credentialVariable: null,
    contextCapacity: {
      contextWindowTokens: 32_768,
      maximumOutputTokens: 8_192,
      source: "pinned_catalog",
    },
    displayName: "Qwen3 1.7B (local Ollama fixture)",
    // PHASE8: contract evidence is versioned separately from live evidence;
    // merely finding a local tag must never be presented as a live pass.
    evidenceStatus: "not_run_by_policy",
    modelId: "qwen3:1.7b",
    provider: "ollama",
    sourcePackage: PI_AI_PACKAGE_NAME,
    sourcePackageVersion: PI_AI_PACKAGE_VERSION,
  },
] as const satisfies readonly ModelCatalogEntry[];

export class PiModelCatalog {
  readonly entries: readonly ModelCatalogEntry[];

  constructor(entries: readonly ModelCatalogEntry[] = CATALOG) {
    this.entries = [...entries];
  }

  find(provider: ProviderId, modelId: string): ModelCatalogEntry | undefined {
    return this.entries.find(
      (entry) => entry.provider === provider && entry.modelId === modelId,
    );
  }

  list(provider?: ProviderId): readonly ModelCatalogEntry[] {
    return provider === undefined
      ? [...this.entries]
      : this.entries.filter((entry) => entry.provider === provider);
  }
}

export function createPhase8ModelCatalog(): PiModelCatalog {
  // PHASE8: this allowlist is an audited capability map, not a remote model
  // discovery call. Unknown models fail locally instead of probing metadata.
  return new PiModelCatalog();
}
