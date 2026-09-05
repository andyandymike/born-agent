import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  parseMemE0ActorQualificationReceipt,
  type MemE0ActorQualificationReceipt,
} from "./actor-qualification.js";
import { MEM_E0_EXPERIMENT_ID } from "./fixture.js";

export const MEM_E0_LIVE_PROVIDER = "deepseek" as const;
export const MEM_E0_LIVE_MODEL = "deepseek-v4-flash" as const;
export const MEM_E0_LIVE_ENDPOINT = "https://api.deepseek.com" as const;
export const MEM_E0_LIVE_PAIR_COUNT = 4 as const;
export const MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT = 8 as const;
export const MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT = 6 as const;
export const MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT = 87_712 as const;
export const MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT = 12_288 as const;
export const MEM_E0_LIVE_UPPER_BOUND_USD_MICROS = 438_512 as const;

const TOKENS_PER_PRICING_UNIT = 1_000_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const pricingSnapshotContentSchema = z.object({
  checkedOn: z.literal("2026-09-05"),
  model: z.literal(MEM_E0_LIVE_MODEL),
  peakCacheMissInputUsdMicrosPerMillionTokens: z.literal(440_000),
  peakOutputUsdMicrosPerMillionTokens: z.literal(1_320_000),
  pricingBasis: z.literal("official_peak_cache_miss"),
  pricingSnapshotType: z.literal("mem-e0-live-pricing-snapshot-v1"),
  provider: z.literal(MEM_E0_LIVE_PROVIDER),
  schemaVersion: z.literal(1),
  sourceUrl: z.literal("https://api-docs.deepseek.com/quick_start/pricing/"),
}).strict();

export const memE0LivePricingSnapshotSchema = pricingSnapshotContentSchema
  .extend({ pricingSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { pricingSha256, ...content } = value;
    if (pricingSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 live pricing snapshot canonical self-hash mismatch",
        path: ["pricingSha256"],
      });
    }
  });

const livePlanContentSchema = z.object({
  authorizationSemantics: z.object({
    accountBalanceIsAuthorization: z.literal(false),
    actorQualificationCostIncluded: z.literal(false),
    apiKeyPresenceIsAuthorization: z.literal(false),
    explicitBatchAuthorizationRequired: z.literal(true),
  }).strict(),
  bindings: z.object({
    actorFreezeSha256: sha256Schema,
    actorQualificationReceiptSha256: sha256Schema,
    disclosurePolicySha256: sha256Schema,
    fixtureSha256: sha256Schema,
    protectedTreeSha256: sha256Schema,
    protocolSha256: sha256Schema,
    qualificationFixtureSha256: sha256Schema,
    qualificationProtocolSha256: sha256Schema,
    sourceCommit: commitSchema,
  }).strict(),
  caps: z.object({
    effectAttemptCount: z.literal(MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT),
    inputReserveTokensPerAttempt: z.literal(
      MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT,
    ),
    maximumProviderRequests: z.literal(
      MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT *
        MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
    ),
    maximumRequestsPerAttempt: z.literal(
      MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
    ),
    outputReserveTokensPerAttempt: z.literal(
      MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT,
    ),
    pairCount: z.literal(MEM_E0_LIVE_PAIR_COUNT),
  }).strict(),
  cost: z.object({
    calculation: z.literal("peak_rates_with_ceiling_to_whole_usd_micro"),
    scope: z.literal("effect_batch_only_excludes_actor_qualification"),
    upperBoundUsdMicros: z.literal(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS),
  }).strict(),
  endpoint: z.literal(MEM_E0_LIVE_ENDPOINT),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  model: z.literal(MEM_E0_LIVE_MODEL),
  planType: z.literal("mem-e0-live-effect-plan-v1"),
  pricing: memE0LivePricingSnapshotSchema,
  provider: z.literal(MEM_E0_LIVE_PROVIDER),
  schemaVersion: z.literal(1),
}).strict();

export const memE0LivePlanSchema = livePlanContentSchema
  .extend({ planSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { planSha256, ...content } = value;
    if (planSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 live plan canonical self-hash mismatch",
        path: ["planSha256"],
      });
    }
    if (calculateUpperBoundUsdMicros(value.pricing) !== value.cost.upperBoundUsdMicros) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 live plan cost must be derived from frozen caps and pricing",
        path: ["cost", "upperBoundUsdMicros"],
      });
    }
  });

const preflightAuthorizationSchema = z.object({
  actorQualificationReceiptSha256Confirmation: sha256Schema,
  authorizeRemote: z.boolean(),
  disclosurePolicySha256Confirmation: sha256Schema,
  fixtureSha256Confirmation: sha256Schema,
  maximumEstimatedCostUsdMicros: z.number().int().nonnegative().safe(),
  pricingSnapshotSha256Confirmation: sha256Schema,
  protectedTreeSha256Confirmation: sha256Schema,
  protocolSha256Confirmation: sha256Schema,
  sourceCommitConfirmation: commitSchema,
}).strict();

