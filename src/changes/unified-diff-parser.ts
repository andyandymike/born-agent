import {
  MAX_PATCH_BYTES,
  MAX_PATCH_CHANGED_LINES,
  MAX_PATCH_FILES,
  type ParsedFilePatch,
  type ParsedHunk,
  type ParsedHunkLine,
  type ParsedPatch,
  patchOperationError,
} from "./patch-types.js";

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function invalid(code: string, message: string): never {
  throw patchOperationError("invalid_arguments", code, message);
}

function limit(code: string, message: string): never {
  throw patchOperationError("limit", code, message);
}

function normalizePatchText(patch: string): string {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    limit("patch_too_large", `patch exceeds ${MAX_PATCH_BYTES} UTF-8 bytes`);
  }
  if (patch.includes("\0")) {
    invalid("patch_contains_nul", "patch must not contain NUL bytes");
  }
  try {
    encodeURIComponent(patch);
  } catch {
    invalid("patch_invalid_utf8", "patch contains an unpaired Unicode surrogate");
  }

  const normalized = patch.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    invalid("patch_invalid_line_endings", "patch contains a bare carriage return");
  }
  if (normalized.trim().length === 0) {
    invalid("patch_empty", "patch must contain at least one file change");
  }
  return `${normalized.replace(/\n*$/u, "")}\n`;
}

function parseDiffHeader(line: string): string {
  const prefix = "diff --git a/";
  if (!line.startsWith(prefix)) {
    invalid("patch_bad_header", "expected a Git-style diff --git header");
  }

  const body = line.slice(prefix.length);
  const candidates: string[] = [];
  let offset = 0;
  while (true) {
    const marker = body.indexOf(" b/", offset);
    if (marker < 0) {
      break;
    }
    const oldPath = body.slice(0, marker);
    const newPath = body.slice(marker + 3);
    if (oldPath === newPath) {
      candidates.push(oldPath);
    }
    offset = marker + 1;
  }

  if (candidates.length !== 1) {
    invalid(
      "patch_rename_denied",
      "diff header must identify one unchanged create/modify path",
    );
  }
  const path = candidates[0];
  if (path === undefined || path.length === 0) {
    invalid("patch_bad_header", "diff path must not be empty");
  }
  return path;
}

function prefixedPath(line: string, prefix: "--- " | "+++ "): string {
  if (!line.startsWith(prefix)) {
    invalid("patch_bad_file_header", `expected ${prefix.trim()} file header`);
  }
  const value = line.slice(prefix.length);
  if (value.length === 0 || value.includes("\t")) {
    invalid("patch_bad_file_header", "file header path is ambiguous");
  }
  return value;
}

function parseCount(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    invalid("patch_bad_hunk", "hunk line count is not a safe integer");
  }
  return parsed;
}

function parseStart(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    invalid("patch_bad_hunk", "hunk start is not a safe integer");
  }
  return parsed;
}

function parseHunk(lines: readonly string[], start: number): {
  readonly hunk: ParsedHunk;
  readonly next: number;
} {
  const header = lines[start];
  if (header === undefined) {
    invalid("patch_bad_hunk", "missing hunk header");
  }
  const match = HUNK_HEADER.exec(header);
  if (match === null) {
    invalid("patch_bad_hunk", "invalid unified diff hunk header");
  }

  const oldStart = parseStart(match[1] ?? "");
  const oldCount = parseCount(match[2]);
  const newStart = parseStart(match[3] ?? "");
  const newCount = parseCount(match[4]);
  if (
    (oldCount === 0 && oldStart < 0) ||
    (oldCount > 0 && oldStart === 0) ||
    (newCount === 0 && newStart < 0) ||
    (newCount > 0 && newStart === 0)
  ) {
    invalid("patch_bad_hunk", "hunk start/count combination is invalid");
  }

  const mutableLines: Array<{
    kind: ParsedHunkLine["kind"];
    noNewline: boolean;
    text: string;
  }> = [];
  let oldSeen = 0;
  let newSeen = 0;
  let cursor = start + 1;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) {
      break;
    }
    if (line === NO_NEWLINE_MARKER) {
      const previous = mutableLines.at(-1);
      if (previous === undefined || previous.noNewline) {
        invalid("patch_bad_no_newline", "no-newline marker has no unique line");
      }
      previous.noNewline = true;
      cursor += 1;
      continue;
    }
    if (oldSeen === oldCount && newSeen === newCount) {
      break;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      mutableLines.push({ kind: "context", noNewline: false, text });
      oldSeen += 1;
      newSeen += 1;
    } else if (marker === "-") {
      mutableLines.push({ kind: "deletion", noNewline: false, text });
      oldSeen += 1;
    } else if (marker === "+") {
      mutableLines.push({ kind: "addition", noNewline: false, text });
      newSeen += 1;
    } else {
      invalid("patch_bad_hunk_line", "hunk line must start with space, +, or -");
    }
    if (oldSeen > oldCount || newSeen > newCount) {
      invalid("patch_bad_hunk_count", "hunk body exceeds its declared line counts");
    }
    cursor += 1;
  }

  if (oldSeen !== oldCount || newSeen !== newCount) {
    invalid("patch_bad_hunk_count", "hunk body does not match declared line counts");
  }
  if (!mutableLines.some((line) => line.kind !== "context")) {
    invalid("patch_empty_hunk", "hunk must add or remove at least one line");
  }

  const nextLine = lines[cursor];
  if (
    nextLine !== undefined &&
    !nextLine.startsWith("@@ ") &&
    !nextLine.startsWith("diff --git ")
  ) {
    invalid("patch_bad_hunk_count", "unexpected content after complete hunk");
  }

  return {
    hunk: {
      lines: mutableLines,
      newCount,
      newStart,
      oldCount,
      oldStart,
    },
    next: cursor,
  };
}

