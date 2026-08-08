import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { repositoryEngineIdentityV1Schema } from "../engine-identity.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const legacyRepositoryEngineIdentitySchema = z
  .object({
    adapter: z.string().min(1),
    engine: z.string().min(1),
    packageName: z.string().min(1).nullable(),
    packageVersion: z.string().min(1).nullable(),
    protocolVersion: z.number().int().positive(),
  })
  .strict();

export const repositoryEngineIdentitySchema = z.union([
  legacyRepositoryEngineIdentitySchema,
  repositoryEngineIdentityV1Schema,
]);

export type RepositoryEngineIdentity = Readonly<z.infer<typeof repositoryEngineIdentitySchema>>;

export const repositoryEngineDecisionSchema = z
  .object({
    baselineReportSha256: sha256Schema,
    candidateReportSha256: sha256Schema,
    contextReductionGatePassed: z.boolean(),
    correctnessGatePassed: z.boolean(),
    decisionSha256: sha256Schema,
    engineIdentity: repositoryEngineIdentitySchema,
    freshnessGatePassed: z.boolean(),
    schemaVersion: z.literal(1),
    securityGatePassed: z.boolean(),
    status: z.enum(["accepted", "rejected"]),
    suiteSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      baselineReportSha256: value.baselineReportSha256,
      candidateReportSha256: value.candidateReportSha256,
      contextReductionGatePassed: value.contextReductionGatePassed,
      correctnessGatePassed: value.correctnessGatePassed,
      engineIdentity: value.engineIdentity,
      freshnessGatePassed: value.freshnessGatePassed,
      schemaVersion: value.schemaVersion,
      securityGatePassed: value.securityGatePassed,
      status: value.status,
      suiteSha256: value.suiteSha256,
    };
    if (sha256Canonical(unsigned) !== value.decisionSha256) {
      context.addIssue({ code: "custom", message: "engine decision hash mismatch" });
    }
    const allPassed =
      value.correctnessGatePassed &&
      value.freshnessGatePassed &&
      value.contextReductionGatePassed &&
      value.securityGatePassed;
    if ((value.status === "accepted") !== allPassed) {
      context.addIssue({ code: "custom", message: "accepted status requires every engine gate" });
    }
  });

export type RepositoryEngineDecisionV1 = Readonly<z.infer<typeof repositoryEngineDecisionSchema>>;

export function createRepositoryEngineDecision(
  input: Omit<RepositoryEngineDecisionV1, "decisionSha256" | "schemaVersion" | "status">,
): RepositoryEngineDecisionV1 {
  const status =
    input.correctnessGatePassed &&
    input.freshnessGatePassed &&
    input.contextReductionGatePassed &&
    input.securityGatePassed
      ? "accepted"
      : "rejected";
  const unsigned = { ...input, schemaVersion: 1 as const, status };
  return repositoryEngineDecisionSchema.parse({ ...unsigned, decisionSha256: sha256Canonical(unsigned) });
}
