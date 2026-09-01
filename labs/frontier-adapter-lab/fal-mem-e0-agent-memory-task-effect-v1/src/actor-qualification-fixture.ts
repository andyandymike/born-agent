import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { MODEL_QUALIFICATION_PROBE_IDS } from "../../../../src/model/model-qualification-schema.js";
import {
  MODEL_QUALIFICATION_LIMITS,
  MODEL_QUALIFICATION_PROBE_SUITE_VERSION,
  MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256,
} from "../../../../src/model/model-qualification-suite.js";
import {
  canonicalPolicyProfileData,
  parseUserPolicyConfig,
  type RuntimePolicyProfileV1,
} from "../../../../src/policy/runtime-policy-schema.js";
import { PI_AI_PACKAGE_VERSION } from "../../../../src/providers/pi/pi-model-catalog.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  MEM_E0_ACTOR_QUALIFICATION_ENDPOINT,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
  MEM_E0_ACTOR_QUALIFICATION_MODEL,
  MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  MEM_E0_ACTOR_QUALIFICATION_PROVIDER,
  MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE,
} from "./actor-qualification.js";
import {
  loadMemE0Fixture,
  memE0RawSha256,
  MEM_E0_EXPERIMENT_ID,
  type MemE0LoadedCase,
} from "./fixture.js";

export const MEM_E0_ACTOR_QUALIFICATION_ID =
  "fal-mem-e0-deepseek-product-tool-actor-qualification-v1" as const;
export const MEM_E0_ACTOR_QUALIFICATION_CASE_ID =
  "mem-e0-harm-control" as const;
export const MEM_E0_ACTOR_QUALIFICATION_POLICY_PROFILE_ID =
  "fal-mem-e0-deepseek-qualification-v1" as const;
export const MEM_E0_ACTOR_QUALIFICATION_APPLICATION_ENTRY =
  "executeAgentThroughApplicationService" as const;
export const MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH =
  "qualification/actor-config.json" as const;
export const MEM_E0_ACTOR_QUALIFICATION_POLICY_RELATIVE_PATH =
  "qualification/remote-policy.json" as const;
export const MEM_E0_ACTOR_QUALIFICATION_TOOL_CATALOG_SHA256 =
  "3c9f9b56c7b3c3392f2e41a00324393400b67c83872acb1b6558584eb6e8d508" as const;
export const MEM_E0_GENERIC_DS0_POLICY_PROFILE_ID =
  "fal-ds0-deepseek-remote-v1" as const;
export const MEM_E0_GENERIC_DS0_POLICY_PROFILE_SHA256 =
  "e0aa62f5307506b757eccffaaa318cb2dc55bb13dfd843b209d9bbc81226c433" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const caseBindingSchema = z.object({
  allowedChangedPaths: z.tuple([z.literal("src/harm-control.mjs")]),
  caseId: z.literal(MEM_E0_ACTOR_QUALIFICATION_CASE_ID),
  caseSha256: sha256Schema,
  hiddenVerifierArgvIdentitySha256: sha256Schema,
  hiddenVerifierImplementationRawSha256: sha256Schema,
  initialTargetRawSha256: sha256Schema,
  publicVerifierRawSha256: sha256Schema,
  publicWorkspaceManifestSha256: sha256Schema,
  targetRelativePath: z.literal("src/harm-control.mjs"),
  taskSha256: sha256Schema,
}).strict();

const fixtureBindingContentSchema = z.object({
  case: caseBindingSchema,
  experimentProtocolRawSha256: sha256Schema,
  experimentProtocolSha256: sha256Schema,
}).strict();

const fixtureBindingSchema = fixtureBindingContentSchema.extend({
  fixtureBindingSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { fixtureBindingSha256, ...content } = value;
  if (fixtureBindingSha256 !== sha256Canonical(content)) {
    context.addIssue({
      code: "custom",
      message: "qualification fixture binding canonical self-hash mismatch",
      path: ["fixtureBindingSha256"],
    });
  }
});

