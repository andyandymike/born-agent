import { RuntimePolicyError } from "./policy-errors.js";
import type { RuntimePolicyProfileRegistry, RuntimePolicyRegistryEntry } from "./policy-profile-registry.js";
import { BUILT_IN_LOCAL_FREE_PROFILE_ID, type EvalSuiteAccess, type PolicyProvider } from "./runtime-policy-schema.js";
import { createRuntimePolicyEvidence, type RuntimePolicyEvidenceV1 } from "./policy-evidence.js";

export interface EffectiveRuntimePolicy {
  readonly entry: RuntimePolicyRegistryEntry;
  readonly evidence: RuntimePolicyEvidenceV1;
}

export interface ProviderPolicyRequest {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
}

export interface ResolvedProviderPolicyRequest {
  readonly provider: PolicyProvider;
  readonly model: string;
  readonly endpoint: string | undefined;
  readonly source: "in_process_test" | "local_ollama" | "provider_network";
}

function boundedIdentity(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)) {
    throw new RuntimePolicyError("policy_model_denied", `${label} is not an exact bounded identity`);
  }
  return normalized;
}

export function resolveEffectiveRuntimePolicy(
  registry: RuntimePolicyProfileRegistry,
  profileId: string | undefined,
): EffectiveRuntimePolicy {
  const selectedId = profileId?.trim() || BUILT_IN_LOCAL_FREE_PROFILE_ID;
  const entry = registry.get(selectedId);
  if (entry === undefined) {
    throw new RuntimePolicyError("policy_profile_unknown", `runtime policy profile ${selectedId} is not defined`);
  }
  const explicitSelection = profileId !== undefined;
  if (entry.profile.mode === "remote_explicit" && !explicitSelection) {
    throw new RuntimePolicyError("policy_profile_not_explicit", "remote policy profiles must be selected explicitly for every run");
  }
  // PHASE15: profile selection is separate from provider selection. An ambient
  // BORN_PROVIDER value can be a request, never authority to choose a profile.
  return Object.freeze({
    entry,
    evidence: createRuntimePolicyEvidence(entry, explicitSelection),
  });
}

export function resolveProviderPolicyRequest(
  policy: EffectiveRuntimePolicy,
  request: ProviderPolicyRequest,
): ResolvedProviderPolicyRequest {
  const access = policy.entry.profile.modelAccess;
  if (access.kind === "local_free") {
    const provider = (request.provider?.trim().toLowerCase() || "ollama") as PolicyProvider;
    if (!access.allowedProviders.includes(provider as "fake" | "mock" | "ollama")) {
      throw new RuntimePolicyError("policy_provider_denied", `${provider} is not allowed by ${policy.entry.profile.id}`);
    }
    const source = request.source ?? (provider === "ollama" ? "local_ollama" : "in_process_test");
    if (!access.allowedSources.includes(source as "in_process_test" | "local_ollama")) {
      throw new RuntimePolicyError("policy_provider_denied", `${source} is not allowed by ${policy.entry.profile.id}`);
    }
    const model = boundedIdentity(request.model, "model") ??
      (provider === "ollama" ? access.ollama.defaultModel : "deterministic-v1");
    if (
      provider === "ollama" &&
      source === "local_ollama" &&
      model !== access.ollama.defaultModel
    ) {
      throw new RuntimePolicyError("policy_model_denied", `${provider}/${model} is not the exact local model allowed by the profile`);
    }
    const endpoint =
      provider === "ollama"
        ? request.endpoint ?? access.ollama.endpoint
        : undefined;
    if (
      provider === "ollama" &&
      source === "local_ollama" &&
      endpoint !== access.ollama.endpoint
    ) {
      throw new RuntimePolicyError("policy_endpoint_denied", "Ollama endpoint does not exact-match the profile loopback endpoint");
    }
    return Object.freeze({ provider, model, endpoint, source });
  }

  const providerText = request.provider?.trim().toLowerCase();
  const model = boundedIdentity(request.model, "model");
  if (providerText === undefined || model === undefined) {
    throw new RuntimePolicyError("policy_provider_denied", "remote profile requires an exact provider and model request");
  }
  const rule = access.providers.find((candidate) => candidate.provider === providerText);
  if (rule === undefined) {
    throw new RuntimePolicyError("policy_provider_denied", `${providerText} is not allowed by the selected remote profile`);
  }
  if (!rule.models.includes(model)) {
    throw new RuntimePolicyError("policy_model_denied", `${providerText}/${model} is not allowed by the selected remote profile`);
  }
  const endpoint = request.endpoint ?? (rule.baseUrls.length === 1 ? rule.baseUrls[0] : undefined);
  if (endpoint === undefined || !rule.baseUrls.includes(endpoint)) {
    throw new RuntimePolicyError("policy_endpoint_denied", "remote endpoint must exact-match one configured canonical base URL");
  }
  return Object.freeze({
    endpoint,
    model,
    provider: rule.provider,
    source: "provider_network",
  });
}

export function assertEvalAccess(input: {
  readonly policy: EffectiveRuntimePolicy;
  readonly suite: EvalSuiteAccess;
  readonly attempts: number;
}): void {
  const access = input.policy.entry.profile.evalAccess;
  if (!access.allowedSuites.includes(input.suite)) {
    throw new RuntimePolicyError("policy_eval_suite_denied", `${input.suite} eval is denied by ${input.policy.entry.profile.id}`);
  }
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > access.maxAttemptsPerRun) {
    throw new RuntimePolicyError("policy_attempt_ceiling_exceeded", "eval attempt plan exceeds the selected profile ceiling");
  }
}

export function assertDockerArtifactAccess(
  policy: EffectiveRuntimePolicy,
  artifactId: string,
): void {
  const access = policy.entry.profile.dockerAcquisition;
  if (access.kind !== "local_locked" || !access.allowedArtifactIds.includes(artifactId)) {
    throw new RuntimePolicyError("policy_docker_artifact_denied", `Docker artifact ${artifactId} is denied by the selected profile`);
  }
}
