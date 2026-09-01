import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

export const DS0_EXPERIMENT_ID = "fal-ds0-deepseek-tool-actor-v1" as const;
export const DS0_PROVIDER = "deepseek" as const;
export const DS0_MODEL = "deepseek-v4-flash" as const;
export const DS0_BASE_URL = "https://api.deepseek.com" as const;
export const DS0_POLICY_PROFILE = "fal-ds0-deepseek-remote-v1" as const;
export const DS0_LIVE_CONFIRMATION_USD = "0.12" as const;
export const DS0_LIVE_CONFIRMATION_USD_MICROS = 120_000 as const;
export const DS0_COMBINED_MAXIMUM_PROVIDER_REQUESTS = 12 as const;
export const DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS = 6 as const;
export const DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS = 6 as const;
export const DS0_ACTOR_MAXIMUM_REPORTED_TOKENS = 120_000 as const;
export const DS0_UNREPORTED_QUALIFICATION_REQUEST_RESERVE_TOKENS = 8_192 as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const tokenRate = z.number().nonnegative().finite();

const pricingSchema = z
  .object({
    modelAlias: z.literal(DS0_MODEL),
    offPeak: z
      .object({
        cachedInput: tokenRate,
        output: tokenRate,
        uncachedInput: tokenRate,
      })
      .strict(),
    peak: z
      .object({
        cachedInput: tokenRate,
        output: tokenRate,
        uncachedInput: tokenRate,
      })
      .strict(),
    peakWindow: z
      .object({
        intervals: z
          .array(
            z
              .object({
                endExclusive: z.string().regex(/^\d{2}:\d{2}$/u),
                startInclusive: z.string().regex(/^\d{2}:\d{2}$/u),
              })
              .strict(),
          )
          .min(1),
        otherwise: z.literal("off_peak"),
        timezone: z.literal("UTC"),
        weekdays: z.array(z.string()).min(1),
      })
      .strict(),
    pricingSha256: sha256,
    provider: z.literal(DS0_PROVIDER),
    schemaVersion: z.literal(1),
    snapshotId: z.string().min(1),
  })
  .passthrough();

const protocolSchema = z
  .object({
    authorization: z
      .object({
        accountBalanceIsAuthorization: z.literal(false),
        apiKeyPresenceIsAuthorization: z.literal(false),
        qualificationRunAuthorized: z.literal(false),
        remoteCallsAuthorized: z.literal(false),
      })
      .passthrough(),
    caps: z
      .object({
        conservativePeakUpperBoundUsdMicros: z.number().int().nonnegative(),
        maximumEstimatedCostUsdMicros: z.number().int().nonnegative(),
        maximumOutputTokensPerRequest: z.literal(4096),
        maximumProviderRequests: z.literal(DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS),
        maximumReportedTotalTokens: z.literal(DS0_ACTOR_MAXIMUM_REPORTED_TOKENS),
      })
      .passthrough(),
    experimentId: z.literal(DS0_EXPERIMENT_ID),
    pricing: z
      .object({
        pricingSha256: sha256,
        snapshotRef: z.literal("pricing-snapshot.json"),
      })
      .passthrough(),
    protocolSha256: sha256,
    provider: z
      .object({
        apiFormat: z.literal("openai-completions"),
        baseUrl: z.literal(DS0_BASE_URL),
        credentialEnvironmentVariable: z.literal("DEEPSEEK_API_KEY"),
        credentialPersistence: z.literal("forbidden"),
        id: z.literal(DS0_PROVIDER),
        modelAlias: z.literal(DS0_MODEL),
        reasoningControl: z
          .object({
            piOption: z.literal("off"),
            reasoningEffortParameter: z.literal("omitted"),
            wireField: z.literal("thinking.type"),
            wireValue: z.literal("disabled"),
          })
          .strict(),
        stream: z.literal(true),
        toolChoice: z.literal("auto"),
      })
      .passthrough(),
    schemaVersion: z.literal(1),
  })
  .passthrough();

export type Ds0PriceBand = Readonly<{
  readonly cachedInput: number;
  readonly output: number;
  readonly uncachedInput: number;
}>;

export interface Ds0Contract {
  readonly actorConservativePeakUpperBoundUsdMicros: number;
  readonly actorMaximumEstimatedCostUsdMicros: number;
  readonly offPeak: Ds0PriceBand;
  readonly peak: Ds0PriceBand;
  readonly peakIntervals: readonly Readonly<{
    readonly endExclusive: string;
    readonly startInclusive: string;
  }>[];
  readonly peakWeekdays: readonly string[];
  readonly pricingSha256: string;
  readonly pricingSnapshotId: string;
  readonly protocolSha256: string;
}

function identityWithoutField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string {
  return sha256Canonical(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)),
  );
}

export function ds0FixturePath(repositoryRoot: string, name: string): string {
  return join(
    repositoryRoot,
    "fixtures",
    "frontier-adapter-lab",
    "ds0-deepseek-tool-actor-v1",
    name,
  );
}

export async function readDs0Contract(
  repositoryRoot: string,
): Promise<Ds0Contract> {
  const [protocolText, pricingText] = await Promise.all([
    readFile(ds0FixturePath(repositoryRoot, "protocol.json"), "utf8"),
    readFile(ds0FixturePath(repositoryRoot, "pricing-snapshot.json"), "utf8"),
  ]);
  const protocolInput = parseStrictJson(protocolText);
  const pricingInput = parseStrictJson(pricingText);
  const protocol = protocolSchema.parse(protocolInput);
  const pricing = pricingSchema.parse(pricingInput);
  if (
    protocol.protocolSha256 !==
      identityWithoutField(protocolInput as Readonly<Record<string, unknown>>, "protocolSha256")
  ) {
    throw new Error("DS0 protocol hash verification failed");
  }
  if (
    pricing.pricingSha256 !==
      identityWithoutField(pricingInput as Readonly<Record<string, unknown>>, "pricingSha256")
  ) {
    throw new Error("DS0 pricing hash verification failed");
  }
  if (protocol.pricing.pricingSha256 !== pricing.pricingSha256) {
    throw new Error("DS0 protocol is not bound to the exact pricing snapshot");
  }
  if (
    protocol.caps.conservativePeakUpperBoundUsdMicros >
      protocol.caps.maximumEstimatedCostUsdMicros
  ) {
    throw new Error("DS0 actor peak bound exceeds its frozen actor cost ceiling");
  }
  return Object.freeze({
    actorConservativePeakUpperBoundUsdMicros:
      protocol.caps.conservativePeakUpperBoundUsdMicros,
    actorMaximumEstimatedCostUsdMicros:
      protocol.caps.maximumEstimatedCostUsdMicros,
    offPeak: Object.freeze({ ...pricing.offPeak }),
    peak: Object.freeze({ ...pricing.peak }),
    peakIntervals: Object.freeze(
      pricing.peakWindow.intervals.map((interval) => Object.freeze({ ...interval })),
    ),
    peakWeekdays: Object.freeze([...pricing.peakWindow.weekdays]),
    pricingSha256: pricing.pricingSha256,
    pricingSnapshotId: pricing.snapshotId,
    protocolSha256: protocol.protocolSha256,
  });
}
