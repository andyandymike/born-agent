import { sha256Canonical } from "./canonical-json.js";
import type {
  SnapshotFileDigest,
  VerificationSnapshot,
} from "./completion-types.js";

function sortedDigests(
  entries: readonly SnapshotFileDigest[],
): readonly SnapshotFileDigest[] {
  return [...entries]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function verificationSnapshotForDigest(
  snapshot: VerificationSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    changedFiles: sortedDigests(snapshot.changedFiles),
    commandInputs: sortedDigests(snapshot.commandInputs),
    deletedFiles: [],
    generation: snapshot.generation,
    gitHeadSha256: snapshot.gitHeadSha256,
    gitIndexSha256: snapshot.gitIndexSha256,
    journalSha256: snapshot.journalSha256,
    packageScriptSha256: snapshot.packageScriptSha256,
    sourceStateSha256: snapshot.sourceStateSha256,
  };
}

export function hashVerificationSnapshot(
  snapshot: VerificationSnapshot,
): string {
  return sha256Canonical(verificationSnapshotForDigest(snapshot));
}

export function verificationSnapshotsEqual(
  left: VerificationSnapshot,
  right: VerificationSnapshot,
): boolean {
  return hashVerificationSnapshot(left) === hashVerificationSnapshot(right);
}
