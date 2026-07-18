import { z } from "zod";

import type { RuntimePolicyRegistryEntry } from "./policy-profile-registry.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive();

export const persistedRuntimePolicyEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    profile_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    profile_mode: z.enum(["local_free", "remote_explicit"]),
    profile_sha256: sha256,
    profile_source: z.enum([
      "built_in",
      "user_default_path",
      "explicit_user_path",
    ]),
    explicit_selection: z.boolean(),
    paid_capable: z.boolean(),
    credential_access: z.enum(["deny", "selected_provider_only"]),
    endpoint_scope: z.enum(["literal_loopback", "exact_remote_base_url"]),
    allowed_eval_suites: z
      .array(z.enum(["targeted", "smoke", "full"]))
      .min(1)
      .readonly(),
    max_provider_requests_per_run: positiveInteger.nullable(),
    max_output_tokens_per_request: positiveInteger.nullable(),
    max_reported_total_tokens_per_run: positiveInteger.nullable(),
    proxy_enabled: z.literal(false),
    redirects_enabled: z.literal(false),
    remote_fallback_enabled: z.literal(false),
    automatic_model_pull_enabled: z.literal(false),
    docker_acquisition_kind: z.enum(["deny", "local_locked"]),
    docker_allowed_artifact_ids: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u))
      .readonly(),
    docker_locked_pull_enabled: z.boolean(),
    docker_locked_build_enabled: z.boolean(),
    docker_daemon_scope: z.literal("local_only"),
    docker_registry_credential_access: z.literal("deny"),
    docker_push_enabled: z.literal(false),
    remote_builder_enabled: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const local = value.profile_mode === "local_free";
    if (
      value.paid_capable === local ||
      value.credential_access !==
        (local ? "deny" : "selected_provider_only") ||
      value.endpoint_scope !==
        (local ? "literal_loopback" : "exact_remote_base_url") ||
      (local
        ? value.max_provider_requests_per_run !== null ||
          value.max_output_tokens_per_request !== null ||
          value.max_reported_total_tokens_per_run !== null
        : value.max_provider_requests_per_run === null ||
          value.max_output_tokens_per_request === null ||
          value.max_reported_total_tokens_per_run === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "persisted runtime policy evidence fields are inconsistent",
      });
    }
    const dockerEnabled = value.docker_acquisition_kind === "local_locked";
    if (
      value.docker_locked_pull_enabled !== dockerEnabled ||
      value.docker_locked_build_enabled !== dockerEnabled ||
      (dockerEnabled === (value.docker_allowed_artifact_ids.length === 0))
    ) {
      context.addIssue({
        code: "custom",
        message: "persisted Docker policy evidence fields are inconsistent",
      });
    }
  });

export type PersistedRuntimePolicyEvidenceV1 = z.infer<
  typeof persistedRuntimePolicyEvidenceSchema
>;

export interface RuntimePolicyEvidenceV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly profileMode: "local_free" | "remote_explicit";
  readonly profileSha256: string;
  readonly profileSource: RuntimePolicyRegistryEntry["source"];
  readonly explicitSelection: boolean;
  readonly paidCapable: boolean;
  readonly credentialAccess: "deny" | "selected_provider_only";
  readonly endpointScope: "literal_loopback" | "exact_remote_base_url";
  readonly allowedEvalSuites: readonly ("targeted" | "smoke" | "full")[];
  readonly proxyEnabled: false;
  readonly redirectsEnabled: false;
  readonly remoteFallbackEnabled: false;
  readonly automaticModelPullEnabled: false;
  readonly dockerAcquisitionKind: "deny" | "local_locked";
  readonly dockerAllowedArtifactIds: readonly string[];
  readonly dockerLockedPullEnabled: boolean;
  readonly dockerLockedBuildEnabled: boolean;
  readonly dockerDaemonScope: "local_only";
  readonly dockerRegistryCredentialAccess: "deny";
  readonly dockerPushEnabled: false;
  readonly remoteBuilderEnabled: false;
  readonly maxProviderRequestsPerRun: number | null;
  readonly maxOutputTokensPerRequest: number | null;
  readonly maxReportedTotalTokensPerRun: number | null;
}