const remotePolicySchema = z.object({
  allowedSuites: z.tuple([z.literal("smoke"), z.literal("targeted")]),
  credentialAccess: z.literal("selected_provider_only"),
  dockerAcquisition: z.literal("deny"),
  maximumAttemptsPerRun: z.literal(1),
  mode: z.literal("remote_explicit"),
  profileId: z.literal(MEM_E0_ACTOR_QUALIFICATION_POLICY_PROFILE_ID),
  profileSha256: sha256Schema,
  rawSha256: sha256Schema,
  relativePath: z.literal(MEM_E0_ACTOR_QUALIFICATION_POLICY_RELATIVE_PATH),
}).strict();

const actorSchema = z.object({
  applicationServiceEntry: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_APPLICATION_ENTRY,
  ),
  orderedProductionToolNames: z.tuple([
    z.literal("read_file"),
    z.literal("apply_patch"),
    z.literal("run_command"),
    z.literal("finish_task"),
  ]),
  productEntrySha256: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  ),
  systemInstructionSha256: sha256Schema,
  toolAllowlistSha256: sha256Schema,
  toolCatalogSha256: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_TOOL_CATALOG_SHA256,
  ),
}).strict().superRefine((value, context) => {
  if (
    value.productEntrySha256 !==
      memE0RawSha256(value.applicationServiceEntry)
  ) {
    context.addIssue({
      code: "custom",
      message: "qualification Application Service entry identity mismatch",
      path: ["productEntrySha256"],
    });
  }
  if (
    value.toolAllowlistSha256 !==
      sha256Canonical(value.orderedProductionToolNames)
  ) {
    context.addIssue({
      code: "custom",
      message: "qualification production tool allowlist hash mismatch",
      path: ["toolAllowlistSha256"],
    });
  }
});

const providerSchema = z.object({
  endpoint: z.literal(MEM_E0_ACTOR_QUALIFICATION_ENDPOINT),
  model: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
  modelAliasMutable: z.literal(true),
  provider: z.literal(MEM_E0_ACTOR_QUALIFICATION_PROVIDER),
  providerSource: z.literal("provider_network"),
}).strict();

const budgetsSchema = z.object({
  maximumAuthorizedCostUsdMicros: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  ),
  maximumOutputTokensTotal: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
  ),
  maximumOutputTokensPerRequest: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
  ),
  maximumProviderRequests: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
  ),
  maximumReportedTotalTokens: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
  ),
  retries: z.literal(0),
}).strict();

const genericModelQualificationSchema = z.object({
  evidenceKind: z.literal("model_capability_probe_suite"),
  expectedIdentity: z.object({
    adapterId: z.literal("pi-ai"),
    adapterVersion: z.literal(PI_AI_PACKAGE_VERSION),
    continuationCodecVersion: z.null(),
    endpointScope: z.object({
      kind: z.literal("remote_explicit"),
      originSha256: sha256Schema,
    }).strict(),
    model: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
    modelRuntimeIdentity: z.object({
      kind: z.literal("provider_model_id"),
      value: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
    }).strict(),
    policyProfileId: z.literal(MEM_E0_GENERIC_DS0_POLICY_PROFILE_ID),
    policyProfileSha256: z.literal(
      MEM_E0_GENERIC_DS0_POLICY_PROFILE_SHA256,
    ),
    probeSuiteVersion: z.literal(MODEL_QUALIFICATION_PROBE_SUITE_VERSION),
    probeToolSchemaSha256: z.literal(
      MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256,
    ),
    provider: z.literal(MEM_E0_ACTOR_QUALIFICATION_PROVIDER),
  }).strict(),
  maximumRecordRequestCount: z.literal(
    MODEL_QUALIFICATION_LIMITS.maxProviderRequests,
  ),
  minimumRecordRequestCount: z.literal(1),
  probeIds: z.tuple([
    z.literal("streaming_text_v1"),
    z.literal("strict_tool_args_v1"),
    z.literal("tool_continuation_v1"),
    z.literal("sequential_tools_v1"),
    z.literal("cancellation_v1"),
    z.literal("usage_semantics_v1"),
  ]),
  recordEvidenceBinding: z.literal("run_local_authorization_only"),
  recordReuseOnly: z.literal(true),
  requiredQualifiedModes: z.tuple([z.literal("build")]),
  rerunProviderCallsAuthorized: z.literal(false),
  usageRequirement: z.object({
    availability: z.literal("complete"),
    probeId: z.literal("usage_semantics_v1"),
    status: z.literal("passed"),
  }).strict(),
}).strict();

