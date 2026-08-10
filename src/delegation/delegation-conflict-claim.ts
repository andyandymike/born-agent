import { sha256Canonical } from "../completion/canonical-json.js";
import { DelegationError } from "./delegation-errors.js";

export interface DelegationConflictClaimV1 {
  readonly schemaVersion: 1;
  readonly claimId: string;
  readonly groupId: string;
  readonly actorId: string;
  readonly repositoryId: string;
  readonly workspaceId: string | null;
  readonly sourceLineageId: string;
  readonly sourceSnapshotSha256: string;
  readonly access: "read" | "write";
  readonly canonicalPathPrefixes: readonly string[];
  readonly claimSha256: string;
}

function fold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function overlap(left: string, right: string): boolean {
  const a = fold(left);
  const b = fold(right);
  return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function createDelegationConflictClaim(
  input: Omit<DelegationConflictClaimV1, "schemaVersion" | "canonicalPathPrefixes" | "claimSha256"> & {
    readonly pathPrefixes: readonly string[];
  },
): DelegationConflictClaimV1 {
  const prefixes = [...new Set(input.pathPrefixes.map((value) => value.normalize("NFC")))].sort();
  if (prefixes.length === 0 || prefixes.length > 32) {
    throw new DelegationError("delegation_workspace_conflict", "conflict claim requires one to 32 canonical path prefixes");
  }
  const content = {
    schemaVersion: 1 as const,
    claimId: input.claimId,
    groupId: input.groupId,
    actorId: input.actorId,
    repositoryId: input.repositoryId,
    workspaceId: input.workspaceId,
    sourceLineageId: input.sourceLineageId,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    access: input.access,
    canonicalPathPrefixes: prefixes,
  };
  return Object.freeze({ ...content, claimSha256: sha256Canonical(content) });
}

export function delegationConflict(
  left: DelegationConflictClaimV1,
  right: DelegationConflictClaimV1,
): boolean {
  if (left.repositoryId !== right.repositoryId || left.sourceLineageId !== right.sourceLineageId) return false;
  if (left.access === "read" && right.access === "read") return false;
  const read = left.access === "read" ? left : right.access === "read" ? right : null;
  const write = left.access === "write" ? left : right.access === "write" ? right : null;
  if (
    read !== null && write !== null &&
    read.workspaceId === null && write.workspaceId !== null &&
    read.sourceSnapshotSha256 === write.sourceSnapshotSha256
  ) {
    // A read-only child is pinned to immutable origin snapshot bytes while a
    // coding child writes only its managed worktree. Promotion remains a
    // separate Phase 19 conflict gate, so these actors may safely overlap.
    return false;
  }
  // PHASE20: unknown/case-aliased/symlink-sensitive scope is conservatively a
  // conflict. Parallel admission is never inferred from model narrative.
  return left.canonicalPathPrefixes.some((a) => right.canonicalPathPrefixes.some((b) => overlap(a, b)));
}

export function assertConflictClaimAdmissible(
  candidate: DelegationConflictClaimV1,
  active: readonly DelegationConflictClaimV1[],
): void {
  if (active.some((claim) => delegationConflict(candidate, claim))) {
    throw new DelegationError("delegation_workspace_conflict", "delegation path claim overlaps an active actor");
  }
}