function rejectUnsupportedMetadata(line: string): void {
  const deniedPrefixes = [
    "old mode ",
    "new mode ",
    "deleted file mode ",
    "new file mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "Binary files ",
    "Submodule ",
  ];
  if (line === "GIT binary patch" || deniedPrefixes.some((prefix) => line.startsWith(prefix))) {
    invalid(
      "patch_unsupported_metadata",
      "delete, rename, copy, binary, mode, symlink, and submodule patches are denied",
    );
  }
}

export function parseUnifiedDiff(patch: string): ParsedPatch {
  const normalizedPatch = normalizePatchText(patch);
  const lines = normalizedPatch.slice(0, -1).split("\n");
  const files: ParsedFilePatch[] = [];
  let cursor = 0;
  let addedLines = 0;
  let removedLines = 0;

  while (cursor < lines.length) {
    const fileStart = cursor;
    const diffPath = parseDiffHeader(lines[cursor] ?? "");
    cursor += 1;

    while (cursor < lines.length) {
      const metadata = lines[cursor] ?? "";
      rejectUnsupportedMetadata(metadata);
      if (!metadata.startsWith("index ")) {
        break;
      }
      if (!/^index [^\s.]+\.\.[^\s.]+$/u.test(metadata)) {
        invalid("patch_bad_index", "index metadata is malformed or contains a mode");
      }
      cursor += 1;
    }

    const oldHeader = prefixedPath(lines[cursor] ?? "", "--- ");
    cursor += 1;
    const newHeader = prefixedPath(lines[cursor] ?? "", "+++ ");
    cursor += 1;

    let kind: ParsedFilePatch["kind"];
    if (oldHeader === "/dev/null") {
      if (newHeader !== `b/${diffPath}`) {
        invalid("patch_bad_create_header", "create patch path headers do not match");
      }
      kind = "create";
    } else {
      if (newHeader === "/dev/null") {
        invalid("patch_delete_denied", "file deletion is denied");
      }
      if (oldHeader !== `a/${diffPath}` || newHeader !== `b/${diffPath}`) {
        invalid("patch_rename_denied", "modify patch path headers must match");
      }
      kind = "modify";
    }

    const hunks: ParsedHunk[] = [];
    let fileAdded = 0;
    let fileRemoved = 0;
    while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("diff --git ")) {
      rejectUnsupportedMetadata(lines[cursor] ?? "");
      const parsed = parseHunk(lines, cursor);
      hunks.push(parsed.hunk);
      cursor = parsed.next;
      for (const line of parsed.hunk.lines) {
        if (line.kind === "addition") {
          fileAdded += 1;
        } else if (line.kind === "deletion") {
          fileRemoved += 1;
        }
      }
    }
    if (hunks.length === 0) {
      invalid("patch_empty_file", "each file patch must contain at least one hunk");
    }

    const fileEnd = cursor;
    files.push({
      addedLines: fileAdded,
      diff: `${lines.slice(fileStart, fileEnd).join("\n")}\n`,
      hunks,
      kind,
      path: diffPath,
      removedLines: fileRemoved,
    });
    addedLines += fileAdded;
    removedLines += fileRemoved;
    if (files.length > MAX_PATCH_FILES) {
      limit("patch_too_many_files", `patch exceeds ${MAX_PATCH_FILES} files`);
    }
    if (addedLines + removedLines > MAX_PATCH_CHANGED_LINES) {
      limit(
        "patch_too_many_changed_lines",
        `patch exceeds ${MAX_PATCH_CHANGED_LINES} changed lines`,
      );
    }
  }

  if (files.length === 0 || addedLines + removedLines === 0) {
    invalid("patch_empty", "patch must contain a create or modify change");
  }
  return { addedLines, files, normalizedPatch, removedLines };
}
