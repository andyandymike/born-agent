import type { EffectiveRuntimePolicy } from "./policy-resolver.js";
import type { RuntimePolicyRegistryEntry } from "./policy-profile-registry.js";

export function runtimePolicyDocument(policy: EffectiveRuntimePolicy): Readonly<Record<string, unknown>> {
  const evidence = policy.evidence;
  const access = policy.entry.profile.modelAccess;
  return Object.freeze({
    schemaVersion: 1,
    profile: {
      id: evidence.profileId,
      mode: evidence.profileMode,
      sha256: evidence.profileSha256,
      source: evidence.profileSource,
      explicitSelection: evidence.explicitSelection,
    },
    modelAccess: {
      credentialAccess: evidence.credentialAccess,
      defaultProvider: access.kind === "local_free" ? "ollama" : null,
      defaultModel: access.kind === "local_free" ? access.ollama.defaultModel : null,
      endpointScope: evidence.endpointScope,
      paidCapable: evidence.paidCapable,
      providerRequestCeiling: evidence.maxProviderRequestsPerRun,
      outputTokenCeiling: evidence.maxOutputTokensPerRequest,
      reportedTokenCeiling: evidence.maxReportedTotalTokensPerRun,
      proxyEnabled: false,
      redirectsEnabled: false,
      fallbackEnabled: false,
      automaticModelPullEnabled: false,
    },
    evalAccess: {
      allowedSuites: evidence.allowedEvalSuites,
      maxAttemptsPerRun: policy.entry.profile.evalAccess.maxAttemptsPerRun,
    },
    dockerAcquisition: {
      kind: evidence.dockerAcquisitionKind,
      allowedArtifactIds: evidence.dockerAllowedArtifactIds,
      lockedPublicPullEnabled: evidence.dockerLockedPullEnabled,
      lockedLocalBuildEnabled: evidence.dockerLockedBuildEnabled,
      daemonScope: evidence.dockerDaemonScope,
      registryCredentialAccess: evidence.dockerRegistryCredentialAccess,
      pushEnabled: false,
      remoteBuilderEnabled: false,
    },
  });
}

export function renderRuntimePolicy(policy: EffectiveRuntimePolicy): string {
  const document = runtimePolicyDocument(policy);
  const profile = document.profile as Record<string, unknown>;
  const model = document.modelAccess as Record<string, unknown>;
  const evaluation = document.evalAccess as Record<string, unknown>;
  const docker = document.dockerAcquisition as Record<string, unknown>;
  const allowedSuites = evaluation.allowedSuites as readonly string[];
  const artifacts = docker.allowedArtifactIds as readonly string[];
  return [
    `Policy profile:              ${String(profile.id)}`,
    `Policy mode:                 ${String(profile.mode)}`,
    `Profile source:              ${String(profile.source)}`,
    `Profile SHA-256:             ${String(profile.sha256)}`,
    `Explicit selection:          ${String(profile.explicitSelection)}`,
    `Paid capable:                ${String(model.paidCapable)}`,
    `Credential access:           ${String(model.credentialAccess)}`,
    `Default provider/model:      ${String(model.defaultProvider ?? "none")} / ${String(model.defaultModel ?? "none")}`,
    `Provider endpoint scope:     ${String(model.endpointScope)}`,
    "Proxy / redirects:           denied / denied",
    "Provider fallback / retries: denied / 0",
    "Automatic model pull:        denied",
    `Docker artifact prepare:     ${docker.kind === "local_locked" ? "locked public pull + trusted local build" : "denied"}`,
    `Docker artifacts:            ${artifacts.length === 0 ? "none" : artifacts.join(", ")}`,
    "Docker daemon / builder:     local only / local only",
    "Docker registry auth / push: denied / denied",
    `Eval suites:                 ${allowedSuites.join(", ")}`,
    `Full eval:                   ${allowedSuites.includes("full") ? "allowed by explicit profile (checked-in gate still not executed)" : "denied by effective policy"}`,
    `Billable request ceiling:    ${String(model.providerRequestCeiling ?? 0)}`,
  ].join("\n") + "\n";
}

export function registryValidationDocument(entries: readonly RuntimePolicyRegistryEntry[]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    valid: true,
    profiles: entries.map((entry) => ({
      id: entry.profile.id,
      mode: entry.profile.mode,
      sha256: entry.profileSha256,
      source: entry.source,
    })),
  });
}