export const memE0LivePreflightReasonCodeSchema = z.enum([
  "remote_authorization_missing",
  "protocol_confirmation_mismatch",
  "fixture_confirmation_mismatch",
  "disclosure_policy_confirmation_mismatch",
  "pricing_confirmation_mismatch",
  "cost_ceiling_too_low",
  "actor_qualification_not_run",
  "actor_qualification_failed",
  "actor_qualification_receipt_invalid",
  "actor_qualification_source_not_clean",
  "actor_qualification_plan_mismatch",
  "actor_qualification_confirmation_mismatch",
]);

const preflightDecisionContentSchema = z.object({
  actorQualificationReceiptSha256: sha256Schema.nullable(),
  planSha256: sha256Schema,
  providerCallsAuthorized: z.boolean(),
  reasonCodes: z.array(memE0LivePreflightReasonCodeSchema).max(16),
  status: z.enum(["blocked", "ready"]),
}).strict().superRefine((value, context) => {
  const ready = value.reasonCodes.length === 0;
  if (
    value.providerCallsAuthorized !== ready ||
    value.status !== (ready ? "ready" : "blocked")
  ) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 live preflight status must be derived from reason codes",
    });
  }
  if (ready && value.actorQualificationReceiptSha256 === null) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 ready preflight must bind a qualification receipt",
      path: ["actorQualificationReceiptSha256"],
    });
  }
});

export const memE0LivePreflightDecisionSchema = preflightDecisionContentSchema
  .extend({ decisionSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { decisionSha256, ...content } = value;
    if (decisionSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 live preflight decision canonical self-hash mismatch",
        path: ["decisionSha256"],
      });
    }
  });

export type MemE0LivePricingSnapshot = Readonly<
  z.infer<typeof memE0LivePricingSnapshotSchema>
>;
export type MemE0LivePlan = Readonly<z.infer<typeof memE0LivePlanSchema>>;
export type MemE0LivePreflightAuthorization = Readonly<
  z.infer<typeof preflightAuthorizationSchema>
>;
export type MemE0LivePreflightDecision = Readonly<
  z.infer<typeof memE0LivePreflightDecisionSchema>
>;

function calculateUpperBoundUsdMicros(
  pricing: Pick<
    MemE0LivePricingSnapshot,
    | "peakCacheMissInputUsdMicrosPerMillionTokens"
    | "peakOutputUsdMicrosPerMillionTokens"
  >,
): number {
  const perAttemptNumerator =
    BigInt(MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT) *
      BigInt(pricing.peakCacheMissInputUsdMicrosPerMillionTokens) +
    BigInt(MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT) *
      BigInt(pricing.peakOutputUsdMicrosPerMillionTokens);
  const perAttemptCeiling =
    (perAttemptNumerator + BigInt(TOKENS_PER_PRICING_UNIT - 1)) /
      BigInt(TOKENS_PER_PRICING_UNIT);
  return Number(perAttemptCeiling * BigInt(MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT));
}

export function createMemE0LivePricingSnapshot(): MemE0LivePricingSnapshot {
  const content = pricingSnapshotContentSchema.parse({
    checkedOn: "2026-09-05",
    model: MEM_E0_LIVE_MODEL,
    peakCacheMissInputUsdMicrosPerMillionTokens: 440_000,
    peakOutputUsdMicrosPerMillionTokens: 1_320_000,
    pricingBasis: "official_peak_cache_miss",
    pricingSnapshotType: "mem-e0-live-pricing-snapshot-v1",
    provider: MEM_E0_LIVE_PROVIDER,
    schemaVersion: 1,
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  });
  return Object.freeze(
    memE0LivePricingSnapshotSchema.parse({
      ...content,
      pricingSha256: sha256Canonical(content),
    }),
  );
}

export function parseMemE0LivePricingSnapshot(
  value: unknown,
): MemE0LivePricingSnapshot {
  return Object.freeze(memE0LivePricingSnapshotSchema.parse(value));
}

export function createMemE0LivePlan(input: Readonly<{
  actorQualificationReceipt: unknown;
  disclosurePolicySha256: string;
  fixtureSha256: string;
  protocolSha256: string;
}>): MemE0LivePlan {
  const pricing = createMemE0LivePricingSnapshot();
  const qualification = parseMemE0ActorQualificationReceipt(
    input.actorQualificationReceipt,
  );
  const content = livePlanContentSchema.parse({
    authorizationSemantics: {
      accountBalanceIsAuthorization: false,
      actorQualificationCostIncluded: false,
      apiKeyPresenceIsAuthorization: false,
      explicitBatchAuthorizationRequired: true,
    },
    bindings: {
      actorFreezeSha256: qualification.freeze.actorFreezeSha256,
      actorQualificationReceiptSha256: qualification.receiptSha256,
      disclosurePolicySha256: input.disclosurePolicySha256,
      fixtureSha256: input.fixtureSha256,
      protectedTreeSha256: qualification.source.protectedTreeSha256,
      protocolSha256: input.protocolSha256,
      qualificationFixtureSha256:
        qualification.freeze.qualificationFixtureSha256,
      qualificationProtocolSha256:
        qualification.freeze.qualificationProtocolSha256,
      sourceCommit: qualification.source.commit,
    },
    caps: {
      effectAttemptCount: MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT,
      inputReserveTokensPerAttempt:
        MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT,
      maximumProviderRequests:
        MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT *
        MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
      maximumRequestsPerAttempt: MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
      outputReserveTokensPerAttempt:
        MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT,
      pairCount: MEM_E0_LIVE_PAIR_COUNT,
    },
    cost: {
      calculation: "peak_rates_with_ceiling_to_whole_usd_micro",
      scope: "effect_batch_only_excludes_actor_qualification",
      upperBoundUsdMicros: calculateUpperBoundUsdMicros(pricing),
    },
    endpoint: MEM_E0_LIVE_ENDPOINT,
    experimentId: MEM_E0_EXPERIMENT_ID,
    model: MEM_E0_LIVE_MODEL,
    planType: "mem-e0-live-effect-plan-v1",
    pricing,
    provider: MEM_E0_LIVE_PROVIDER,
    schemaVersion: 1,
  });
  return Object.freeze(
    memE0LivePlanSchema.parse({
      ...content,
      planSha256: sha256Canonical(content),
    }),
  );
}

