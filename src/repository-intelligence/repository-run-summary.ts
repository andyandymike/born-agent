import { z } from "zod";

import type { ReconstructedRunProjection } from "../sessions/reconstruct-multi-run-session.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const navigationToolNames = new Set([
  "find_references",
  "find_symbol",
  "repository_outline",
]);

export const repositoryIntelligenceRunSummarySchema = z
  .object({
    coverage: z.enum(["complete", "partial", "unsupported"]),
    degradedReasons: z
      .array(z.string().regex(/^[a-z0-9_]{1,128}$/u))
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    engineIdentitySha256: sha256Schema,
    finalGenerationSha256: sha256Schema,
    queries: z
      .object({
        outline: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        symbol: z.number().int().nonnegative(),
      })
      .strict(),
    ruleManifestSha256: sha256Schema,
    sourceStateSha256: sha256Schema,
    staleRecoveries: z.number().int().nonnegative(),
  })
  .strict();

export type RepositoryIntelligenceRunSummary = Readonly<
  z.infer<typeof repositoryIntelligenceRunSummarySchema>
>;

export function projectRepositoryIntelligenceRunSummary(
  run: ReconstructedRunProjection | null,
): RepositoryIntelligenceRunSummary | null {
  // PHASE17: this projection summarizes durable retrieval usage only. It is
  // deliberately absent for legacy runs and never participates in completion.
  if (run === null || run.started.data.agent_mode === undefined) return null;
  const selected = [...run.events]
    .reverse()
    .find((event) => event.type === "repository.index.selected");
  if (selected?.type !== "repository.index.selected") return null;

  const queries = { outline: 0, references: 0, symbol: 0 };
  const degradedReasons: string[] = [];
  const addReason = (reason: string | undefined) => {
    if (
      reason !== undefined &&
      /^[a-z0-9_]{1,128}$/u.test(reason) &&
      !degradedReasons.includes(reason) &&
      degradedReasons.length < 16
    ) {
      degradedReasons.push(reason);
    }
  };
  for (const event of run.events) {
    if (
      event.type !== "tool.call.completed" &&
      event.type !== "tool.call.recovered"
    ) {
      continue;
    }
    if (!navigationToolNames.has(event.data.tool_name)) continue;
    if (event.data.tool_name === "repository_outline") queries.outline += 1;
    if (event.data.tool_name === "find_symbol") queries.symbol += 1;
    if (event.data.tool_name === "find_references") queries.references += 1;
    if (event.data.status === "error") addReason(event.data.error_code);
  }
  const staleRecoveries = run.events.filter(
    (event) =>
      event.type === "repository.index.invalidated" &&
      event.sessionSeq < selected.sessionSeq,
  ).length;
  const unresolvedInvalidation = [...run.events]
    .reverse()
    .find(
      (event) =>
        event.type === "repository.index.invalidated" ||
        event.type === "repository.index.selected",
    );
  if (unresolvedInvalidation?.type === "repository.index.invalidated") {
    addReason(`repository_${unresolvedInvalidation.data.reason}`);
  }

  return Object.freeze(
    repositoryIntelligenceRunSummarySchema.parse({
      coverage: selected.data.coverage,
      degradedReasons,
      engineIdentitySha256: selected.data.engine_identity_sha256,
      finalGenerationSha256: selected.data.generation_sha256,
      queries,
      ruleManifestSha256: selected.data.rule_manifest_sha256,
      sourceStateSha256: selected.data.source_state_sha256,
      staleRecoveries,
    }),
  );
}
