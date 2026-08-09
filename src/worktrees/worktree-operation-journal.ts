import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../system/strict-json.js";
import { WorktreeError } from "./worktree-errors.js";

const operationRecordSchema = z.object({
  allocationPlanSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  graphId: z.string().uuid(),
  nonce: z.string().uuid(),
  operationId: z.string().uuid(),
  phase: z.enum(["requested", "git_added", "locked", "seeded", "failed"]),
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  workspaceId: z.string().uuid(),
}).strict();

export type WorktreeOperationRecordV1 = Readonly<z.infer<typeof operationRecordSchema>>;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class WorktreeOperationJournal {
  constructor(private readonly directory: string) {}

  async read(operationId: string): Promise<WorktreeOperationRecordV1 | null> {
    const path = join(this.directory, `${operationId}.json`);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 16 * 1024) {
        throw new WorktreeError("worktree_operation_incomplete", "worktree operation record is unsafe");
      }
      return Object.freeze(operationRecordSchema.parse(parseStrictJson(await readFile(path, "utf8"))));
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof WorktreeError) throw error;
      throw new WorktreeError("worktree_operation_incomplete", "worktree operation record is invalid", { cause: error });
    }
  }

  async write(record: WorktreeOperationRecordV1): Promise<void> {
    const validated = operationRecordSchema.parse(record);
    const path = join(this.directory, `${record.operationId}.json`);
    const temporary = join(this.directory, `.${record.operationId}.${record.nonce}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new WorktreeError("worktree_operation_incomplete", "could not commit worktree operation record", { cause: error });
    }
  }
}