const actorQualificationConfigContentSchema = z.object({
  actor: actorSchema,
  budgets: budgetsSchema,
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  fixture: fixtureBindingSchema,
  genericModelQualification: genericModelQualificationSchema,
  provider: providerSchema,
  qualificationId: z.literal(MEM_E0_ACTOR_QUALIFICATION_ID),
  qualificationRevision: z.literal(1),
  remotePolicy: remotePolicySchema,
  schemaVersion: z.literal(1),
}).strict();

export const memE0ActorQualificationConfigSchema =
  actorQualificationConfigContentSchema.extend({
    configSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    const genericIdentity = value.genericModelQualification.expectedIdentity;
    if (
      genericIdentity.provider !== value.provider.provider ||
      genericIdentity.model !== value.provider.model ||
      genericIdentity.modelRuntimeIdentity.value !== value.provider.model ||
      genericIdentity.endpointScope.originSha256 !==
        sha256Canonical({ endpoint: value.provider.endpoint }) ||
      sha256Canonical(value.genericModelQualification.probeIds) !==
        sha256Canonical(MODEL_QUALIFICATION_PROBE_IDS)
    ) {
      context.addIssue({
        code: "custom",
        message: "generic model qualification identity drifted from the frozen actor",
        path: ["genericModelQualification"],
      });
    }
    if (
      genericIdentity.policyProfileSha256 === value.remotePolicy.profileSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "generic DS0 and actor qualification policies must remain independent",
        path: ["genericModelQualification", "expectedIdentity"],
      });
    }
    const { configSha256, ...content } = value;
    if (configSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "qualification actor config canonical self-hash mismatch",
        path: ["configSha256"],
      });
    }
  });

export type MemE0ActorQualificationConfig = Readonly<
  z.infer<typeof memE0ActorQualificationConfigSchema>
>;

