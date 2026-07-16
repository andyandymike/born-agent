import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";

import { MutationPathPolicy } from "../changes/mutation-path-policy.js";
import { PatchOperationError } from "../changes/patch-types.js";
import type {
  PatchFileObservation,
  PatchObservationReader,
} from "./patch-reconciler.js";

function mappedFailure(path: string, error: unknown): PatchFileObservation {
  if (error instanceof PatchOperationError) {
    if (error.code === "patch_target_not_found") {
      return { kind: "missing", path };
    }
    if (error.code === "patch_symlink_denied") {
      return { kind: "symlink", path };
    }
    if (
      error.code === "patch_parent_not_directory" ||
      error.code === "patch_target_not_regular_file"
    ) {
      return { kind: "other", path };
    }
  }
  return { kind: "unreadable", path };
}

function sameIdentity(
  expected: { readonly device: number; readonly inode: number; readonly mode: number },
  actual: { readonly dev: number; readonly ino: number; readonly mode: number },
): boolean {
  return (
    expected.device === actual.dev &&
    expected.inode === actual.ino &&
    expected.mode === actual.mode
  );
}

export class WorkspacePatchObservationReader implements PatchObservationReader {
  private constructor(private readonly paths: MutationPathPolicy) {}

  static async create(
    workspace: string,
    options: { readonly caseInsensitive?: boolean } = {},
  ): Promise<WorkspacePatchObservationReader> {
    return new WorkspacePatchObservationReader(
      await MutationPathPolicy.create(workspace, options),
    );
  }

  async observe(path: string): Promise<PatchFileObservation> {
    let target;
    try {
      target = await this.paths.resolve(path, "modify");
    } catch (error) {
      if (
        error instanceof PatchOperationError &&
        error.code === "patch_target_not_found"
      ) {
        try {
          // A create resolution proves that the missing lexical target and all
          // existing parents remain inside the non-link workspace boundary.
          await this.paths.resolve(path, "create");
          return { kind: "missing", path };
        } catch (createError) {
          return mappedFailure(path, createError);
        }
      }
      return mappedFailure(path, error);
    }
    if (target.identity === null) return { kind: "unreadable", path };

    try {
      const handle = await open(target.absolutePath, "r");
      try {
        const before = await handle.stat();
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const named = await lstat(target.absolutePath);
        if (
          named.isSymbolicLink() ||
          !before.isFile() ||
          !after.isFile() ||
          !named.isFile() ||
          !sameIdentity(target.identity, before) ||
          !sameIdentity(target.identity, after) ||
          !sameIdentity(target.identity, named)
        ) {
          return { kind: "unreadable", path };
        }
        // PHASE9: reconciliation is a read-only proof over the exact file
        // identity validated by the mutation policy. It never repairs, rolls
        // back, or executes the interrupted patch while collecting hashes.
        return {
          bytesSha256: createHash("sha256").update(bytes).digest("hex"),
          kind: "file",
          path,
        };
      } finally {
        await handle.close();
      }
    } catch {
      return { kind: "unreadable", path };
    }
  }
}
