import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";

const nullableRate = z.number().nonnegative().finite().nullable();
const entrySchema = z
  .object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(512),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    currency: z.literal("USD"),
    inputPerMillion: nullableRate,
    outputPerMillion: nullableRate,
    cacheReadPerMillion: nullableRate,
    cacheWritePerMillion: nullableRate,
    sourceUrl: z.string().url(),
  })
  .strict();

const catalogSchema = z
  .object({
    schema_version: z.literal(1),
    catalog_version: z.number().int().positive(),
    reviewed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    entries: z.array(entrySchema).max(10_000),
  })
  .strict();

export type PriceCatalogEntry = z.infer<typeof entrySchema>;
export type PriceCatalog = z.infer<typeof catalogSchema>;

export interface LoadedPriceCatalog {
  readonly catalog: PriceCatalog;
  readonly catalogSha256: string;
}

export function loadPriceCatalog(input: unknown): LoadedPriceCatalog {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_manifest_invalid", "price catalog fixture is invalid", 1, { cause: parsed.error });
  }
  const keys = parsed.data.entries.map((entry) => `${entry.provider}\0${entry.model}\0${entry.effectiveDate}`);
  if (new Set(keys).size !== keys.length) {
    throw new EvalCoreError("eval_harness_invariant", "price catalog contains duplicate exact entries", 1);
  }
  return Object.freeze({ catalog: Object.freeze(parsed.data), catalogSha256: sha256Canonical(parsed.data) });
}

export function estimateSyntheticProviderCost(input: {
  readonly entry: PriceCatalogEntry;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}): number | null {
  // PHASE14: pricing is an offline calculation over complete compatible evidence; missing usage/rates remain null and never authorize provider traffic.
  const pairs = [
    [input.inputTokens, input.entry.inputPerMillion],
    [input.outputTokens, input.entry.outputPerMillion],
    [input.cacheReadTokens, input.entry.cacheReadPerMillion],
    [input.cacheWriteTokens, input.entry.cacheWritePerMillion],
  ] as const;
  if (pairs.some(([tokens, rate]) => tokens === null || rate === null)) return null;
  return pairs.reduce((total, [tokens, rate]) => total + ((tokens ?? 0) * (rate ?? 0)) / 1_000_000, 0);
}
