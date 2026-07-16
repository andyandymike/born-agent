export const MAX_PATCH_BYTES = 16 * 1024;
export const MAX_PATCH_FILES = 8;
export const MAX_PATCH_CHANGED_LINES = 2_000;
export const MAX_PATCH_TARGET_BYTES = 1024 * 1024;
export const MAX_PATCH_PREVIEW_LINES = 200;
export const MAX_PATCH_PREVIEW_BYTES = 32 * 1024;

export type PatchErrorCategory =
  | "cancelled"
  | "invalid_arguments"
  | "limit"
  | "not_found"
  | "permission"
  | "system";

export type PatchMutationState = "unchanged" | "unknown";

export class PatchOperationError extends Error {
  readonly category: PatchErrorCategory;
  readonly code: string;
  readonly state: PatchMutationState;

  constructor(options: {
    readonly category: PatchErrorCategory;
    readonly code: string;
    readonly message: string;
    readonly cause?: unknown;
    readonly state?: PatchMutationState;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "PatchOperationError";
    this.category = options.category;
    this.code = options.code;
    this.state = options.state ?? "unchanged";
  }
}

export type HunkLineKind = "addition" | "context" | "deletion";

export interface ParsedHunkLine {
  readonly kind: HunkLineKind;
  readonly noNewline: boolean;
  readonly text: string;
}

export interface ParsedHunk {
  readonly lines: readonly ParsedHunkLine[];
  readonly newCount: number;
  readonly newStart: number;
  readonly oldCount: number;
  readonly oldStart: number;
}

export type PatchChangeKind = "create" | "modify";

export interface ParsedFilePatch {
  readonly addedLines: number;
  readonly diff: string;
  readonly hunks: readonly ParsedHunk[];
  readonly kind: PatchChangeKind;
  readonly path: string;
  readonly removedLines: number;
}

export interface ParsedPatch {
  readonly addedLines: number;
  readonly files: readonly ParsedFilePatch[];
  readonly normalizedPatch: string;
  readonly removedLines: number;
}

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export interface PlannedParentState {
  readonly existingAncestorAbsolutePath: string;
  readonly existingAncestorRealPath: string;
  readonly missingDirectories: readonly string[];
}

export interface PlannedFileChange {
  readonly absolutePath: string;
  readonly addedLines: number;
  readonly diff: string;
  readonly identity: FileIdentity | null;
  readonly kind: PatchChangeKind;
  readonly parent: PlannedParentState;
  readonly postimage: Buffer;
  readonly postimageSha256: string;
  readonly preimage: Buffer;
  readonly preimageSha256: string;
  readonly relativePath: string;
  readonly removedLines: number;
}

export interface PatchPlan {
  readonly addedLines: number;
  readonly files: readonly PlannedFileChange[];
  readonly normalizedPatch: string;
  readonly patchSha256: string;
  readonly planId: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly removedLines: number;
  readonly workspaceRealPath: string;
}

export interface AppliedFileChange {
  readonly kind: PatchChangeKind;
  readonly path: string;
  readonly postimageSha256: string;
  readonly preimageSha256: string;
}

export interface PatchApplyResult {
  readonly addedLines: number;
  readonly appliedAt: string;
  readonly files: readonly AppliedFileChange[];
  readonly planId: string;
  readonly removedLines: number;
}

export function patchOperationError(
  category: PatchErrorCategory,
  code: string,
  message: string,
  options: { readonly cause?: unknown; readonly state?: PatchMutationState } = {},
): PatchOperationError {
  return new PatchOperationError({
    category,
    code,
    message,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.state === undefined ? {} : { state: options.state }),
  });
}

export function throwIfPatchAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw patchOperationError(
      "cancelled",
      "patch_cancelled",
      "patch operation was cancelled",
    );
  }
}
