import { createHash } from "node:crypto";

import type { ChangeJournalEntry } from "../changes/change-journal.js";
import type {
  SnapshotFileDigest,
  VerificationSnapshot,
} from "../completion/completion-types.js";
import {
  hashVerificationSnapshot,
  verificationSnapshotsEqual as completionSnapshotsEqual,
} from "../completion/verification-snapshot.js";
import {
  normalizeWorkspaceRelativePath,
  type SourceStateDigest,
} from "./source-state-digest.js";

export type VerificationFileFingerprint = SnapshotFileDigest;
export type { VerificationSnapshot };

export class VerificationSnapshotError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VerificationSnapshotError";
  }
}

export interface VerificationSnapshotInput {
  readonly commandInputPaths: readonly string[];
  readonly generation: number;
  readonly journalEntries: readonly ChangeJournalEntry[];
  readonly packageScriptSha256?: string;
  readonly sourceState: SourceStateDigest;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function addField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function hashFields(version: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  addField(hash, version);
  for (const field of fields) {
    addField(hash, field);
  }
  return hash.digest("hex");
}

function validateJournal(
  entries: readonly ChangeJournalEntry[],
): {
  readonly changedFiles: readonly VerificationFileFingerprint[];
  readonly journalSha256: string;
} {
  const latest = new Map<string, ChangeJournalEntry>();
  const journalFields: string[] = [];
  for (const entry of entries) {
    const canonicalPath = normalizeWorkspaceRelativePath(entry.path);
    if (canonicalPath !== entry.path) {
      throw new VerificationSnapshotError(
        "change_journal_inconsistent",
        "change journal contains a noncanonical path",
      );
    }
    if (
      sha256(entry.preimage) !== entry.preimageSha256 ||
      sha256(entry.postimage) !== entry.postimageSha256
    ) {
      throw new VerificationSnapshotError(
        "change_journal_inconsistent",
        `change journal hashes do not match the stored images for ${entry.path}`,
      );
    }
    const previous = latest.get(canonicalPath);
    if (
      previous !== undefined &&
      previous.postimageSha256 !== entry.preimageSha256
    ) {
      throw new VerificationSnapshotError(
        "change_journal_inconsistent",
        `change journal image chain is broken for ${entry.path}`,
      );
    }
    latest.set(canonicalPath, entry);
    journalFields.push(
      canonicalPath,
      entry.kind,
      entry.planId,
      entry.appliedAt,
      entry.preimageSha256,
      entry.postimageSha256,
      sha256(entry.diff),
      String(entry.addedLines),
      String(entry.removedLines),
    );
  }

  const changedFiles = [...latest.values()]
    .map((entry) => ({ path: entry.path, sha256: entry.postimageSha256 }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  return {
    changedFiles: Object.freeze(changedFiles.map((file) => Object.freeze(file))),
    journalSha256: hashFields("bornagent-change-journal-v1", journalFields),
  };
}

function collectCommandInputs(
  paths: readonly string[],
  sourceState: SourceStateDigest,
): readonly VerificationFileFingerprint[] {
  if (paths.length === 0) {
    throw new VerificationSnapshotError(
      "verification_inputs_unknown",
      "verification command inputs must be explicitly classified",
    );
  }
  const canonicalPaths = paths.map(normalizeWorkspaceRelativePath);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    throw new VerificationSnapshotError(
      "verification_inputs_unknown",
      "verification command input paths must be unique",
    );
  }
  const sourceFiles = new Map(sourceState.files.map((file) => [file.path, file]));
  const commandInputs = canonicalPaths.map((path) => {
    const sourceFile = sourceFiles.get(path);
    if (
      sourceFile === undefined ||
      sourceFile.type !== "file" ||
      !isSha256(sourceFile.bytesSha256)
    ) {
      throw new VerificationSnapshotError(
        "verification_inputs_unknown",
        `verification command input ${path} is not a captured regular source file`,
      );
    }
    return { path, sha256: sourceFile.bytesSha256 };
  });
  commandInputs.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return Object.freeze(commandInputs.map((file) => Object.freeze(file)));
}

export function buildVerificationSnapshot(
  input: VerificationSnapshotInput,
): VerificationSnapshot {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new VerificationSnapshotError(
      "invalid_verification_generation",
      "verification generation must be a non-negative safe integer",
    );
  }
  for (const value of [
    input.sourceState.gitHeadSha256,
    input.sourceState.gitIndexSha256,
    input.sourceState.sourceStateSha256,
  ]) {
    if (!isSha256(value)) {
      throw new VerificationSnapshotError(
        "invalid_source_state_digest",
        "source-state, HEAD, and index fingerprints must be SHA-256 values",
      );
    }
  }
  if (
    input.packageScriptSha256 !== undefined &&
    !isSha256(input.packageScriptSha256)
  ) {
    throw new VerificationSnapshotError(
      "verification_inputs_unknown",
      "package script fingerprint must be a SHA-256 value",
    );
  }

  const journal = validateJournal(input.journalEntries);
  const commandInputs = collectCommandInputs(
    input.commandInputPaths,
    input.sourceState,
  );
  const deletedFiles: readonly never[] = Object.freeze([]);
  return Object.freeze({
    changedFiles: journal.changedFiles,
    commandInputs,
    deletedFiles,
    generation: input.generation,
    gitHeadSha256: input.sourceState.gitHeadSha256,
    gitIndexSha256: input.sourceState.gitIndexSha256,
    journalSha256: journal.journalSha256,
    ...(input.packageScriptSha256 === undefined
      ? {}
      : { packageScriptSha256: input.packageScriptSha256 }),
    sourceStateSha256: input.sourceState.sourceStateSha256,
  });
}

export function verificationSnapshotSha256(
  snapshot: VerificationSnapshot,
): string {
  return hashVerificationSnapshot(snapshot);
}

export function verificationSnapshotsEqual(
  left: VerificationSnapshot,
  right: VerificationSnapshot,
): boolean {
  return completionSnapshotsEqual(left, right);
}
