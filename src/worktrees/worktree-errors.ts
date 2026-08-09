export type WorktreeErrorCode =
  | "worktree_approval_denied"
  | "worktree_allocation_stale"
  | "worktree_git_unavailable"
  | "worktree_identity_stale"
  | "worktree_operation_incomplete"
  | "worktree_origin_verification_unavailable"
  | "worktree_path_unsafe"
  | "worktree_promotion_stale"
  | "worktree_promotion_unsupported"
  | "worktree_source_dirty_unapproved";

const exitCodes: Readonly<Record<WorktreeErrorCode, 1 | 2 | 3 | 8>> = Object.freeze({
  worktree_approval_denied: 2,
  worktree_allocation_stale: 8,
  worktree_git_unavailable: 3,
  worktree_identity_stale: 8,
  worktree_operation_incomplete: 8,
  worktree_origin_verification_unavailable: 8,
  worktree_path_unsafe: 8,
  worktree_promotion_stale: 8,
  worktree_promotion_unsupported: 8,
  worktree_source_dirty_unapproved: 8,
});

export class WorktreeError extends Error {
  override readonly name = "WorktreeError";
  readonly exitCode: 1 | 2 | 3 | 8;

  constructor(readonly code: WorktreeErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.exitCode = exitCodes[code];
  }
}
