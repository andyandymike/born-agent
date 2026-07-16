import { z } from "zod";

import { fitsToolOutput } from "./json-output-limit.js";
import type { RipgrepRunnerLike } from "./ripgrep-runner.js";
import { toolError } from "./tool-errors.js";
import type { ToolDefinition } from "./tool-types.js";
import type { WorkspacePathPolicy } from "./workspace-path-policy.js";
import { SensitivePathPolicy } from "./sensitive-path-policy.js";

const MAX_MATCHES = 100;
const RG_CAPTURE_BYTES = 256 * 1024;
const RG_TIMEOUT_MS = 5_000;
const SENSITIVE_GLOBS = [
  "!.git/**",
  "!.bornagent/**",
  "!.agents/**",
  "!.codex/**",
  "!.env",
  "!.env.*",
  "!*.pem",
  "!*.key",
  "!**/id_rsa",
  "!**/id_ed25519",
] as const;

export const searchInputSchema = z
  .object({
    glob: z
      .string()
      .min(1)
      .max(1024)
      .nullable()
      .describe("Required. A file glob filter, or null when no filter is needed."),
    mode: z
      .enum(["literal", "regex"])
      .describe("Required. Use literal for exact text, or regex for a pattern."),
    path: z
      .string()
      .min(1)
      .max(1024)
      .nullable()
      .describe("Required. A workspace-relative directory, or null for the workspace root."),
    query: z
      .string()
      .min(1)
      .max(1000)
      .describe("Required. The text or regular expression to search for."),
  })
  .strict();

type SearchInput = z.infer<typeof searchInputSchema>;

interface RipgrepMatchLine {
  readonly data?: {
    readonly line_number?: number;
    readonly lines?: { readonly text?: string };
    readonly path?: { readonly text?: string };
    readonly submatches?: readonly { readonly start?: number }[];
  };
  readonly type?: string;
}

function parseMatch(line: string) {
  // PHASE3: 解析 rg --json 的机器协议，不依赖易变的彩色人类输出格式。
  let parsed: RipgrepMatchLine;
  try {
    parsed = JSON.parse(line) as RipgrepMatchLine;
  } catch {
    return undefined;
  }
  if (parsed.type !== "match") {
    return undefined;
  }
  const path = parsed.data?.path?.text;
  const text = parsed.data?.lines?.text;
  const lineNumber = parsed.data?.line_number;
  if (path === undefined || text === undefined || lineNumber === undefined) {
    return undefined;
  }
  return {
    column: (parsed.data?.submatches?.[0]?.start ?? 0) + 1,
    line: lineNumber,
    path: path.replaceAll("\\", "/").replace(/^\.\//u, ""),
    text: text.replace(/[\r\n]+$/gu, ""),
  };
}

export function createSearchTool(
  paths: WorkspacePathPolicy,
  runner: RipgrepRunnerLike,
  sensitive = new SensitivePathPolicy(),
): ToolDefinition<SearchInput> {
  // PHASE3: search 只组装固定 rg argv，不拼接 shell 字符串；query 永远只是一个参数值。
  return {
    description:
      "Search workspace text with ripgrep. mode is literal or regex; path and glob must be null when unused.",
    execute: async (input, context) => {
      const directory = await paths.resolveDirectory(input.path);
      if (!directory.ok) {
        return directory;
      }

      const args = [
        "--json",
        "--line-number",
        "--column",
        "--color=never",
        "--no-messages",
        ...(input.mode === "literal" ? ["--fixed-strings"] : []),
        ...(input.glob === null ? [] : ["--glob", input.glob]),
        ...SENSITIVE_GLOBS.flatMap((glob) => ["--glob", glob]),
        // PHASE3: `--` 终止 option 解析，模型给出的 query 即使以 `-` 开头也不能变成 rg 选项。
        "--",
        input.query,
        directory.value.relativePath,
      ];
      let matchesSeen = 0;
      const result = await runner.run(args, {
        cwd: paths.workspaceRealPath,
        maxStdoutBytes: RG_CAPTURE_BYTES,
        onLine: (line) => {
          if (parseMatch(line) !== undefined) {
            matchesSeen += 1;
          }
          return matchesSeen <= MAX_MATCHES;
        },
        signal: context.signal,
        timeoutMs: RG_TIMEOUT_MS,
      });

      if (result.kind === "cancelled") {
        return {
          error: toolError("cancelled", "tool_cancelled", "search was cancelled"),
          ok: false,
        };
      }
      if (result.kind === "timeout") {
        return {
          error: toolError("tool", "search_timeout", "search timed out", true),
          ok: false,
        };
      }
      if (result.kind === "missing") {
        return {
          error: toolError("system", "rg_not_found", "ripgrep is not available"),
          ok: false,
        };
      }
      if (result.kind === "failed" || ![0, 1].includes(result.exitCode)) {
        return {
          error: toolError(
            "tool",
            result.kind === "completed" && input.mode === "regex"
              ? "invalid_search_pattern"
              : "search_failed",
            "search could not be completed",
          ),
          ok: false,
        };
      }

      const matches = result.lines
        .map(parseMatch)
        .filter((match) => match !== undefined && !sensitive.isDenied(match.path));
      let truncated = result.truncated;
      // PHASE3: 子进程捕获上限之后再对最终 JSON 做第二次上限检查，只按完整 match 删除尾项。
      while (
        matches.length > 0 &&
        !fitsToolOutput({ matches, truncated: true })
      ) {
        matches.pop();
        truncated = true;
      }
      return {
        ok: true,
        truncated,
        value: { matches, truncated },
      };
    },
    inputSchema: searchInputSchema,
    name: "search",
  };
}
