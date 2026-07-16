import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { fitsToolOutput } from "./json-output-limit.js";
import { toolError } from "./tool-errors.js";
import type { ToolDefinition, ToolRawResult } from "./tool-types.js";
import type { WorkspacePathPolicy } from "./workspace-path-policy.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINES = 400;

export const readFileInputSchema = z
  .object({
    end_line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Required. The inclusive 1-based ending line, or null for the file end."),
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe("Required. The workspace-relative UTF-8 text file path."),
    start_line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Required. The inclusive 1-based starting line, or null for line 1."),
  })
  .strict()
  .refine(
    (value) =>
      value.start_line === null ||
      value.end_line === null ||
      value.start_line <= value.end_line,
    { message: "start_line must not exceed end_line" },
  );

type ReadFileInput = z.infer<typeof readFileInputSchema>;

function limitLines(
  path: string,
  lines: readonly string[],
  requestedStart: number,
  requestedEnd: number,
): ToolRawResult {
  // PHASE3: 同时应用 400 行上限和 64 KiB JSON 上限，并只在完整行边界截断。
  const startIndex = Math.min(requestedStart - 1, lines.length);
  const maximumEnd = Math.min(requestedEnd, startIndex + MAX_LINES, lines.length);
  const selected: string[] = [];
  let endLine = startIndex;

  for (let index = startIndex; index < maximumEnd; index += 1) {
    const line = `${index + 1}: ${lines[index] ?? ""}`;
    const candidate = [...selected, line];
    const candidateEnd = index + 1;
    const truncated = candidateEnd < requestedEnd || candidateEnd < lines.length;
    const value = {
      content: candidate.join("\n"),
      end_line: candidateEnd,
      ...(truncated ? { next_start_line: candidateEnd + 1 } : {}),
      path,
      start_line: startIndex + 1,
      truncated,
    };
    if (!fitsToolOutput(value)) {
      break;
    }
    selected.push(line);
    endLine = candidateEnd;
  }

  if (selected.length === 0 && startIndex < lines.length) {
    return {
      error: toolError(
        "limit",
        "line_too_large",
        "a single line exceeds the 64 KiB tool output limit",
      ),
      ok: false,
    };
  }

  const truncated = endLine < requestedEnd || endLine < lines.length;
  return {
    ok: true,
    truncated,
    value: {
      content: selected.join("\n"),
      end_line: endLine,
      ...(truncated && endLine < lines.length
        ? { next_start_line: endLine + 1 }
        : {}),
      path,
      start_line: startIndex + 1,
      truncated,
    },
  };
}

export function createReadFileTool(
  paths: WorkspacePathPolicy,
): ToolDefinition<ReadFileInput> {
  // PHASE3: read_file 的顺序是路径策略 -> 文件大小 -> 二进制/UTF-8 -> 行范围 -> 输出上限。
  return {
    capability: "read",
    description:
      "Read a UTF-8 text file inside the workspace with 1-based line numbers. Use null for an unspecified line bound.",
    execute: async (input, context) => {
      if (context.signal.aborted) {
        return {
          error: toolError("cancelled", "tool_cancelled", "read was cancelled"),
          ok: false,
        };
      }
      const resolved = await paths.resolveFile(input.path);
      if (!resolved.ok) {
        return resolved;
      }

      try {
        const metadata = await stat(resolved.value.absolutePath);
        if (metadata.size > MAX_FILE_BYTES) {
          return {
            error: toolError(
              "limit",
              "file_too_large",
              "file exceeds 1 MiB; use search to locate relevant lines",
            ),
            ok: false,
          };
        }
        const bytes = await readFile(resolved.value.absolutePath);
        if (context.signal.aborted) {
          return {
            error: toolError("cancelled", "tool_cancelled", "read was cancelled"),
            ok: false,
          };
        }
        if (bytes.includes(0)) {
          // PHASE3: NUL 是快速二进制信号；随后 fatal TextDecoder 继续拒绝非法 UTF-8。
          return {
            error: toolError(
              "tool",
              "binary_or_non_utf8",
              "file is binary or not valid UTF-8",
            ),
            ok: false,
          };
        }

        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return {
            error: toolError(
              "tool",
              "binary_or_non_utf8",
              "file is binary or not valid UTF-8",
            ),
            ok: false,
          };
        }
        const lines = text.split(/\r?\n/u);
        const start = input.start_line ?? 1;
        const requestedEnd = input.end_line ?? lines.length;
        return limitLines(
          resolved.value.relativePath,
          lines,
          start,
          requestedEnd,
        );
      } catch {
        return {
          error: toolError("system", "read_failed", "file could not be read"),
          ok: false,
        };
      }
    },
    inputSchema: readFileInputSchema,
    name: "read_file",
  };
}