export function parseMemE0LivePlan(value: unknown): MemE0LivePlan {
  return Object.freeze(memE0LivePlanSchema.parse(value));
}

export function evaluateMemE0LivePreflight(
  planValue: unknown,
  qualificationReceiptValue: unknown,
  authorizationValue: unknown,
): MemE0LivePreflightDecision {
  const plan = parseMemE0LivePlan(planValue);
  const authorization = preflightAuthorizationSchema.parse(authorizationValue);
  const reasonCodes: z.infer<typeof memE0LivePreflightReasonCodeSchema>[] = [];
  let qualification: MemE0ActorQualificationReceipt | null = null;
  try {
    qualification = parseMemE0ActorQualificationReceipt(
      qualificationReceiptValue,
    );
  } catch {
    reasonCodes.push("actor_qualification_receipt_invalid");
  }

  if (!authorization.authorizeRemote) {
    reasonCodes.push("remote_authorization_missing");
  }
  if (authorization.protocolSha256Confirmation !== plan.bindings.protocolSha256) {
    reasonCodes.push("protocol_confirmation_mismatch");
  }
  if (authorization.fixtureSha256Confirmation !== plan.bindings.fixtureSha256) {
    reasonCodes.push("fixture_confirmation_mismatch");
  }
  if (
    authorization.disclosurePolicySha256Confirmation !==
    plan.bindings.disclosurePolicySha256
  ) {
    reasonCodes.push("disclosure_policy_confirmation_mismatch");
  }
  if (
    authorization.pricingSnapshotSha256Confirmation !==
    plan.pricing.pricingSha256
  ) {
    reasonCodes.push("pricing_confirmation_mismatch");
  }
  if (
    authorization.maximumEstimatedCostUsdMicros <
    plan.cost.upperBoundUsdMicros
  ) {
    reasonCodes.push("cost_ceiling_too_low");
  }
  if (
    authorization.actorQualificationReceiptSha256Confirmation !==
      plan.bindings.actorQualificationReceiptSha256 ||
    authorization.sourceCommitConfirmation !== plan.bindings.sourceCommit ||
    authorization.protectedTreeSha256Confirmation !==
      plan.bindings.protectedTreeSha256
  ) {
    reasonCodes.push("actor_qualification_confirmation_mismatch");
  }
  if (qualification !== null) {
    if (qualification.result.status === "not_run") {
      reasonCodes.push("actor_qualification_not_run");
    } else if (qualification.result.status === "failed") {
      reasonCodes.push("actor_qualification_failed");
    }
    if (!qualification.source.protectedPathsClean) {
      reasonCodes.push("actor_qualification_source_not_clean");
    }
    if (
      qualification.receiptSha256 !==
        plan.bindings.actorQualificationReceiptSha256 ||
      qualification.source.commit !== plan.bindings.sourceCommit ||
      qualification.source.protectedTreeSha256 !==
        plan.bindings.protectedTreeSha256 ||
      qualification.freeze.actorFreezeSha256 !==
        plan.bindings.actorFreezeSha256 ||
      qualification.freeze.qualificationFixtureSha256 !==
        plan.bindings.qualificationFixtureSha256 ||
      qualification.freeze.qualificationProtocolSha256 !==
        plan.bindings.qualificationProtocolSha256
    ) {
      reasonCodes.push("actor_qualification_plan_mismatch");
    }
  }

  const content = preflightDecisionContentSchema.parse({
    actorQualificationReceiptSha256: qualification?.receiptSha256 ?? null,
    planSha256: plan.planSha256,
    providerCallsAuthorized: reasonCodes.length === 0,
    reasonCodes,
    status: reasonCodes.length === 0 ? "ready" : "blocked",
  });
  return Object.freeze(
    memE0LivePreflightDecisionSchema.parse({
      ...content,
      decisionSha256: sha256Canonical(content),
    }),
  );
}

export function parseMemE0LivePreflightDecision(
  value: unknown,
): MemE0LivePreflightDecision {
  return Object.freeze(memE0LivePreflightDecisionSchema.parse(value));
}
