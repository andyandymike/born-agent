import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ChangeJournalEntry } from "../changes/change-journal.js";
import {
  NodeGitArgvRunner,
  type GitArgvRunner,
} from "./git-argv-runner.js";
import { normalizeWorkspaceRelativePath } from "./source-state-digest.js";

export type RunLocalDiffErrorCode =
  | "diff_apply_check_failed"
  | "diff_generation_failed"
  | "diff_postimage_mismatch"
  | "journal_inconsistent"
  | "no_run_local_changes"
  | "unsupported_run_local_binary";

export interface RunLocalDiffCheckResult {
  readonly addedLines: number;
  readonly checkedPaths: readonly string[];
  readonly detail: string;
  readonly diffSha256: string;
  readonly errorCode?: RunLocalDiffErrorCode;
  readonly exactDiff: string;
  readonly fileStats: readonly RunLocalDiffFileStat[];
  readonly removedLines: number;
  readonly status: "failed" | "passed";
}

export interface RunLocalDiffFileStat {
  readonly addedLines: number;
  readonly path: string;
  readonly removedLines: number;
}

interface NetJournalChange {
  readonly kind: "create" | "modify";
  readonly path: string;
  readonly postimage: Buffer;
  readonly postimageSha256: string;
  readonly preimage: Buffer;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function failed(
  code: RunLocalDiffErrorCode,
  detail: string,
  options: {
    readonly checkedPaths?: readonly string[];
    readonly exactDiff?: string;
    readonly fileStats?: readonly RunLocalDiffFileStat[];
  } = {},
): RunLocalDiffCheckResult {
  const exactDiff = options.exactDiff ?? "";
  return Object.freeze({
    addedLines: 0,
    checkedPaths: Object.freeze([...(options.checkedPaths ?? [])]),
    detail,
    diffSha256: sha256(exactDiff),
    errorCode: code,
    exactDiff,
    fileStats: Object.freeze([...(options.fileStats ?? [])]),
    removedLines: 0,
    status: "failed",
  });
}

function netChanges(
  entries: readonly ChangeJournalEntry[],
):
  | { readonly ok: true; readonly changes: readonly NetJournalChange[] }
  | {
      readonly ok: false;
      readonly code: RunLocalDiffErrorCode;
      readonly detail: string;
    } {
  const grouped = new Map<
    string,
    { first: ChangeJournalEntry; latest: ChangeJournalEntry }
  >();
  for (const entry of entries) {
    let path: string;
    try {
      path = normalizeWorkspaceRelativePath(entry.path);
    } catch {
      return {
        code: "journal_inconsistent",
        detail: "change journal contains an invalid path",
        ok: false,
      };
    }
    if (
      path !== entry.path ||
      path.toLowerCase() === ".git" ||
      path.toLowerCase().startsWith(".git/") ||
      path.toLowerCase() === ".bornagent" ||
      path.toLowerCase().startsWith(".bornagent/") ||
      sha256(entry.preimage) !== entry.preimageSha256 ||
      sha256(entry.postimage) !== entry.postimageSha256
    ) {
      return {
        code: "journal_inconsistent",
        detail: `change journal images or identity are inconsistent for ${entry.path}`,
        ok: false,
      };
    }
    if (entry.preimage.includes(0) || entry.postimage.includes(0)) {
      return {
        code: "unsupported_run_local_binary",
        detail: `run-local diff only accepts Phase 5 UTF-8 text images for ${entry.path}`,
        ok: false,
      };
    }
    const existing = grouped.get(path);
    if (existing === undefined) {
      if (entry.kind === "create" && entry.preimage.byteLength !== 0) {
        return {
          code: "journal_inconsistent",
          detail: `created file ${entry.path} has a non-empty preimage`,
          ok: false,
        };
      }
      grouped.set(path, { first: entry, latest: entry });
      continue;
    }
    if (existing.latest.postimageSha256 !== entry.preimageSha256) {
      return {
        code: "journal_inconsistent",
        detail: `change journal image chain is broken for ${entry.path}`,
        ok: false,
      };
    }
    existing.latest = entry;
  }

  const changes = [...grouped.entries()]
    .map(([path, value]) => ({
      kind: value.first.kind,
      path,
      postimage: Buffer.from(value.latest.postimage),
      postimageSha256: value.latest.postimageSha256,
      preimage: Buffer.from(value.first.preimage),
    }))
    .filter((change) => !change.preimage.equals(change.postimage))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  return { changes, ok: true };
}

async function writeImage(root: string, path: string, bytes: Buffer): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function normalizeDirectoryDiff(diff: string): string {
  let inHunk = false;
  return diff.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
      return line;
    }
    if (
      inHunk ||
      (!line.startsWith("diff --git ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ "))
    ) {
      return line;
    }
    return line
      .replaceAll("a/before/", "a/")
      .replaceAll("a/after/", "a/")
      .replaceAll("b/before/", "b/")
      .replaceAll("b/after/", "b/");
  }).join("\n");
}

