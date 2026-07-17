import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { assertCanonicalEvalRelativePath } from "./eval-path.js";
import type { WorkspaceInputEntry } from "./attempt-workspace.js";

export interface EvalFileTree {
  readonly entries: readonly WorkspaceInputEntry[];
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  readonly contentSha256: string;
}

export interface EvalFileTreeOptions {
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly rejectPrivate?: boolean;
  readonly rejectGrader?: boolean;
}

function byteSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPrivate(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === ".bornagent" || relativePath.startsWith(".bornagent/");
}

export async function readEvalFileTree(root: string, options: EvalFileTreeOptions = {}): Promise<EvalFileTree> {
  const rootReal = await realpath(root).catch((error: unknown) => {
    throw new EvalCoreError("eval_workspace_invalid", "eval file-tree root is not readable", 1, { cause: error });
  });
  const entries: WorkspaceInputEntry[] = [];
  const files: { path: string; size: number; sha256: string }[] = [];
  const maxFiles = options.maxFiles ?? 10_000;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1_024 * 1_024;
  let totalBytes = 0;

  async function visit(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = assertCanonicalEvalRelativePath(prefix.length === 0 ? child.name : `${prefix}/${child.name}`, "eval asset path");
      if (options.rejectPrivate === true && isPrivate(relativePath)) {
        throw new EvalCoreError("eval_workspace_invalid", "eval fixture contains harness-private metadata", 1);
      }
      if (options.rejectGrader === true && (relativePath === "grader" || relativePath.startsWith("grader/"))) {
        throw new EvalCoreError("eval_workspace_invalid", "Agent workspace contains grader bytes", 1);
      }
      const absolute = path.join(directory, child.name);
      const metadata = await stat(absolute, { bigint: false });
      if (child.isSymbolicLink() || metadata.isSymbolicLink()) {
        throw new EvalCoreError("eval_workspace_invalid", `eval asset contains a symlink or junction: ${relativePath}`, 1);
      }
      const resolved = await realpath(absolute);
      const relativeResolved = path.relative(rootReal, resolved);
      if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
        throw new EvalCoreError("eval_workspace_invalid", `eval asset escapes its root: ${relativePath}`, 1);
      }
      if (child.isDirectory() && metadata.isDirectory()) {
        entries.push(Object.freeze({ path: relativePath, kind: "directory" }));
        await visit(absolute, relativePath);
        continue;
      }
      if (!child.isFile() || !metadata.isFile()) {
        throw new EvalCoreError("eval_workspace_invalid", `eval asset contains a special file: ${relativePath}`, 1);
      }
      const bytes = await readFile(absolute);
      totalBytes += bytes.byteLength;
      if (files.length + 1 > maxFiles || totalBytes > maxTotalBytes) {
        throw new EvalCoreError("eval_workspace_invalid", "eval asset exceeds bounded file-tree limits", 1);
      }
      entries.push(Object.freeze({ path: relativePath, kind: "file", bytes }));
      files.push(Object.freeze({ path: relativePath, size: bytes.byteLength, sha256: byteSha256(bytes) }));
    }
  }

  await visit(rootReal, "");
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.path.toLocaleLowerCase("en-US");
    const previous = folded.get(key);
    if (previous !== undefined && previous !== entry.path) {
      throw new EvalCoreError("eval_workspace_invalid", `eval asset case collision: ${previous} / ${entry.path}`, 1);
    }
    folded.set(key, entry.path);
  }
  const frozenFiles = Object.freeze(files);
  return Object.freeze({
    entries: Object.freeze(entries),
    files: frozenFiles,
    contentSha256: sha256Canonical({ schemaVersion: 1, files: frozenFiles }),
  });
}
