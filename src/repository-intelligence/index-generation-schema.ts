import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { sha256Schema } from "./navigation-types.js";

export const indexGenerationSchema = z
  .object({
    counts: z.object({
      failed: z.number().int().nonnegative(),
      indexed: z.number().int().nonnegative(),
      references: z.number().int().nonnegative(),
      symbols: z.number().int().nonnegative(),
      units: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
    }).strict(),
    coverage: z.enum(["complete", "partial"]),
    engineIdentitySha256: sha256Schema,
    generationSha256: sha256Schema,
    referencesSha256: sha256Schema,
    ruleManifestSha256: sha256Schema,
    schemaVersion: z.literal(1),
    sourceStateSha256: sha256Schema,
    symbolsSha256: sha256Schema,
    unitsSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      counts: value.counts,
      coverage: value.coverage,
      engineIdentitySha256: value.engineIdentitySha256,
      referencesSha256: value.referencesSha256,
      ruleManifestSha256: value.ruleManifestSha256,
      schemaVersion: value.schemaVersion,
      sourceStateSha256: value.sourceStateSha256,
      symbolsSha256: value.symbolsSha256,
      unitsSha256: value.unitsSha256,
    };
    if (sha256Canonical(unsigned) !== value.generationSha256) {
      context.addIssue({ code: "custom", message: "index generation hash mismatch" });
    }
    if (value.counts.indexed + value.counts.failed + value.counts.unsupported > value.counts.units) {
      context.addIssue({ code: "custom", message: "index generation unit counts are inconsistent" });
    }
    if (value.coverage === "complete" && (value.counts.failed > 0 || value.counts.unsupported > 0)) {
      context.addIssue({ code: "custom", message: "complete index generation cannot contain failed or unsupported units" });
    }
  });

export type IndexGenerationV1 = Readonly<z.infer<typeof indexGenerationSchema>>;

export function createIndexGeneration(
  input: Omit<IndexGenerationV1, "generationSha256" | "schemaVersion">,
): IndexGenerationV1 {
  const unsigned = { ...input, schemaVersion: 1 as const };
  return indexGenerationSchema.parse({ ...unsigned, generationSha256: sha256Canonical(unsigned) });
}
