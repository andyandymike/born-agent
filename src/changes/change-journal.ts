import type { PatchChangeKind, PatchPlan } from "./patch-types.js";

export interface ChangeJournalEntry {
  readonly addedLines: number;
  readonly appliedAt: string;
  readonly diff: string;
  readonly kind: PatchChangeKind;
  readonly path: string;
  readonly planId: string;
  readonly postimage: Buffer;
  readonly postimageSha256: string;
  readonly preimage: Buffer;
  readonly preimageSha256: string;
  readonly removedLines: number;
}

function clone(entry: ChangeJournalEntry): ChangeJournalEntry {
  return {
    ...entry,
    postimage: Buffer.from(entry.postimage),
    preimage: Buffer.from(entry.preimage),
  };
}

export class ChangeJournal {
  private readonly recorded: ChangeJournalEntry[] = [];

  recordAppliedPlan(plan: PatchPlan, appliedAt: string): void {
    // PHASE5: journal 只使用本次 run 亲眼见到的 pre/post snapshot；`git diff HEAD`
    // 会混入用户原有 dirty changes，不能拿来冒充 Agent 的修改归因。
    for (const file of plan.files) {
      this.recorded.push({
        addedLines: file.addedLines,
        appliedAt,
        diff: file.diff,
        kind: file.kind,
        path: file.relativePath,
        planId: plan.planId,
        postimage: Buffer.from(file.postimage),
        postimageSha256: file.postimageSha256,
        preimage: Buffer.from(file.preimage),
        preimageSha256: file.preimageSha256,
        removedLines: file.removedLines,
      });
    }
  }

  entries(): readonly ChangeJournalEntry[] {
    return this.recorded.map(clone);
  }

  changedPaths(): readonly string[] {
    return [...new Set(this.recorded.map((entry) => entry.path))];
  }
}