export interface MemE0LoadedActorQualificationFixture {
  readonly case: MemE0LoadedCase;
  readonly config: MemE0ActorQualificationConfig;
  readonly configPath: string;
  readonly configRawSha256: string;
  readonly policyPath: string;
  readonly policyProfile: RuntimePolicyProfileV1;
  readonly policyRawSha256: string;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function parseMemE0ActorQualificationConfig(
  value: unknown,
): MemE0ActorQualificationConfig {
  return freezeDeep(memE0ActorQualificationConfigSchema.parse(value));
}

function actualCaseBinding(loadedCase: MemE0LoadedCase): z.infer<
  typeof caseBindingSchema
> {
  const definition = loadedCase.definition;
  const publicVerifier = loadedCase.publicFiles.find(
    (file) =>
      file.path === definition.publicWorkspace.publicVerifierRelativePath,
  );
  if (publicVerifier === undefined) {
    throw new Error("qualification public verifier is absent from the fixture");
  }
  return caseBindingSchema.parse({
    allowedChangedPaths: definition.publicWorkspace.allowedChangedPaths,
    caseId: definition.caseId,
    caseSha256: definition.caseSha256,
    hiddenVerifierArgvIdentitySha256:
      definition.hiddenVerifier.argvIdentitySha256,
    hiddenVerifierImplementationRawSha256:
      definition.hiddenVerifier.implementationRawSha256,
    initialTargetRawSha256:
      definition.publicWorkspace.initialTargetRawSha256,
    publicVerifierRawSha256: publicVerifier.rawSha256,
    publicWorkspaceManifestSha256:
      definition.publicWorkspace.manifestSha256,
    targetRelativePath: definition.publicWorkspace.targetRelativePath,
    taskSha256: definition.task.taskSha256,
  });
}

function assertPolicyProfile(
  profile: RuntimePolicyProfileV1,
  config: MemE0ActorQualificationConfig,
): void {
  const access = profile.modelAccess;
  const providerRule = access.kind === "remote_explicit"
    ? access.providers[0]
    : undefined;
  if (
    profile.schemaVersion !== 1 ||
    profile.id !== config.remotePolicy.profileId ||
    profile.mode !== config.remotePolicy.mode ||
    access.kind !== "remote_explicit" ||
    access.credentialAccess !== config.remotePolicy.credentialAccess ||
    access.providers.length !== 1 ||
    providerRule?.provider !== config.provider.provider ||
    providerRule.models.length !== 1 ||
    providerRule.models[0] !== config.provider.model ||
    providerRule.baseUrls.length !== 1 ||
    providerRule.baseUrls[0] !== config.provider.endpoint ||
    access.limits.maxProviderRequestsPerRun !==
      config.budgets.maximumProviderRequests ||
    access.limits.maxOutputTokensPerRequest !==
      config.budgets.maximumOutputTokensPerRequest ||
    access.limits.maxReportedTotalTokensPerRun !==
      config.budgets.maximumReportedTotalTokens ||
    JSON.stringify(profile.evalAccess.allowedSuites) !==
      JSON.stringify(config.remotePolicy.allowedSuites) ||
    profile.evalAccess.maxAttemptsPerRun !==
      config.remotePolicy.maximumAttemptsPerRun ||
    profile.dockerAcquisition.kind !== config.remotePolicy.dockerAcquisition
  ) {
    throw new Error("qualification remote policy profile drifted from actor config");
  }
  if (
    sha256Canonical(canonicalPolicyProfileData(profile)) !==
      config.remotePolicy.profileSha256
  ) {
    throw new Error("qualification normalized policy profile hash mismatch");
  }
}

export async function loadMemE0ActorQualificationFixture(
  repositoryRoot: string,
): Promise<MemE0LoadedActorQualificationFixture> {
  const experimentFixture = await loadMemE0Fixture(repositoryRoot);
  const configPath = join(
    experimentFixture.directory,
    ...MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH.split("/"),
  );
  const configRaw = await readFile(configPath, "utf8");
  const config = parseMemE0ActorQualificationConfig(
    parseStrictJson(configRaw),
  );

  const loadedCase = experimentFixture.cases.find(
    (entry) => entry.definition.caseId === MEM_E0_ACTOR_QUALIFICATION_CASE_ID,
  );
  if (loadedCase === undefined) {
    throw new Error("qualification harm-control case is absent");
  }
  const actualFixtureContent = fixtureBindingContentSchema.parse({
    case: actualCaseBinding(loadedCase),
    experimentProtocolRawSha256: experimentFixture.protocolRawSha256,
    experimentProtocolSha256: experimentFixture.protocol.protocolSha256,
  });
  if (
    sha256Canonical(actualFixtureContent) !==
      config.fixture.fixtureBindingSha256
  ) {
    throw new Error("qualification fixture bytes drifted from actor config");
  }

  if (
    memE0RawSha256(AGENT_SYSTEM_INSTRUCTIONS) !==
      config.actor.systemInstructionSha256
  ) {
    throw new Error("qualification Agent system instructions drifted");
  }
  if (
    sha256Canonical(MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE) !==
      config.actor.toolAllowlistSha256
  ) {
    throw new Error("qualification production tool allowlist drifted");
  }
  if (
    config.actor.toolCatalogSha256 !==
      MEM_E0_ACTOR_QUALIFICATION_TOOL_CATALOG_SHA256
  ) {
    throw new Error("qualification production tool modelDefinitions drifted");
  }
  if (
    memE0RawSha256(MEM_E0_ACTOR_QUALIFICATION_APPLICATION_ENTRY) !==
      config.actor.productEntrySha256
  ) {
    throw new Error("qualification Application Service entry drifted");
  }

  const policyPath = join(
    experimentFixture.directory,
    ...config.remotePolicy.relativePath.split("/"),
  );
  const policyRaw = await readFile(policyPath, "utf8");
  if (memE0RawSha256(policyRaw) !== config.remotePolicy.rawSha256) {
    throw new Error("qualification raw remote policy hash mismatch");
  }
  const profiles = parseUserPolicyConfig(parseStrictJson(policyRaw));
  if (profiles.length !== 1) {
    throw new Error("qualification remote policy must contain exactly one profile");
  }
  const profile = profiles[0]!;
  assertPolicyProfile(profile, config);

  return Object.freeze({
    case: loadedCase,
    config,
    configPath,
    configRawSha256: memE0RawSha256(configRaw),
    policyPath,
    policyProfile: profile,
    policyRawSha256: memE0RawSha256(policyRaw),
  });
}
