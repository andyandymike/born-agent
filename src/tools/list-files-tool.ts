import { z } from "zod";

import { fitsToolOutput } from "./json-output-limit.js";
import type { RipgrepRunnerLike } from "./ripgrep-runner.js";
import { SensitivePathPolicy } from "./sensitive-path-policy.js";
import { toolError } from "./tool-errors.js";
import type { ToolDefinition } from "./tool-types.js";
import type { WorkspacePathPolicy } from "./workspace-path-policy.js";

const MAX_FILES = 500;
const RG_CAPTURE_BYTES = 256 * 1024;
const RG_TIMEOUT_MS = 5_000;

export const listFilesInputSchema = z
  .object({
    glob: z
      .string()
      .min(1)
      .max(1024)
      .nullable()
      .describe("Required. A file glob filter, or null when no filter is needed."),
    path: z
      .string()
      .min(1)
      .max(1024)
      .nullable()
      .describe("Required. A workspace-relative directory, or null for the workspace root."),
  })
  .strict();

type ListFilesInput = z.infer<typeof listFilesInputSchema>;

export function createListFilesTool(
  paths: WorkspacePathPolicy,
  runner: RipgrepRunnerLike,
  sensitive = new SensitivePathPolicy(),
): ToolDefinition<ListFilesInput> {
  // PHASE3: list_files 复用 rg --files，因此遵守仓库 ignore 规则，也不自行无限递归目录树。
  return {
    description:
      "List files inside the workspace using repository ignore rules. path and glob must be null when unused.",
    execute: async (input, context) => {
      const directory = await paths.resolveDirectory(input.path);
      if (!directory.ok) {
        return directory;
      }
      let filesSeen = 0;
      const result = await runner.run(
        [
          "--files",
          "--color=never",
          ...(input.glob === null ? [] : ["--glob", input.glob]),
          "--",
          directory.value.relativePath,
        ],
        {
          cwd: paths.workspaceRealPath,
          maxStdoutBytes: RG_CAPTURE_BYTES,
          onLine: () => {
            filesSeen += 1;
            return filesSeen <= MAX_FILES;
          },
          signal: context.signal,
          timeoutMs: RG_TIMEOUT_MS,
        },
      );
      if (result.kind === "cancelled") {
        return {
          error: toolError("cancelled", "tool_cancelled", "listing was cancelled"),
          ok: false,
        };
      }
      if (result.kind === "timeout") {
        return {
          error: toolError("tool", "list_timeout", "file listing timed out", true),
          ok: false,
        };
      }
      if (result.kind === "missing") {
        return {
          error: toolError("system", "rg_not_found", "ripgrep is not available"),
          ok: false,
        };
      }
      if (result.kind === "failed" || result.exitCode !== 0) {
        return {
          error: toolError("tool", "list_failed", "files could not be listed"),
          ok: false,
        };
      }

      const files = result.lines
        .map((path) => path.replaceAll("\\", "/").replace(/^\.\//u, ""))
        .filter((path) => !sensitive.isDenied(path))
        // PHASE3: ordinal 排序让相同工作区产生稳定输出，减少模型和测试中的随机差异。
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      let truncated = result.truncated;
      while (files.length > 0 && !fitsToolOutput({ files, truncated: true })) {
        files.pop();
        truncated = true;
      }
      return { ok: true, truncated, value: { files, truncated } };
    },
    inputSchema: listFilesInputSchema,
    name: "list_files",
  };
}
