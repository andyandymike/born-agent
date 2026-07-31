import { sha256Canonical } from "../completion/canonical-json.js";
import type { OllamaLocalModelDiscovery } from "../providers/pi/ollama-local-catalog-port.js";
import {
  createPhase8ModelCatalog,
  isKnownProviderId,
  PI_AI_PACKAGE_VERSION,
} from "../providers/pi/pi-model-catalog.js";
import { resolveLoopbackOllamaURL } from "../security/loopback-ollama-url.js";
import {
  adapterCapabilityDeclarationSchema,
  type AdapterCapabilityDeclaration,
} from "./model-capability-declaration.js";
import {
  modelQualificationIdentitySchema,
  type ModelQualificationIdentity,
} from "./model-qualification-identity.js";
import {
  MODEL_QUALIFICATION_PROBE_SUITE_VERSION,
  MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256,
} from "./model-qualification-suite.js";

export interface ModelQualificationTarget {
  readonly declaration: AdapterCapabilityDeclaration;
  readonly identity: ModelQualificationIdentity;
}

export function piAdapterCapabilityDeclaration(
  provider: string,
  model: string,
): AdapterCapabilityDeclaration {
  if (!isKnownProviderId(provider)) {
    throw new TypeError("qualification provider is not in the static adapter registry");
  }
  const entry = createPhase8ModelCatalog().find(provider, model);
  if (entry === undefined) {
    throw new TypeError("qualification model is not in the static adapter registry");
  }
  return Object.freeze(
    adapterCapabilityDeclarationSchema.parse({
      adapterId: "pi-ai",
      adapterVersion: PI_AI_PACKAGE_VERSION,
      continuationCodecVersion: null,
      provider,
      schemaVersion: 1,
      supports: {
        cancellation:
          entry.capabilities.cancellation === "abort_signal"
            ? "abort_signal"
            : "none",
        sequentialToolCalls: entry.capabilities.tools !== "none",
        streamingText: entry.capabilities.streaming,
        strictTools: entry.capabilities.tools !== "none",
        toolContinuation: entry.capabilities.tools !== "none",
        usage:
          entry.capabilities.usage === "none"
            ? "unavailable"
            : entry.capabilities.usage,
      },
    }),
  );
}

function normalizeOllamaDigest(digest: string): string {
  const normalized = digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new TypeError("Ollama returned an invalid model digest");
  }
  return normalized;
}

export async function resolvePiModelQualificationTarget(input: {
  readonly endpoint: string | undefined;
  readonly model: string;
  readonly policyProfileId: string;
  readonly policyProfileSha256: string;
  readonly provider: string;
  readonly refreshLocalModelCatalog: (request: {
    readonly baseURL: string;
    readonly timeoutMs: number;
  }) => Promise<readonly OllamaLocalModelDiscovery[]>;
}): Promise<ModelQualificationTarget> {
  const declaration = piAdapterCapabilityDeclaration(input.provider, input.model);
  let endpointScope: ModelQualificationIdentity["endpointScope"];
  let modelRuntimeIdentity: ModelQualificationIdentity["modelRuntimeIdentity"];
  if (input.provider === "ollama") {
    const endpoint = resolveLoopbackOllamaURL(input.endpoint ?? "");
    if (!endpoint.ok) throw new TypeError(endpoint.error);
    const models = await input.refreshLocalModelCatalog({
      baseURL: endpoint.value,
      timeoutMs: 2_500,
    });
    const exact = models.find((candidate) => candidate.tag === input.model);
    if (exact === undefined) {
      throw new TypeError("exact local Ollama model digest is not installed");
    }
    endpointScope = { kind: "literal_loopback", origin: endpoint.value };
    modelRuntimeIdentity = {
      digest: normalizeOllamaDigest(exact.digest),
      kind: "ollama_digest",
    };
  } else {
    if (input.endpoint === undefined) {
      throw new TypeError("remote qualification requires one exact endpoint");
    }
    endpointScope = {
      kind: "remote_explicit",
      originSha256: sha256Canonical({ endpoint: input.endpoint }),
    };
    modelRuntimeIdentity = {
      kind: "provider_model_id",
      value: input.model,
    };
  }
  const identity = modelQualificationIdentitySchema.parse({
    adapterId: declaration.adapterId,
    adapterVersion: declaration.adapterVersion,
    continuationCodecVersion: declaration.continuationCodecVersion,
    endpointScope,
    model: input.model,
    modelRuntimeIdentity,
    policyProfileId: input.policyProfileId,
    policyProfileSha256: input.policyProfileSha256,
    probeSuiteVersion: MODEL_QUALIFICATION_PROBE_SUITE_VERSION,
    probeToolSchemaSha256: MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256,
    provider: input.provider,
  });
  return Object.freeze({ declaration, identity: Object.freeze(identity) });
}
