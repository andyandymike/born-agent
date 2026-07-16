import { createHash } from "node:crypto";

import type { ModelCapabilities } from "./model-capabilities.js";
import type {
  ModelBackend,
  ProviderId,
} from "./model-backend.js";
import {
  createPhase8ModelCatalog,
  isKnownProviderId,
  PI_AI_PACKAGE_VERSION,
  type ModelCatalogEntry,
  type PiModelCatalog,
} from "../providers/pi/pi-model-catalog.js";
import { PiModelBackend } from "../providers/pi/pi-model-backend.js";
import type { PiRuntimePort } from "../providers/pi/pi-runtime-port.js";
import { ProductionPiRuntimePort } from "../providers/pi/production-pi-runtime-port.js";
import {
  ProviderNetworkGuard,
  type ProviderTransportScope,
} from "../providers/pi/provider-network-guard.js";
import {
  CredentialResolver,
  type CredentialHandle,
} from "../security/credential-resolver.js";

export interface AgentCapabilityRequirement {
  readonly cancellation: boolean;
  readonly completeUsageForReportedTokenCeiling: boolean;
  readonly streaming: true;
  readonly tools: boolean;
}

export type BackendPreflightErrorCode =
  | "configuration_capability_unsupported"
  | "configuration_credential_missing"
  | "configuration_model_unknown"
  | "configuration_provider_unknown";

export class BackendPreflightError extends Error {
  readonly exitCode = 2;

  constructor(
    readonly code: BackendPreflightErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BackendPreflightError";
  }
}

export interface BackendCreationRequest {
  readonly endpoint?: string;
  readonly model: string;
  readonly provider: string;
  readonly requirement: AgentCapabilityRequirement;
  readonly transportScope?: ProviderTransportScope;
}

export interface PiRuntimeFactoryInput {
  readonly credential: CredentialHandle | null;
  readonly endpoint: string | undefined;
  readonly model: ModelCatalogEntry;
  readonly transportScope: ProviderTransportScope;
}

export type PiRuntimeFactory = (
  input: PiRuntimeFactoryInput,
) => PiRuntimePort;

export interface BackendFactoryOptions {
  readonly catalog?: PiModelCatalog;
  readonly credentialResolver: CredentialResolver;
  readonly networkGuard?: ProviderNetworkGuard;
  readonly runtimeFactory: PiRuntimeFactory;
}

const DEFAULT_PROVIDER_ENDPOINTS = {
  anthropic: "https://api.anthropic.com",
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com/v1",
} as const satisfies Record<ProviderId, string>;

function capabilityFailures(
  capabilities: ModelCapabilities,
  requirement: AgentCapabilityRequirement,
): readonly string[] {
  const missing: string[] = [];
  if (!capabilities.streaming) missing.push("streaming");
  if (requirement.tools && capabilities.tools === "none") {
    missing.push("tools");
  }
  if (
    requirement.completeUsageForReportedTokenCeiling &&
    capabilities.usage !== "complete"
  ) {
    missing.push("reported_token_ceiling_unsupported");
  }
  if (
    requirement.cancellation &&
    capabilities.cancellation !== "abort_signal"
  ) {
    missing.push("cancellation");
  }
  return missing;
}

function configurationFingerprint(input: {
  readonly model: ModelCatalogEntry;
  readonly transportScope: ProviderTransportScope;
}): string {
  // Only non-secret, frozen selection data contributes. Endpoint and key are
  // deliberately excluded because identity is persisted in run events.
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter: "pi-ai",
        adapterVersion: PI_AI_PACKAGE_VERSION,
        model: input.model.modelId,
        provider: input.model.provider,
        transportScope: input.transportScope,
      }),
    )
    .digest("hex");
}

function unknownModelMessage(provider: ProviderId, model: string): string {
  return `${provider}/${model} is not in the versioned local capability catalog; add an audited local mapping instead of probing remote metadata`;
}

export class BackendFactory {
  readonly #catalog: PiModelCatalog;
  readonly #credentialResolver: CredentialResolver;
  readonly #networkGuard: ProviderNetworkGuard;
  readonly #runtimeFactory: PiRuntimeFactory;

  constructor(options: BackendFactoryOptions) {
    this.#catalog = options.catalog ?? createPhase8ModelCatalog();
    this.#credentialResolver = options.credentialResolver;
    this.#networkGuard = options.networkGuard ?? new ProviderNetworkGuard();
    this.#runtimeFactory = options.runtimeFactory;
  }

  create(request: BackendCreationRequest): ModelBackend {
    const provider = request.provider.trim().toLowerCase();
    if (!isKnownProviderId(provider)) {
      throw new BackendPreflightError(
        "configuration_provider_unknown",
        "provider is not in the local backend registry",
      );
    }

    const modelId = request.model.trim();
    const entry = this.#catalog.find(provider, modelId);
    if (entry === undefined) {
      throw new BackendPreflightError(
        "configuration_model_unknown",
        unknownModelMessage(provider, modelId || "empty"),
      );
    }

    // PHASE8: capability incompatibility is a local configuration error. It
    // must stop before the first provider request rather than degrading token
    // facts, cancellation, or tool semantics at runtime.
    const missing = capabilityFailures(entry.capabilities, request.requirement);
    if (missing.length > 0) {
      throw new BackendPreflightError(
        "configuration_capability_unsupported",
        `${provider}/${modelId} lacks ${missing.join(", ")}; choose a locally cataloged compatible model`,
      );
    }

    const credential = this.#credentialResolver.resolve(provider);
    // PHASE8: absent remote keys are expected in local_free_only development,
    // but still fail this selection before runtime/request creation with exit 2.
    if (credential.status === "missing") {
      throw new BackendPreflightError(
        "configuration_credential_missing",
        `${credential.variableName} is not configured for ${provider}`,
      );
    }

    const transportScope = request.transportScope ?? "provider_network";
    const endpoint = request.endpoint ?? DEFAULT_PROVIDER_ENDPOINTS[provider];
    this.#networkGuard.assertAllowed({
      endpoint,
      provider,
      transportScope,
    });

    // PHASE8: runtime construction is intentionally last. The frozen identity
    // fixes one provider/model for the run; the factory never retries another
    // catalog entry or silently falls back after an error.
    const runtime = this.#runtimeFactory({
      credential:
        credential.status === "configured" ? credential.credential : null,
      endpoint,
      model: entry,
      transportScope,
    });
    return new PiModelBackend({
      capabilities: entry.capabilities,
      ...(entry.contextCapacity === undefined
        ? {}
        : { contextCapacity: entry.contextCapacity }),
      identity: Object.freeze({
        adapter: "pi-ai",
        adapterVersion: PI_AI_PACKAGE_VERSION,
        configFingerprint: configurationFingerprint({
          model: entry,
          transportScope,
        }),
        model: entry.modelId,
        provider: entry.provider,
      }),
      runtime,
    });
  }
}

export function createProductionBackendFactory(
  environment: Readonly<Record<string, string | undefined>>,
  networkGuard = new ProviderNetworkGuard(),
): BackendFactory {
  return new BackendFactory({
    credentialResolver: new CredentialResolver(environment),
    networkGuard,
    runtimeFactory: ({ credential, endpoint, model, transportScope }) => {
      if (transportScope !== "provider_network") {
        throw new TypeError(
          "production pi runtime cannot use the in-process contract scope",
        );
      }
      return new ProductionPiRuntimePort({
        ...(endpoint === undefined ? {} : { baseUrl: endpoint }),
        ...(credential === null
          ? {}
          : { credential: credential.reveal() }),
        model: model.modelId,
        provider: model.provider,
      });
    },
  });
}
