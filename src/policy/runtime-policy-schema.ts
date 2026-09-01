import { z } from "zod";

import { RuntimePolicyError } from "./policy-errors.js";

export const RUNTIME_POLICY_SCHEMA_VERSION = 1;
export const BUILT_IN_LOCAL_FREE_PROFILE_ID = "local-free-v1";
export const BUILT_IN_DOCKER_ARTIFACT_IDS = Object.freeze([
  "bornagent-sandbox-node-v1",
] as const);

export type RuntimePolicyMode = "local_free" | "remote_explicit";
export type EvalSuiteAccess = "targeted" | "smoke" | "full";
export type PolicyProvider = "anthropic" | "deepseek" | "fake" | "mock" | "ollama" | "openai";

export type DockerAcquisitionAccess =
  | { readonly kind: "deny" }
  | {
      readonly kind: "local_locked";
      readonly allowedArtifactIds: readonly string[];
      readonly pull: "allow_public_digest_pinned";
      readonly build: "allow_trusted_local_context";
    };

export interface LocalFreeModelAccess {
  readonly kind: "local_free";
  readonly allowedSources: readonly ("in_process_test" | "local_ollama")[];
  readonly allowedProviders: readonly ("fake" | "mock" | "ollama")[];
  readonly ollama: {
    readonly endpoint: string;
    readonly defaultModel: string;
    readonly requireInstalledDigest: true;
  };
  readonly credentialAccess: "deny";
}

export interface RemoteProviderRule {
  readonly provider: "anthropic" | "deepseek" | "openai";
  readonly models: readonly string[];
  readonly baseUrls: readonly string[];
}

export interface RemoteExplicitModelAccess {
  readonly kind: "remote_explicit";
  readonly providers: readonly RemoteProviderRule[];
  readonly credentialAccess: "selected_provider_only";
  readonly limits: {
    readonly maxProviderRequestsPerRun: number;
    readonly maxOutputTokensPerRequest: number;
    readonly maxReportedTotalTokensPerRun: number;
  };
}

export interface RuntimePolicyProfileV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: RuntimePolicyMode;
  readonly modelAccess: LocalFreeModelAccess | RemoteExplicitModelAccess;
  readonly evalAccess: {
    readonly allowedSuites: readonly EvalSuiteAccess[];
    readonly maxAttemptsPerRun: number;
  };
  readonly dockerAcquisition: DockerAcquisitionAccess;
}

const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
const sortedUniqueArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1).refine(unique, "array entries must be unique");
const profileId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const modelId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
  .refine((value) => !/(?:^|[/:._-])latest(?:$|[/:._-])/iu.test(value), "latest aliases are forbidden");
const loopbackEndpoint = z.string().refine((value) => {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(value);
  const port = Number(match?.[1]);
  return Number.isSafeInteger(port) && port <= 65_535;
}, "Ollama endpoint must be a literal loopback URL");

const REMOTE_PROVIDER_BASE_URLS = Object.freeze({
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
} as const);

const evalAccessSchema = z
  .object({
    allowed_suites: sortedUniqueArray(z.enum(["targeted", "smoke", "full"])),
    max_attempts_per_run: z.number().int().min(1).max(50),
  })
  .strict();
const dockerAcquisitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deny") }).strict(),
  z
    .object({
      kind: z.literal("local_locked"),
      allowed_artifact_ids: sortedUniqueArray(z.enum(BUILT_IN_DOCKER_ARTIFACT_IDS)),
      pull: z.literal("allow_public_digest_pinned"),
      build: z.literal("allow_trusted_local_context"),
    })
    .strict(),
]);
const localModelAccessSchema = z
  .object({
    kind: z.literal("local_free"),
    allowed_sources: sortedUniqueArray(z.enum(["in_process_test", "local_ollama"])),
    allowed_providers: sortedUniqueArray(z.enum(["fake", "mock", "ollama"])),
    ollama: z
      .object({
        endpoint: loopbackEndpoint,
        default_model: modelId,
        require_installed_digest: z.literal(true),
      })
      .strict(),
    credential_access: z.literal("deny"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowed_providers.includes("ollama") !== value.allowed_sources.includes("local_ollama")) {
      context.addIssue({ code: "custom", message: "Ollama provider/source must be enabled together" });
    }
    const hasTestProvider = value.allowed_providers.some((provider) => provider === "fake" || provider === "mock");
    if (hasTestProvider !== value.allowed_sources.includes("in_process_test")) {
      context.addIssue({ code: "custom", message: "in-process provider/source must be enabled together" });
    }
  });
const remoteProviderRuleSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "deepseek"]),
    models: sortedUniqueArray(modelId),
    base_urls: sortedUniqueArray(z.url()),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = REMOTE_PROVIDER_BASE_URLS[value.provider];
    if (value.base_urls.some((url) => url !== expected)) {
      context.addIssue({ code: "custom", message: `only the canonical ${value.provider} API base URL is allowed` });
    }
  });
const remoteModelAccessSchema = z
  .object({
    kind: z.literal("remote_explicit"),
    providers: sortedUniqueArray(remoteProviderRuleSchema).refine(
      (rules) => unique(rules.map((rule) => rule.provider)),
      "provider rules must be unique",
    ),
    credential_access: z.literal("selected_provider_only"),
    limits: z
      .object({
        max_provider_requests_per_run: z.number().int().min(1).max(100),
        max_output_tokens_per_request: z.number().int().min(1).max(32_768),
        max_reported_total_tokens_per_run: z.number().int().min(1).max(10_000_000),
      })
      .strict(),
  })
  .strict();

const baseProfile = {
  schema_version: z.literal(1),
  id: profileId,
  eval_access: evalAccessSchema,
  docker_acquisition: dockerAcquisitionSchema,
};
// PHASE15: the discriminated union makes local and paid-capable fields
// mutually exclusive. Strict objects reject unknown escape-hatch fields rather
// than silently dropping authority the runtime does not understand.
export const runtimePolicyProfileRawSchema = z.discriminatedUnion("mode", [
  z
    .object({ ...baseProfile, mode: z.literal("local_free"), model_access: localModelAccessSchema })
    .strict(),
  z
    .object({ ...baseProfile, mode: z.literal("remote_explicit"), model_access: remoteModelAccessSchema })
    .strict()
    .superRefine((value, context) => {
      if (value.eval_access.allowed_suites.includes("full")) {
        context.addIssue({ code: "custom", message: "remote profiles cannot authorize full eval" });
      }
    }),
]);

export const userPolicyConfigRawSchema = z
  .object({
    schema_version: z.literal(1),
    profiles: z.array(runtimePolicyProfileRawSchema).min(1).max(64),
  })
  .strict()
  .refine((value) => unique(value.profiles.map((profile) => profile.id)), "profile ids must be unique");

