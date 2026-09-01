import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { parseUserPolicyConfig } from "../../../../src/policy/runtime-policy-schema.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  loadDevelopmentPilotFixture,
  type DevelopmentPilotFixture,
} from "./development-pilot-fixture.js";

export const VP0_DEVELOPMENT_DIRECT_PILOT_ID =
  "fal-vp0-deepseek-direct-generation-pilot-v1" as const;
export const VP0_DEVELOPMENT_DIRECT_POLICY_PROFILE =
  "vp0-development-deepseek-direct" as const;

const directProtocolSchema = z.object({
  schemaVersion: z.literal(1),
  pilotId: z.literal(VP0_DEVELOPMENT_DIRECT_PILOT_ID),
  experimentId: z.literal("fal-vp0-verified-procedure-utilization-v1"),
  evidenceClass: z.literal("development_directional_direct_generation_actual_model_effect_only"),
  vp0GateEligible: z.literal(false),
  provider: z.literal("deepseek"),
  model: z.literal("deepseek-v4-flash"),
  baseUrl: z.literal("https://api.deepseek.com"),
  policyProfile: z.literal(VP0_DEVELOPMENT_DIRECT_POLICY_PROFILE),
  pairCount: z.literal(3),
  attemptCount: z.literal(6),
  fixedExecutionOrder: z.tuple([
    z.literal("inclusive-boundary:baseline"),
    z.literal("inclusive-boundary:candidate"),
    z.literal("end-exclusive-page-window:candidate"),
    z.literal("end-exclusive-page-window:baseline"),
    z.literal("one-based-retry-cap:baseline"),
    z.literal("one-based-retry-cap:candidate"),
  ]),
  treatment: z.object({
    baseline: z.literal("same_public_task_and_public_tree_without_procedure"),
    candidate: z.literal("same_public_task_and_public_tree_plus_verified_procedure_text"),
  }).strict(),
  perAttemptCaps: z.object({
    maximumProviderRequests: z.literal(1),
    maximumEncodedPromptBytes: z.literal(8_192),
    inputAuthorizationTokens: z.literal(18_432),
    inputAuthorizationFormula: z.literal("2*maximumEncodedPromptBytes+2048"),
    maximumReportedInputTokens: z.literal(18_432),
    maximumReportedOutputTokens: z.literal(512),
    maximumReportedTotalTokens: z.literal(18_944),
    maximumResponseBytes: z.literal(8_192),
    maximumReplacementBytes: z.literal(4_096),
    maximumWallTimeMs: z.literal(90_000),
  }).strict(),
  batchCaps: z.object({
    maximumConcurrentAttempts: z.literal(1),
    maximumProviderRequests: z.literal(6),
    maximumReportedTotalTokens: z.literal(113_664),
    conservativePeakUpperBoundUsdMicros: z.literal(52_716),
    conservativePeakUpperBoundFormula: z.literal("ceil(attemptCount*(inputAuthorizationTokens*peak.uncachedInput+maximumReportedOutputTokens*peak.output))"),
    maximumAuthorizedCostUsdMicros: z.literal(60_000),
  }).strict(),
  outcome: z.object({
    primary: z.literal("independent_exact_fresh_verifier_success"),
    productAgentCompletionClaimed: z.literal(false),
    bornagentToolProtocolExercised: z.literal(false),
  }).strict(),
  authorization: z.object({
    defaultMode: z.literal("offline_plan_only"),
    remoteCallsAuthorizedByFixture: z.literal(false),
    requiresRunLocalAuthorizeRemoteFlag: z.literal(true),
    requiresRunLocalMaximumCost: z.literal(true),
    apiKeyPresenceIsAuthorization: z.literal(false),
  }).strict(),
  retention: z.object({
    rawProviderResponseAllowed: z.literal(false),
    rawProviderReasoningAllowed: z.literal(false),
    apiKeyPersistenceAllowed: z.literal(false),
    absolutePathPersistenceAllowed: z.literal(false),
    attemptWorkspacesDeletedAfterSanitizedObservation: z.literal(true),
  }).strict(),
  nonClaims: z.array(z.string().min(1).max(512)).min(6),
}).strict();

