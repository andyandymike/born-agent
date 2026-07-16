import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ChangeJournalEntry } from "../../src/changes/change-journal.js";
import { RunLocalDiffChecker } from "../../src/verification/run-local-diff-checker.js";

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function entry(options: {
  readonly kind?: "create" | "modify";
  readonly path: string;
  readonly planId?: string;
  readonly postimage: string;
  readonly preimage: string;
}): ChangeJournalEntry {
  const before = Buffer.from(options.preimage);
  const after = Buffer.from(options.postimage);
  return {
    addedLines: 1,
    appliedAt: "2026-07-17T00:00:00.000Z",
    diff: "untrusted original proposal is not reused by this checker\n",
    kind: options.kind ?? "modify",
    path: options.path,
    planId: options.planId ?? "plan-1",
    postimage: after,
    postimageSha256: sha(after),
    preimage: before,
    preimageSha256: sha(before),
    removedLines: options.kind === "create" ? 0 : 1,
  };
}

describe("Phase 7 exact run-local diff checker", () => {
  it("derives an exact apply-checked diff from journal images including created files", async () => {
    const checker = new RunLocalDiffChecker();
    const result = await checker.check([
      entry({ path: "src/value.ts", postimage: "new\n", preimage: "old\n" }),
      entry({
        kind: "create",
        path: "generated/结果.ts",
        postimage: "++ b/after/not-a-header\n",
        preimage: "",
      }),
    ]);

    expect(result.status, JSON.stringify(result)).toBe("passed");
    expect(result.checkedPaths).toEqual(["generated/结果.ts", "src/value.ts"]);
    expect(result.exactDiff).toContain("+++ b/generated/结果.ts");
    expect(result.exactDiff).toContain("+++ b/after/not-a-header");
    expect(result.exactDiff).toContain("-old");
    expect(result.exactDiff).toContain("+new");
    expect(result.addedLines).toBe(2);
    expect(result.removedLines).toBe(1);
  });

  it("rejects whitespace errors even when the proposed postimage is otherwise applicable", async () => {
    const result = await new RunLocalDiffChecker().check([
      entry({ path: "src/value.ts", postimage: "bad trailing space \n", preimage: "old\n" }),
    ]);

    expect(result).toMatchObject({
      errorCode: "diff_apply_check_failed",
      status: "failed",
    });
  });

  it("rejects a broken journal chain and a sequence with no net source change", async () => {
    const first = entry({ path: "src/value.ts", postimage: "middle\n", preimage: "old\n" });
    const broken = entry({
      path: "src/value.ts",
      planId: "plan-2",
      postimage: "new\n",
      preimage: "different\n",
    });
    await expect(new RunLocalDiffChecker().check([first, broken])).resolves.toMatchObject({
      errorCode: "journal_inconsistent",
      status: "failed",
    });

    const reverted = entry({
      path: "src/value.ts",
      planId: "plan-2",
      postimage: "old\n",
      preimage: "middle\n",
    });
    await expect(new RunLocalDiffChecker().check([first, reverted])).resolves.toMatchObject({
      errorCode: "no_run_local_changes",
      status: "failed",
    });
  });

  it("reports repeated edits as the exact net diff instead of cumulative churn", async () => {
    const middle = "middle-1\nmiddle-2\nmiddle-3\n";
    const result = await new RunLocalDiffChecker().check([
      entry({ path: "src/value.ts", postimage: middle, preimage: "old\n" }),
      entry({
        path: "src/value.ts",
        planId: "plan-2",
        postimage: "new\n",
        preimage: middle,
      }),
    ]);

    expect(result.status).toBe("passed");
    expect(result.fileStats).toEqual([
      { addedLines: 1, path: "src/value.ts", removedLines: 1 },
    ]);
    expect(result).toMatchObject({ addedLines: 1, removedLines: 1 });
  });
});