export function createRuntimePolicyEvidence(
  entry: RuntimePolicyRegistryEntry,
  explicitSelection: boolean,
): RuntimePolicyEvidenceV1 {
  const profile = entry.profile;
  const local = profile.modelAccess.kind === "local_free";
  const docker = profile.dockerAcquisition;
  return Object.freeze({
    schemaVersion: 1,
    profileId: profile.id,
    profileMode: profile.mode,
    profileSha256: entry.profileSha256,
    profileSource: entry.source,
    explicitSelection,
    paidCapable: !local,
    credentialAccess: profile.modelAccess.credentialAccess,
    endpointScope: local ? "literal_loopback" : "exact_remote_base_url",
    allowedEvalSuites: Object.freeze([...profile.evalAccess.allowedSuites]),
    proxyEnabled: false,
    redirectsEnabled: false,
    remoteFallbackEnabled: false,
    automaticModelPullEnabled: false,
    dockerAcquisitionKind: docker.kind,
    dockerAllowedArtifactIds: Object.freeze(
      docker.kind === "local_locked" ? [...docker.allowedArtifactIds] : [],
    ),
    dockerLockedPullEnabled: docker.kind === "local_locked",
    dockerLockedBuildEnabled: docker.kind === "local_locked",
    dockerDaemonScope: "local_only",
    dockerRegistryCredentialAccess: "deny",
    dockerPushEnabled: false,
    remoteBuilderEnabled: false,
    maxProviderRequestsPerRun: local ? null : profile.modelAccess.limits.maxProviderRequestsPerRun,
    maxOutputTokensPerRequest: local ? null : profile.modelAccess.limits.maxOutputTokensPerRequest,
    maxReportedTotalTokensPerRun: local ? null : profile.modelAccess.limits.maxReportedTotalTokensPerRun,
  });
}

export function persistRuntimePolicyEvidence(evidence: RuntimePolicyEvidenceV1) {
  // PHASE15: sessions persist only canonical profile identity and decisions;
  // config paths/bytes and credential values never enter durable evidence.
  const persisted = persistedRuntimePolicyEvidenceSchema.parse({
    schema_version: 1 as const,
    profile_id: evidence.profileId,
    profile_mode: evidence.profileMode,
    profile_sha256: evidence.profileSha256,
    profile_source: evidence.profileSource,
    explicit_selection: evidence.explicitSelection,
    paid_capable: evidence.paidCapable,
    credential_access: evidence.credentialAccess,
    endpoint_scope: evidence.endpointScope,
    allowed_eval_suites: [...evidence.allowedEvalSuites],
    max_provider_requests_per_run: evidence.maxProviderRequestsPerRun,
    max_output_tokens_per_request: evidence.maxOutputTokensPerRequest,
    max_reported_total_tokens_per_run: evidence.maxReportedTotalTokensPerRun,
    proxy_enabled: false as const,
    redirects_enabled: false as const,
    remote_fallback_enabled: false as const,
    automatic_model_pull_enabled: false as const,
    docker_acquisition_kind: evidence.dockerAcquisitionKind,
    docker_allowed_artifact_ids: [...evidence.dockerAllowedArtifactIds],
    docker_locked_pull_enabled: evidence.dockerLockedPullEnabled,
    docker_locked_build_enabled: evidence.dockerLockedBuildEnabled,
    docker_daemon_scope: "local_only" as const,
    docker_registry_credential_access: "deny" as const,
    docker_push_enabled: false as const,
    remote_builder_enabled: false as const,
  });
  return Object.freeze({
    ...persisted,
    allowed_eval_suites: Object.freeze([...persisted.allowed_eval_suites]),
    docker_allowed_artifact_ids: Object.freeze([
      ...persisted.docker_allowed_artifact_ids,
    ]),
  });
}