export type DevelopmentDirectProtocol = Readonly<z.infer<typeof directProtocolSchema>>;

export interface DevelopmentDirectFixture {
  readonly base: DevelopmentPilotFixture;
  readonly directPolicyPath: string;
  readonly directPolicyRawSha256: string;
  readonly directProtocol: DevelopmentDirectProtocol;
  readonly directProtocolRawSha256: string;
}

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadDevelopmentDirectFixture(
  repositoryRoot: string,
): Promise<DevelopmentDirectFixture> {
  const base = await loadDevelopmentPilotFixture(repositoryRoot);
  const directProtocolPath = join(base.directory, "direct-generation-protocol.json");
  const directPolicyPath = join(base.directory, "direct-generation-remote-policy.json");
  const [protocolRaw, policyRaw] = await Promise.all([
    readFile(directProtocolPath, "utf8"),
    readFile(directPolicyPath, "utf8"),
  ]);
  const directProtocol = directProtocolSchema.parse(parseStrictJson(protocolRaw));
  const profiles = parseUserPolicyConfig(parseStrictJson(policyRaw));
  const profile = profiles.length === 1 ? profiles[0] : undefined;
  const access = profile?.modelAccess;
  const provider = access?.kind === "remote_explicit" && access.providers.length === 1
    ? access.providers[0]
    : undefined;
  if (
    profile?.id !== directProtocol.policyProfile ||
    profile.mode !== "remote_explicit" ||
    access?.kind !== "remote_explicit" ||
    access.credentialAccess !== "selected_provider_only" ||
    access.limits.maxProviderRequestsPerRun !== directProtocol.batchCaps.maximumProviderRequests ||
    access.limits.maxOutputTokensPerRequest !== directProtocol.perAttemptCaps.maximumReportedOutputTokens ||
    access.limits.maxReportedTotalTokensPerRun !== directProtocol.batchCaps.maximumReportedTotalTokens ||
    provider?.provider !== directProtocol.provider ||
    provider.models.length !== 1 ||
    provider.models[0] !== directProtocol.model ||
    provider.baseUrls.length !== 1 ||
    provider.baseUrls[0] !== directProtocol.baseUrl ||
    profile.evalAccess.maxAttemptsPerRun !== directProtocol.attemptCount ||
    profile.dockerAcquisition.kind !== "deny"
  ) {
    throw new Error("development direct policy drifted from its frozen protocol");
  }
  const inputAuthorizationTokens =
    2 * directProtocol.perAttemptCaps.maximumEncodedPromptBytes + 2_048;
  const perAttemptReportedTotal =
    directProtocol.perAttemptCaps.maximumReportedInputTokens +
    directProtocol.perAttemptCaps.maximumReportedOutputTokens;
  const conservativePeakUpperBoundUsdMicros = Math.ceil(
    directProtocol.attemptCount * (
      directProtocol.perAttemptCaps.inputAuthorizationTokens *
        base.pricing.peak.uncachedInput +
      directProtocol.perAttemptCaps.maximumReportedOutputTokens *
        base.pricing.peak.output
    ),
  );
  if (
    inputAuthorizationTokens !== directProtocol.perAttemptCaps.inputAuthorizationTokens ||
    directProtocol.perAttemptCaps.maximumReportedInputTokens !== inputAuthorizationTokens ||
    directProtocol.perAttemptCaps.maximumReportedTotalTokens !== perAttemptReportedTotal ||
    directProtocol.batchCaps.maximumReportedTotalTokens !==
      directProtocol.attemptCount * perAttemptReportedTotal ||
    directProtocol.batchCaps.conservativePeakUpperBoundUsdMicros !==
      conservativePeakUpperBoundUsdMicros ||
    directProtocol.batchCaps.conservativePeakUpperBoundUsdMicros >
      directProtocol.batchCaps.maximumAuthorizedCostUsdMicros
  ) {
    throw new Error("development direct cost or token formulas drifted");
  }
  return Object.freeze({
    base,
    directPolicyPath,
    directPolicyRawSha256: rawSha256(policyRaw),
    directProtocol: Object.freeze(directProtocol),
    directProtocolRawSha256: rawSha256(protocolRaw),
  });
}