type RawProfile = z.infer<typeof runtimePolicyProfileRawSchema>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeProfile(raw: RawProfile): RuntimePolicyProfileV1 {
  const dockerAcquisition: DockerAcquisitionAccess =
    raw.docker_acquisition.kind === "deny"
      ? { kind: "deny" }
      : {
          kind: "local_locked",
          allowedArtifactIds: [...raw.docker_acquisition.allowed_artifact_ids],
          pull: raw.docker_acquisition.pull,
          build: raw.docker_acquisition.build,
        };
  const modelAccess: LocalFreeModelAccess | RemoteExplicitModelAccess =
    raw.mode === "local_free"
      ? {
          kind: "local_free",
          allowedSources: [...raw.model_access.allowed_sources],
          allowedProviders: [...raw.model_access.allowed_providers],
          ollama: {
            endpoint: raw.model_access.ollama.endpoint,
            defaultModel: raw.model_access.ollama.default_model,
            requireInstalledDigest: true,
          },
          credentialAccess: "deny",
        }
      : {
          kind: "remote_explicit",
          providers: raw.model_access.providers.map((rule) => ({
            provider: rule.provider,
            models: [...rule.models],
            baseUrls: [...rule.base_urls],
          })),
          credentialAccess: "selected_provider_only",
          limits: {
            maxProviderRequestsPerRun: raw.model_access.limits.max_provider_requests_per_run,
            maxOutputTokensPerRequest: raw.model_access.limits.max_output_tokens_per_request,
            maxReportedTotalTokensPerRun: raw.model_access.limits.max_reported_total_tokens_per_run,
          },
        };
  return freeze({
    schemaVersion: 1,
    id: raw.id,
    mode: raw.mode,
    modelAccess,
    evalAccess: {
      allowedSuites: [...raw.eval_access.allowed_suites],
      maxAttemptsPerRun: raw.eval_access.max_attempts_per_run,
    },
    dockerAcquisition,
  });
}

export function parseRuntimePolicyProfile(input: unknown): RuntimePolicyProfileV1 {
  const parsed = runtimePolicyProfileRawSchema.safeParse(input);
  if (!parsed.success) {
    throw new RuntimePolicyError("policy_config_invalid", "runtime policy profile failed strict schema validation", 2, { cause: parsed.error });
  }
  return normalizeProfile(parsed.data);
}

export function parseUserPolicyConfig(input: unknown): readonly RuntimePolicyProfileV1[] {
  const parsed = userPolicyConfigRawSchema.safeParse(input);
  if (!parsed.success) {
    throw new RuntimePolicyError("policy_config_invalid", "user policy config failed strict schema validation", 2, { cause: parsed.error });
  }
  return Object.freeze(parsed.data.profiles.map(normalizeProfile));
}

export function canonicalPolicyProfileData(profile: RuntimePolicyProfileV1): unknown {
  const dockerAcquisition = profile.dockerAcquisition.kind === "deny"
    ? { kind: "deny" }
    : {
        allowed_artifact_ids: [...profile.dockerAcquisition.allowedArtifactIds].sort(),
        build: profile.dockerAcquisition.build,
        kind: profile.dockerAcquisition.kind,
        pull: profile.dockerAcquisition.pull,
      };
  const modelAccess = profile.modelAccess.kind === "local_free"
    ? {
        allowed_providers: [...profile.modelAccess.allowedProviders].sort(),
        allowed_sources: [...profile.modelAccess.allowedSources].sort(),
        credential_access: profile.modelAccess.credentialAccess,
        kind: profile.modelAccess.kind,
        ollama: {
          default_model: profile.modelAccess.ollama.defaultModel,
          endpoint: profile.modelAccess.ollama.endpoint,
          require_installed_digest: true,
        },
      }
    : {
        credential_access: profile.modelAccess.credentialAccess,
        kind: profile.modelAccess.kind,
        limits: {
          max_output_tokens_per_request: profile.modelAccess.limits.maxOutputTokensPerRequest,
          max_provider_requests_per_run: profile.modelAccess.limits.maxProviderRequestsPerRun,
          max_reported_total_tokens_per_run: profile.modelAccess.limits.maxReportedTotalTokensPerRun,
        },
        providers: [...profile.modelAccess.providers]
          .sort((left, right) => left.provider.localeCompare(right.provider))
          .map((rule) => ({
            base_urls: [...rule.baseUrls].sort(),
            models: [...rule.models].sort(),
            provider: rule.provider,
          })),
      };
  return {
    docker_acquisition: dockerAcquisition,
    eval_access: {
      allowed_suites: [...profile.evalAccess.allowedSuites].sort(),
      max_attempts_per_run: profile.evalAccess.maxAttemptsPerRun,
    },
    id: profile.id,
    mode: profile.mode,
    model_access: modelAccess,
    schema_version: 1,
  };
}