function diffStat(diff: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function perFileDiffStat(
  diff: string,
  paths: readonly string[],
): readonly RunLocalDiffFileStat[] {
  const stats = paths.map((path) => ({ addedLines: 0, path, removedLines: 0 }));
  let section = -1;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      section += 1;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const current = stats[section];
    if (current === undefined) {
      throw new Error("run-local diff contains an unexpected file section");
    }
    if (line.startsWith("+")) current.addedLines += 1;
    else if (line.startsWith("-")) current.removedLines += 1;
  }
  if (section + 1 !== paths.length) {
    throw new Error("run-local diff file sections do not match checked paths");
  }
  return Object.freeze(stats.map((stat) => Object.freeze(stat)));
}

export class RunLocalDiffChecker {
  constructor(private readonly runner: GitArgvRunner = new NodeGitArgvRunner()) {}

  async check(
    entries: readonly ChangeJournalEntry[],
  ): Promise<RunLocalDiffCheckResult> {
    const net = netChanges(entries);
    if (!net.ok) {
      return failed(net.code, net.detail);
    }
    const checkedPaths = net.changes.map((change) => change.path);
    if (checkedPaths.length === 0) {
      return failed(
        "no_run_local_changes",
        "change journal has no net run-local source change",
      );
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "born-phase7-diff-"));
    const before = join(temporaryRoot, "before");
    const after = join(temporaryRoot, "after");
    const applied = join(temporaryRoot, "applied");
    const patchPath = join(temporaryRoot, "run-local.diff");
    try {
      await Promise.all([mkdir(before), mkdir(after), mkdir(applied)]);
      for (const change of net.changes) {
        if (change.kind === "modify") {
          await Promise.all([
            writeImage(before, change.path, change.preimage),
            writeImage(applied, change.path, change.preimage),
          ]);
        }
        await writeImage(after, change.path, change.postimage);
      }

      // PHASE7: this diff is built from the journal's first preimage and current
      // postimage in isolation. Reading `git diff` from the user's worktree would
      // both omit run-created files and misattribute pre-existing dirty changes.
      const generated = await this.runner.run(temporaryRoot, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--full-index",
        "--no-renames",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--unified=3",
        "--",
        "before",
        "after",
      ]);
      if (generated.exitCode !== 1) {
        return failed(
          "diff_generation_failed",
          "fixed-argv Git did not produce the expected run-local diff",
          { checkedPaths },
        );
      }
      const exactDiff = normalizeDirectoryDiff(
        new TextDecoder("utf-8", { fatal: true }).decode(generated.stdout),
      );
      await writeFile(patchPath, exactDiff, "utf8");

      const applicable = await this.runner.run(applied, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "apply",
        "--check",
        "--whitespace=error-all",
        "--",
        patchPath,
      ]);
      if (applicable.exitCode !== 0) {
        return failed(
          "diff_apply_check_failed",
          "run-local diff failed its isolated apply or whitespace check",
          { checkedPaths, exactDiff },
        );
      }
      const apply = await this.runner.run(applied, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "apply",
        "--whitespace=nowarn",
        "--",
        patchPath,
      ]);
      if (apply.exitCode !== 0) {
        return failed(
          "diff_apply_check_failed",
          "run-local diff could not be replayed on isolated preimages",
          { checkedPaths, exactDiff },
        );
      }
      for (const change of net.changes) {
        const replayed = await readFile(join(applied, ...change.path.split("/")));
        if (sha256(replayed) !== change.postimageSha256) {
          return failed(
            "diff_postimage_mismatch",
            "run-local diff replay did not reproduce the journal postimage",
            { checkedPaths, exactDiff },
          );
        }
      }

      const stat = diffStat(exactDiff);
      const fileStats = perFileDiffStat(exactDiff, checkedPaths);
      return Object.freeze({
        addedLines: stat.added,
        checkedPaths: Object.freeze(checkedPaths),
        detail: "run-local diff isolated apply and whitespace checks passed",
        diffSha256: sha256(exactDiff),
        exactDiff,
        fileStats,
        removedLines: stat.removed,
        status: "passed",
      });
    } catch (error) {
      return failed(
        "diff_generation_failed",
        error instanceof Error
          ? `run-local diff check failed: ${error.name}`
          : "run-local diff check failed",
        { checkedPaths },
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
}
