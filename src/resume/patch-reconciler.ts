import type { PendingPatchEffect } from "./resume-types.js";

export type PatchFileObservation =
  | {
      readonly bytesSha256: string;
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly kind: "missing" | "other" | "symlink" | "unreadable";
      readonly path: string;
    };

export interface PatchObservationReader {
  observe(path: string): Promise<PatchFileObservation>;
}

export type PatchReconciliationBlockReason =
  | "duplicate_path"
  | "invalid_hash_evidence"
  | "missing_observation"
  | "missing_postimage_hash"
  | "missing_target"
  | "mixed_state"
  | "symlink_target"
  | "third_state"
  | "unreadable_target"
  | "unsupported_target";

export interface ReconciledPatchFile {
  readonly kind: "create" | "modify";
  readonly path: string;
  readonly postSha256: string;
  readonly preSha256: string | null;
}

export type PatchReconciliation =
  | {
      readonly files: readonly ReconciledPatchFile[];
      readonly observed: "applied" | "not_applied";
      readonly planId: string;
      readonly status: "reconciled";
    }
  | {
      readonly details: readonly string[];
      readonly planId: string;
      readonly reason: PatchReconciliationBlockReason;
      readonly status: "blocked";
    };

function blocked(
  effect: PendingPatchEffect,
  reason: PatchReconciliationBlockReason,
  details: readonly string[],
): PatchReconciliation {
  return Object.freeze({
    details: Object.freeze([...details]),
    planId: effect.planId,
    reason,
    status: "blocked" as const,
  });
}

export function reconcilePendingPatch(
  effect: PendingPatchEffect,
  observations: readonly PatchFileObservation[],
): PatchReconciliation {
  const expectedPaths = new Set(effect.files.map((file) => file.path));
  if (expectedPaths.size !== effect.files.length) {
    return blocked(effect, "duplicate_path", [
      "patch start contains duplicate paths",
    ]);
  }
  const observedByPath = new Map<string, PatchFileObservation>();
  for (const observation of observations) {
    if (observedByPath.has(observation.path)) {
      return blocked(effect, "duplicate_path", [
        `more than one observation was supplied for ${observation.path}`,
      ]);
    }
    observedByPath.set(observation.path, observation);
  }

  const states: ("post" | "pre")[] = [];
  const journalFiles: ReconciledPatchFile[] = [];

  for (const file of effect.files) {
    if (file.postSha256 === null) {
      return blocked(effect, "missing_postimage_hash", [file.path]);
    }
    if (file.preSha256 === file.postSha256) {
      return blocked(effect, "invalid_hash_evidence", [file.path]);
    }
    const observation = observedByPath.get(file.path);
    if (observation === undefined) {
      return blocked(effect, "missing_observation", [file.path]);
    }
    if (observation.kind === "symlink") {
      return blocked(effect, "symlink_target", [file.path]);
    }
    if (observation.kind === "unreadable") {
      return blocked(effect, "unreadable_target", [file.path]);
    }
    if (observation.kind === "other") {
      return blocked(effect, "unsupported_target", [file.path]);
    }
    if (observation.kind === "missing") {
      if (file.preSha256 === null && file.kind === "create") {
        states.push("pre");
        journalFiles.push(Object.freeze({
          kind: file.kind,
          path: file.path,
          postSha256: file.postSha256,
          preSha256: file.preSha256,
        }));
        continue;
      }
      return blocked(effect, "missing_target", [file.path]);
    }
    if (observation.kind !== "file") {
      return blocked(effect, "unsupported_target", [file.path]);
    }
    if (observation.bytesSha256 === file.postSha256) {
      states.push("post");
    } else if (
      file.preSha256 !== null &&
      observation.bytesSha256 === file.preSha256
    ) {
      states.push("pre");
    } else {
      return blocked(effect, "third_state", [file.path]);
    }
    journalFiles.push(Object.freeze({
      kind: file.kind,
      path: file.path,
      postSha256: file.postSha256,
      preSha256: file.preSha256,
    }));
  }

  const uniqueStates = new Set(states);
  if (uniqueStates.size !== 1) {
    return blocked(effect, "mixed_state", effect.files.map((file) => file.path));
  }
  const observed = states[0] === "post" ? "applied" : "not_applied";
  return Object.freeze({
    files: Object.freeze(journalFiles),
    observed,
    planId: effect.planId,
    status: "reconciled" as const,
  });
}

export async function reconcilePendingPatchFromReader(
  effect: PendingPatchEffect,
  reader: PatchObservationReader,
): Promise<PatchReconciliation> {
  const observations: PatchFileObservation[] = [];
  for (const file of effect.files) {
    // Read-only observations are deliberately completed before planning; this
    // helper never mutates, rolls back, or retries the patch.
    observations.push(await reader.observe(file.path));
  }
  return reconcilePendingPatch(effect, observations);
}
