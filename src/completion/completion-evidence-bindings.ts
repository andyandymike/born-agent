import type {
  CompletionEvidence,
  IncompleteEvidence,
} from "./completion-types.js";

type Evidence = CompletionEvidence | IncompleteEvidence;

export interface CompletionDiffStat {
  readonly added_lines: number;
  readonly removed_lines: number;
}

export interface CompletedPatchFiles {
  readonly files: readonly {
    readonly path: string;
    readonly post_sha256: string;
    readonly pre_sha256: string | null;
  }[];
}

export function evidenceChangedPaths(evidence: Evidence): readonly string[] {
  return Object.freeze(evidence.changedByRun.map((change) => change.path).sort());
}

export function evidenceDiffStat(evidence: Evidence): CompletionDiffStat {
  return Object.freeze({
    added_lines: evidence.changedByRun.reduce(
      (sum, change) => sum + change.addedLines,
      0,
    ),
    removed_lines: evidence.changedByRun.reduce(
      (sum, change) => sum + change.removedLines,
      0,
    ),
  });
}

export function netChangedPaths(
  completions: readonly CompletedPatchFiles[],
): readonly string[] {
  const paths = new Map<
    string,
    { readonly firstPreimage: string | null; latestPostimage: string }
  >();
  for (const completion of completions) {
    for (const file of completion.files) {
      const existing = paths.get(file.path);
      if (existing === undefined) {
        paths.set(file.path, {
          firstPreimage: file.pre_sha256,
          latestPostimage: file.post_sha256,
        });
      } else {
        existing.latestPostimage = file.post_sha256;
      }
    }
  }
  // PHASE7: completion paths describe the run's net first-preimage to latest-
  // postimage effect. A later patch that restores the original bytes is not work.
  return Object.freeze(
    [...paths.entries()]
      .filter(([, image]) => image.firstPreimage !== image.latestPostimage)
      .map(([path]) => path)
      .sort(),
  );
}

export function sameDiffStat(
  left: CompletionDiffStat | undefined,
  right: CompletionDiffStat,
): boolean {
  return left?.added_lines === right.added_lines &&
    left.removed_lines === right.removed_lines;
}

export function samePaths(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}
