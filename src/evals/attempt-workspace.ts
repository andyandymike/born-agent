import { createHash } from "node:crypto";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { assertCanonicalEvalRelativePath } from "./eval-path.js";

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "junction" | "special";

export interface WorkspaceInputEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly bytes?: Uint8Array;
}

export interface WorkspaceContentEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface WorkspaceContentManifest {
  readonly schemaVersion: 1;
  readonly files: readonly WorkspaceContentEntry[];
  readonly sourceStateSha256: string;
}

export const EVAL_GIT_BASELINE = Object.freeze({
  initialBranch: "main",
  userName: "BornAgent Eval",
  userEmail: "eval@invalid",
  coreAutocrlf: false,
  coreFilemode: false,
  commitGpgsign: false,
  authorDate: "2000-01-01T00:00:00Z",
  committerDate: "2000-01-01T00:00:00Z",
});

export const EVAL_GIT_BASELINE_SHA256 = sha256Canonical(EVAL_GIT_BASELINE);

function isPrivatePath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/") || path === ".bornagent" || path.startsWith(".bornagent/");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildWorkspaceContentManifest(entries: readonly WorkspaceInputEntry[]): WorkspaceContentManifest {
  const caseFolded = new Map<string, string>();
  const files: WorkspaceContentEntry[] = [];
  for (const entry of entries) {
    let path: string;
    try {
      path = assertCanonicalEvalRelativePath(entry.path, "workspace path");
    } catch (error) {
      throw new EvalCoreError("eval_workspace_invalid", "workspace contains traversal or a non-canonical path", 1, {
        cause: error,
      });
    }
    const folded = path.toLocaleLowerCase("en-US");
    const collision = caseFolded.get(folded);
    if (collision !== undefined && collision !== path) {
      throw new EvalCoreError("eval_workspace_invalid", `workspace case collision: ${collision} / ${path}`, 1);
    }
    caseFolded.set(folded, path);
    if (path === "grader" || path.startsWith("grader/")) {
      throw new EvalCoreError("eval_workspace_invalid", "grader bytes cannot exist in the Agent workspace", 1);
    }
    if (["symlink", "junction", "special"].includes(entry.kind)) {
      throw new EvalCoreError("eval_workspace_invalid", `unsupported workspace entry kind: ${entry.kind}`, 1);
    }
    if (entry.kind === "file") {
      if (entry.bytes === undefined) {
        throw new EvalCoreError("eval_workspace_invalid", `file has no bytes: ${path}`, 1);
      }
      if (!isPrivatePath(path)) {
        files.push(Object.freeze({ path, size: entry.bytes.byteLength, sha256: hashBytes(entry.bytes) }));
      }
    } else if (entry.bytes !== undefined) {
      throw new EvalCoreError("eval_workspace_invalid", `directory unexpectedly has bytes: ${path}`, 1);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const body = { schemaVersion: 1 as const, files: Object.freeze(files) };
  return Object.freeze({ ...body, sourceStateSha256: sha256Canonical(body) });
}

export function createFreshWorkspaceFiles(entries: readonly WorkspaceInputEntry[]): readonly WorkspaceInputEntry[] {
  buildWorkspaceContentManifest(entries);
  // PHASE14: every repetition clones fresh bytes so one attempt cannot mutate the fixture, its sibling, or a later repetition.
  return Object.freeze(
    entries
      .filter((entry) => !isPrivatePath(entry.path))
      .map((entry) =>
        Object.freeze({
          path: entry.path,
          kind: entry.kind,
          ...(entry.bytes === undefined ? {} : { bytes: entry.bytes.slice() }),
        }),
      ),
  );
}

export function isAgentVisibleWorkspacePath(path: string): boolean {
  assertCanonicalEvalRelativePath(path, "workspace path");
  // PHASE14: the fixed Git commit proves the fresh baseline, while `.git/` remains outside Agent access, source digests, and candidate diffs.
  return !isPrivatePath(path) && path !== "grader" && !path.startsWith("grader/");
}
