import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ChangeJournal } from "./change-journal.js";
import type { PatchPlanner } from "./patch-planner.js";
import {
  PatchOperationError,
  type PatchApplyResult,
  type PatchPlan,
  type PlannedFileChange,
  patchOperationError,
  throwIfPatchAborted,
} from "./patch-types.js";
import { withWorkspaceMutationLock } from "./workspace-mutation-mutex.js";

interface WritableFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: Uint8Array): Promise<void>;
}

export interface AtomicPatchFileSystem {
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(path: string): Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  mkdir(path: string): Promise<void>;
  open(path: string, flags: "wx", mode: number): Promise<WritableFileHandle>;
  readFile(path: string): Promise<Buffer>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: AtomicPatchFileSystem = {
  lstat,
  link,
  async mkdir(path) {
    await mkdir(path);
  },
  open,
  readFile,
  rename,
  rmdir,
  unlink,
};

export interface AtomicPatchApplierOptions {
  readonly fileSystem?: AtomicPatchFileSystem;
  readonly journal?: ChangeJournal;
  readonly now?: () => Date;
  readonly planner: PatchPlanner;
  readonly randomId?: () => string;
}

interface ApplyStage {
  readonly backupPath: string;
  backupMoved: boolean;
  readonly change: PlannedFileChange;
  installed: boolean;
  readonly tempPath: string;
  tempWritten: boolean;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function uniqueMissingDirectories(plan: PatchPlan): readonly string[] {
  return [
    ...new Set(plan.files.flatMap((file) => file.parent.missingDirectories)),
  ].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

export class AtomicPatchApplier {
  readonly journal: ChangeJournal;
  private readonly fileSystem: AtomicPatchFileSystem;
  private readonly now: () => Date;
  private readonly planner: PatchPlanner;
  private readonly randomId: () => string;

  constructor(options: AtomicPatchApplierOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.journal = options.journal ?? new ChangeJournal();
    this.now = options.now ?? (() => new Date());
    this.planner = options.planner;
    this.randomId = options.randomId ?? randomUUID;
  }

  async apply(plan: PatchPlan, signal: AbortSignal): Promise<PatchApplyResult> {
    return withWorkspaceMutationLock(plan.workspaceRealPath, signal, async () => {
      return this.applyLocked(plan, signal);
    });
  }

  private async applyLocked(
    plan: PatchPlan,
    signal: AbortSignal,
  ): Promise<PatchApplyResult> {
    throwIfPatchAborted(signal);
    await this.planner.revalidate(plan, signal);

    const createdDirectories: string[] = [];
    const allowedCreatedDirectories = new Set<string>();
    const stages = this.createStages(plan);
    let targetsVerified = false;
    try {
      for (const directory of uniqueMissingDirectories(plan)) {
        throwIfPatchAborted(signal);
        try {
          await this.fileSystem.mkdir(directory);
        } catch (error) {
          throw patchOperationError(
            "invalid_arguments",
            "patch_stale",
            "a planned parent directory changed before apply",
            { cause: error },
          );
        }
        createdDirectories.push(directory);
        allowedCreatedDirectories.add(directory);
      }

      await this.planner.revalidate(plan, signal, allowedCreatedDirectories);
      for (const stage of stages) {
        throwIfPatchAborted(signal);
        await this.writeTemp(stage);
      }

      // PHASE5: 调用方必须在进入 apply 前先持久化 patch.apply.started。此处一旦移动
      // target/backup 就跨过 side-effect 边界；失败后无法证明状态时只能报告 unknown。
      await this.planner.revalidate(plan, signal, allowedCreatedDirectories);
      for (const stage of stages) {
        if (stage.change.kind === "modify") {
          await this.assertTargetAbsent(stage.backupPath);
          await this.fileSystem.rename(stage.change.absolutePath, stage.backupPath);
          stage.backupMoved = true;
        }
      }
      for (const stage of stages) {
        // PHASE5: hard-link installation has no replace semantics. A concurrent creator
        // wins with EEXIST instead of being silently overwritten by rename on Windows.
        await this.fileSystem.link(stage.tempPath, stage.change.absolutePath);
        stage.installed = true;
        await this.fileSystem.unlink(stage.tempPath);
        stage.tempWritten = false;
      }

      for (const stage of stages) {
        if (!(await this.matches(stage.change.absolutePath, stage.change.postimage))) {
          throw patchOperationError(
            "system",
            "patch_postcondition_failed",
            "applied patch did not match its planned postimage",
          );
        }
      }
      targetsVerified = true;
      for (const stage of stages) {
        if (stage.backupMoved) {
          if (!(await this.matches(stage.backupPath, stage.change.preimage))) {
            throw patchOperationError(
              "system",
              "ambiguous_patch_state",
              "patch backup no longer matches the approved preimage",
              { state: "unknown" },
            );
          }
          await this.fileSystem.unlink(stage.backupPath);
          stage.backupMoved = false;
        }
      }

      const appliedAt = this.now().toISOString();
      this.journal.recordAppliedPlan(plan, appliedAt);
      return {
        addedLines: plan.addedLines,
        appliedAt,
        files: plan.files.map((file) => ({
          kind: file.kind,
          path: file.relativePath,
          postimageSha256: file.postimageSha256,
          preimageSha256: file.preimageSha256,
        })),
        planId: plan.planId,
        removedLines: plan.removedLines,
      };
    } catch (error) {
      if (targetsVerified) {
        throw patchOperationError(
          "system",
          "ambiguous_patch_state",
          "patch targets were written but cleanup could not be proven complete; inspect the workspace",
          { cause: error, state: "unknown" },
        );
      }
      const restored = await this.rollback(stages, createdDirectories);
      if (!restored) {
        throw patchOperationError(
          "system",
          "ambiguous_patch_state",
          "patch apply failed while external changes made rollback unsafe; inspect the workspace",
          { cause: error, state: "unknown" },
        );
      }
      if (error instanceof PatchOperationError) {
        if (error.state === "unknown") {
          throw patchOperationError(
            "system",
            "ambiguous_patch_state",
            "patch apply reached an ambiguous state; inspect the workspace",
            { cause: error, state: "unknown" },
          );
        }
        throw error;
      }
      throw patchOperationError(
        "system",
        "patch_apply_failed",
        "patch apply failed and the approved preimages were restored",
        { cause: error },
      );
    }
  }

  private createStages(plan: PatchPlan): ApplyStage[] {
    return plan.files.map((change) => {
      const token = this.randomId();
      const parent = dirname(change.absolutePath);
      return {
        backupMoved: false,
        backupPath: join(parent, `.bornagent-backup-${token}`),
        change,
        installed: false,
        tempPath: join(parent, `.bornagent-apply-${token}`),
        tempWritten: false,
      };
    });
  }

  private async writeTemp(stage: ApplyStage): Promise<void> {
    const mode =
      stage.change.kind === "modify" && stage.change.identity !== null
        ? stage.change.identity.mode & 0o777
        : 0o666;
    let handle: WritableFileHandle | undefined;
    try {
      handle = await this.fileSystem.open(stage.tempPath, "wx", mode);
      await handle.writeFile(stage.change.postimage);
      await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      stage.tempWritten = true;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      throw patchOperationError(
        "system",
        "patch_temp_write_failed",
        "failed to prepare an atomic patch postimage",
        { cause: error },
      );
    }
  }

  private async assertTargetAbsent(path: string): Promise<void> {
    try {
      await this.fileSystem.lstat(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    throw patchOperationError(
      "system",
      "patch_internal_path_collision",
      "an internal patch staging path already exists",
    );
  }

  private async matches(path: string, expected: Buffer): Promise<boolean> {
    try {
      const metadata = await this.fileSystem.lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        return false;
      }
      return (await this.fileSystem.readFile(path)).equals(expected);
    } catch {
      return false;
    }
  }

  private async isAbsent(path: string): Promise<boolean> {
    try {
      await this.fileSystem.lstat(path);
      return false;
    } catch (error) {
      return isErrorCode(error, "ENOENT");
    }
  }

  private async rollback(
    stages: readonly ApplyStage[],
    createdDirectories: readonly string[],
  ): Promise<boolean> {
    let safe = true;
    for (const stage of [...stages].reverse()) {
      if (stage.installed) {
        if (await this.matches(stage.change.absolutePath, stage.change.postimage)) {
          try {
            await this.fileSystem.unlink(stage.change.absolutePath);
            stage.installed = false;
          } catch {
            safe = false;
          }
        } else {
          safe = false;
        }
      }

      if (stage.backupMoved && !stage.installed) {
        if (
          (await this.isAbsent(stage.change.absolutePath)) &&
          (await this.matches(stage.backupPath, stage.change.preimage))
        ) {
          try {
            await this.fileSystem.rename(
              stage.backupPath,
              stage.change.absolutePath,
            );
            stage.backupMoved = false;
          } catch {
            safe = false;
          }
        } else {
          safe = false;
        }
      }

      if (stage.tempWritten) {
        if (await this.matches(stage.tempPath, stage.change.postimage)) {
          try {
            await this.fileSystem.unlink(stage.tempPath);
            stage.tempWritten = false;
          } catch {
            safe = false;
          }
        } else {
          safe = false;
        }
      }
    }

    for (const directory of [...createdDirectories].reverse()) {
      try {
        await this.fileSystem.rmdir(directory);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          safe = false;
        }
      }
    }

    for (const stage of stages) {
      if (stage.change.kind === "modify") {
        if (!(await this.matches(stage.change.absolutePath, stage.change.preimage))) {
          safe = false;
        }
      } else if (!(await this.isAbsent(stage.change.absolutePath))) {
        safe = false;
      }
    }
    return safe;
  }
}
