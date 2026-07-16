import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  MutationPathPolicy,
  type MutationPathPolicyOptions,
} from "./mutation-path-policy.js";
import {
  MAX_PATCH_PREVIEW_BYTES,
  MAX_PATCH_PREVIEW_LINES,
  MAX_PATCH_TARGET_BYTES,
  type ParsedFilePatch,
  type ParsedHunkLine,
  type PatchPlan,
  type PlannedFileChange,
  patchOperationError,
  throwIfPatchAborted,
} from "./patch-types.js";
import { parseUnifiedDiff } from "./unified-diff-parser.js";

interface TextLine {
  readonly hasNewline: boolean;
  readonly text: string;
}

export interface PatchPlannerOptions extends MutationPathPolicyOptions {
  readonly readFile?: (path: string) => Promise<Buffer>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeText(bytes: Buffer, path: string): string {
  if (bytes.byteLength > MAX_PATCH_TARGET_BYTES) {
    throw patchOperationError(
      "limit",
      "patch_target_too_large",
      `${path} exceeds the 1 MiB patch target limit`,
    );
  }
  if (bytes.includes(0)) {
    throw patchOperationError(
      "invalid_arguments",
      "patch_binary_target",
      `${path} contains NUL bytes and is not an allowed text target`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw patchOperationError(
      "invalid_arguments",
      "patch_invalid_utf8_target",
      `${path} is not valid UTF-8 text`,
    );
  }
}

function splitText(text: string): readonly TextLine[] {
  if (text.length === 0) {
    return [];
  }
  const values = text.split("\n");
  const endsWithNewline = values.at(-1) === "";
  if (endsWithNewline) {
    values.pop();
  }
  return values.map((value, index) => ({
    hasNewline: endsWithNewline || index < values.length - 1,
    text: value,
  }));
}

function joinText(lines: readonly TextLine[]): string {
  return lines.map((line) => `${line.text}${line.hasNewline ? "\n" : ""}`).join("");
}

function expectedLine(line: ParsedHunkLine): TextLine {
  return { hasNewline: !line.noNewline, text: line.text };
}

function linesEqual(left: TextLine, right: TextLine): boolean {
  return left.text === right.text && left.hasNewline === right.hasNewline;
}

function hunkStart(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function simulatePatch(file: ParsedFilePatch, preimageText: string): Buffer {
  const source = splitText(preimageText);
  const output: TextLine[] = [];
  let sourceCursor = 0;

  for (const hunk of file.hunks) {
    const oldIndex = hunkStart(hunk.oldStart, hunk.oldCount);
    if (oldIndex < sourceCursor || oldIndex > source.length) {
      throw patchOperationError(
        "invalid_arguments",
        "patch_hunk_overlap",
        `${file.path} contains overlapping or out-of-range hunks`,
      );
    }
    output.push(...source.slice(sourceCursor, oldIndex));
    sourceCursor = oldIndex;

    const expectedNewIndex = hunkStart(hunk.newStart, hunk.newCount);
    if (output.length !== expectedNewIndex) {
      throw patchOperationError(
        "invalid_arguments",
        "patch_bad_hunk_position",
        `${file.path} has conflicting old/new hunk line numbers`,
      );
    }

    for (const line of hunk.lines) {
      if (line.kind === "addition") {
        output.push(expectedLine(line));
        continue;
      }
      const actual = source[sourceCursor];
      if (actual === undefined || !linesEqual(actual, expectedLine(line))) {
        throw patchOperationError(
          "invalid_arguments",
          "patch_context_mismatch",
          `${file.path} no longer matches the patch context`,
        );
      }
      sourceCursor += 1;
      if (line.kind === "context") {
        output.push(actual);
      }
    }
  }

  output.push(...source.slice(sourceCursor));
  const postimage = Buffer.from(joinText(output), "utf8");
  if (postimage.byteLength > MAX_PATCH_TARGET_BYTES) {
    throw patchOperationError(
      "limit",
      "patch_target_too_large",
      `${file.path} would exceed the 1 MiB patch target limit`,
    );
  }
  return postimage;
}

function buildPreview(normalizedPatch: string): {
  readonly preview: string;
  readonly truncated: boolean;
} {
  const lines = normalizedPatch.split("\n");
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of lines) {
    if (selected.length >= MAX_PATCH_PREVIEW_LINES) {
      truncated = true;
      break;
    }
    const rendered = `${line}\n`;
    const lineBytes = Buffer.byteLength(rendered, "utf8");
    if (bytes + lineBytes > MAX_PATCH_PREVIEW_BYTES) {
      truncated = true;
      break;
    }
    selected.push(line);
    bytes += lineBytes;
  }
  return { preview: selected.join("\n"), truncated };
}

async function readPreimage(
  read: (path: string) => Promise<Buffer>,
  file: ParsedFilePatch,
  absolutePath: string,
): Promise<{ readonly bytes: Buffer; readonly text: string }> {
  if (file.kind === "create") {
    return { bytes: Buffer.alloc(0), text: "" };
  }
  try {
    const bytes = await read(absolutePath);
    return { bytes, text: decodeText(bytes, file.path) };
  } catch (error) {
    if (error instanceof Error && error.name === "PatchOperationError") {
      throw error;
    }
    throw patchOperationError(
      "system",
      "patch_read_failed",
      `failed to read ${file.path} while planning the patch`,
      { cause: error },
    );
  }
}

export class PatchPlanner {
  readonly paths: MutationPathPolicy;
  private readonly read: (path: string) => Promise<Buffer>;

  private constructor(paths: MutationPathPolicy, options: PatchPlannerOptions) {
    this.paths = paths;
    this.read = options.readFile ?? readFile;
  }

  static async create(
    workspace: string,
    options: PatchPlannerOptions = {},
  ): Promise<PatchPlanner> {
    const paths = await MutationPathPolicy.create(workspace, options);
    return new PatchPlanner(paths, options);
  }

  async plan(patch: string): Promise<PatchPlan> {
    // PHASE5: 模型给出的 diff 只是非可信提案；只有解析、路径约束和 preimage 模拟都成功后，
    // 它才成为可以展示给用户批准的 PatchPlan。
    const parsed = parseUnifiedDiff(patch);
    const plannedFiles: PlannedFileChange[] = [];
    const canonicalTargets = new Set<string>();

    for (const file of parsed.files) {
      const resolved = await this.paths.resolve(file.path, file.kind);
      const targetKey = this.paths.canonicalKey(resolved.relativePath);
      if (canonicalTargets.has(targetKey)) {
        throw patchOperationError(
          "invalid_arguments",
          "patch_duplicate_target",
          "patch contains duplicate targets after path case folding",
        );
      }
      canonicalTargets.add(targetKey);

      const preimage = await readPreimage(
        this.read,
        file,
        resolved.absolutePath,
      );
      const postimage = simulatePatch(file, preimage.text);
      plannedFiles.push({
        absolutePath: resolved.absolutePath,
        addedLines: file.addedLines,
        diff: file.diff,
        identity: resolved.identity,
        kind: file.kind,
        parent: resolved.parent,
        postimage,
        postimageSha256: sha256(postimage),
        preimage: preimage.bytes,
        preimageSha256: sha256(preimage.bytes),
        relativePath: resolved.relativePath,
        removedLines: file.removedLines,
      });
    }

    const patchSha256 = sha256(parsed.normalizedPatch);
    // PHASE5: 批准必须绑定 path + preimage hash；否则用户看到 preview 后文件被替换，旧的
    // “yes” 仍可能授权一个从未审查过的实际结果。
    const approvalIdentity = plannedFiles
      .map((file) => `${file.relativePath}\0${file.preimageSha256}`)
      .join("\n");
    const planId = sha256(`${parsed.normalizedPatch}\0${approvalIdentity}`);
    const preview = buildPreview(parsed.normalizedPatch);

    return {
      addedLines: parsed.addedLines,
      files: plannedFiles,
      normalizedPatch: parsed.normalizedPatch,
      patchSha256,
      planId,
      preview: preview.preview,
      previewTruncated: preview.truncated,
      removedLines: parsed.removedLines,
      workspaceRealPath: this.paths.workspaceRealPath,
    };
  }

  async revalidate(
    plan: PatchPlan,
    signal?: AbortSignal,
    allowedCreatedDirectories: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (plan.workspaceRealPath !== this.paths.workspaceRealPath) {
      throw patchOperationError(
        "permission",
        "patch_workspace_mismatch",
        "patch plan belongs to a different workspace",
      );
    }
    if (signal !== undefined) {
      throwIfPatchAborted(signal);
    }
    for (const change of plan.files) {
      await this.paths.revalidate(change, allowedCreatedDirectories);
      if (change.kind === "create") {
        continue;
      }
      let current: Buffer;
      try {
        current = await this.read(change.absolutePath);
      } catch (error) {
        throw patchOperationError(
          "invalid_arguments",
          "patch_stale",
          "patch target changed after the plan was created",
          { cause: error },
        );
      }
      decodeText(current, change.relativePath);
      if (sha256(current) !== change.preimageSha256) {
        throw patchOperationError(
          "invalid_arguments",
          "patch_stale",
          "patch target changed after the plan was created",
        );
      }
    }
  }
}

export function applyPlannedFileForTest(
  file: ParsedFilePatch,
  preimage: string,
): Buffer {
  return simulatePatch(file, preimage);
}
