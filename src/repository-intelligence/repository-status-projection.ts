import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import type { RepositoryInvalidation } from "./repository-invalidation-watcher.js";
import type { RepositoryJobState } from "./repository-job-state.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const reasonSchema = z.string().regex(/^[a-z0-9_]{1,128}$/u);

const repositoryStatusWithoutHashSchema = z
  .object({
    buildPhase: z.enum(["snapshot", "rules", "index", "verify"]).nullable(),
    coverage: z.enum(["complete", "partial", "unsupported"]).nullable(),
    engineId: z.string().min(1).max(128).nullable(),
    engineIdentitySha256: sha256Schema.nullable(),
    generationSha256: sha256Schema.nullable(),
    indexState: z.enum(["idle", "dirty", "building", "ready", "blocked", "degraded"]),
    reason: reasonSchema.nullable(),
    ruleManifestSha256: sha256Schema.nullable(),
    schemaVersion: z.literal(1),
    sourceStateSha256: sha256Schema.nullable(),
    watchState: z.enum(["available", "not_started", "unavailable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.indexState === "building") !== (value.buildPhase !== null)) {
      context.addIssue({ code: "custom", message: "only a building repository status has a build phase" });
    }
    if (["dirty", "blocked", "degraded"].includes(value.indexState) !== (value.reason !== null)) {
      context.addIssue({ code: "custom", message: "repository status reason does not match its state" });
    }
    if (
      value.indexState === "ready" &&
      (value.coverage === null ||
        value.engineId === null ||
        value.engineIdentitySha256 === null ||
        value.generationSha256 === null ||
        value.ruleManifestSha256 === null ||
        value.sourceStateSha256 === null)
    ) {
      context.addIssue({ code: "custom", message: "ready repository status requires exact identities" });
    }
  });

export const repositoryStatusProjectionSchema = repositoryStatusWithoutHashSchema
  .extend({ statusSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { statusSha256: _statusSha256, ...withoutHash } = value;
    void _statusSha256;
    if (sha256Canonical(repositoryStatusWithoutHashSchema.parse(withoutHash)) !== value.statusSha256) {
      context.addIssue({ code: "custom", message: "repository status hash does not match" });
    }
  });

export type RepositoryStatusProjection = Readonly<z.infer<typeof repositoryStatusProjectionSchema>>;
export type RepositoryStatusInput = Readonly<z.input<typeof repositoryStatusWithoutHashSchema>>;

export function buildRepositoryStatusProjection(input: RepositoryStatusInput): RepositoryStatusProjection {
  const withoutHash = repositoryStatusWithoutHashSchema.parse(input);
  return Object.freeze(repositoryStatusProjectionSchema.parse({
    ...withoutHash,
    statusSha256: sha256Canonical(withoutHash),
  }));
}

export function initialRepositoryStatusProjection(
  watchState: RepositoryStatusProjection["watchState"] = "not_started",
): RepositoryStatusProjection {
  return buildRepositoryStatusProjection({
    buildPhase: null,
    coverage: null,
    engineId: null,
    engineIdentitySha256: null,
    generationSha256: null,
    indexState: "idle",
    reason: null,
    ruleManifestSha256: null,
    schemaVersion: 1,
    sourceStateSha256: null,
    watchState,
  });
}

export function reduceRepositoryStatusEvent(
  current: RepositoryStatusProjection,
  event: DecodedRunEvent,
): RepositoryStatusProjection {
  const base = {
    buildPhase: current.buildPhase,
    coverage: current.coverage,
    engineId: current.engineId,
    engineIdentitySha256: current.engineIdentitySha256,
    generationSha256: current.generationSha256,
    indexState: current.indexState,
    reason: current.reason,
    ruleManifestSha256: current.ruleManifestSha256,
    schemaVersion: 1 as const,
    sourceStateSha256: current.sourceStateSha256,
    watchState: current.watchState,
  };
  switch (event.type) {
    case "repository.source.snapshot.captured":
      return buildRepositoryStatusProjection({
        ...base,
        indexState:
          current.generationSha256 !== null &&
          current.sourceStateSha256 !== event.data.source_state_sha256
            ? "dirty"
            : current.indexState,
        reason:
          current.generationSha256 !== null &&
          current.sourceStateSha256 !== event.data.source_state_sha256
            ? "source_changed"
            : current.reason,
        sourceStateSha256: event.data.source_state_sha256,
      });
    case "repository.rules.manifest.loaded":
      return buildRepositoryStatusProjection({
        ...base,
        indexState:
          current.generationSha256 !== null &&
          current.ruleManifestSha256 !== event.data.manifest_sha256
            ? "dirty"
            : current.indexState,
        reason:
          current.generationSha256 !== null &&
          current.ruleManifestSha256 !== event.data.manifest_sha256
            ? "rules_changed"
            : current.reason,
        ruleManifestSha256: event.data.manifest_sha256,
      });
    case "repository.rules.changed":
      return buildRepositoryStatusProjection({
        ...base,
        indexState: "blocked",
        reason: "repository_rules_changed",
      });
    case "repository.index.invalidated":
      return buildRepositoryStatusProjection({
        ...base,
        indexState: "dirty",
        reason: event.data.reason,
        sourceStateSha256: event.data.current_source_state_sha256,
      });
    case "repository.index.selected":
      return buildRepositoryStatusProjection({
        ...base,
        buildPhase: null,
        coverage: event.data.coverage,
        engineId: event.data.engine_id,
        engineIdentitySha256: event.data.engine_identity_sha256,
        generationSha256: event.data.generation_sha256,
        indexState: "ready",
        reason: null,
        ruleManifestSha256: event.data.rule_manifest_sha256,
        sourceStateSha256: event.data.source_state_sha256,
      });
    default:
      return current;
  }
}

export function projectHistoricalRepositoryStatus(
  events: readonly DecodedRunEvent[],
): RepositoryStatusProjection {
  return events.reduce(reduceRepositoryStatusEvent, initialRepositoryStatusProjection());
}

export function withRepositoryWatchState(
  current: RepositoryStatusProjection,
  watchState: RepositoryStatusProjection["watchState"],
): RepositoryStatusProjection {
  const { statusSha256: _statusSha256, ...withoutHash } = current;
  void _statusSha256;
  return buildRepositoryStatusProjection({ ...withoutHash, watchState });
}

export function invalidateRepositoryStatus(
  current: RepositoryStatusProjection,
  invalidation: RepositoryInvalidation,
): RepositoryStatusProjection {
  if (current.indexState === "blocked") return current;
  const { statusSha256: _statusSha256, ...withoutHash } = current;
  void _statusSha256;
  return buildRepositoryStatusProjection({
    ...withoutHash,
    buildPhase: null,
    indexState: "dirty",
    reason: `${invalidation.kind}_changed`,
  });
}

export function applyRepositoryJobState(
  current: RepositoryStatusProjection,
  job: RepositoryJobState,
): RepositoryStatusProjection {
  const { statusSha256: _statusSha256, ...withoutHash } = current;
  void _statusSha256;
  switch (job.kind) {
    case "idle":
      return buildRepositoryStatusProjection({
        ...withoutHash,
        buildPhase: null,
        indexState: "idle",
        reason: null,
      });
    case "dirty":
      return current.indexState === "blocked"
        ? current
        : buildRepositoryStatusProjection({
            ...withoutHash,
            buildPhase: null,
            indexState: "dirty",
            reason: "repository_dirty",
          });
    case "building":
      return buildRepositoryStatusProjection({
        ...withoutHash,
        buildPhase: job.phase,
        indexState: "building",
        reason: null,
      });
    case "ready":
      // The exact live status returned after verification supplies the remaining
      // identities. Do not synthesize a ready projection from progress alone.
      return current;
    case "blocked":
      return buildRepositoryStatusProjection({
        ...withoutHash,
        buildPhase: null,
        indexState: "blocked",
        reason: /^[a-z0-9_]{1,128}$/u.test(job.code) ? job.code : "repository_refresh_failed",
      });
    case "degraded":
      return current.indexState === "blocked" || current.indexState === "dirty"
        ? current
        : buildRepositoryStatusProjection({
            ...withoutHash,
            buildPhase: null,
            indexState: "degraded",
            reason: /^[a-z0-9_]{1,128}$/u.test(job.code) ? job.code : "repository_watch_unavailable",
          });
  }
}
