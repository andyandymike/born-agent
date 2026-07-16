import { readFile } from "node:fs/promises";

import type { RunEvent } from "../events/run-event.js";
import { runEventSchema } from "../events/run-event-schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readSession(path: string): Promise<RunEvent[]> {
  // PHASE2: reader 负责“单行是否合法”，包括完整换行、JSON 语法、版本和 Zod schema。
  // 跨行顺序与终态不变量由 reconstructSession 负责，两层职责不要混在一起。
  const text = await readFile(path, "utf8");
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new Error("session does not end with a complete JSONL line");
  }

  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0) {
      throw new Error(`empty JSONL line at line ${lineNumber}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`invalid JSON at line ${lineNumber}`);
    }

    if (
      isRecord(parsed) &&
      "schema_version" in parsed &&
      parsed.schema_version !== 1
    ) {
      throw new Error(
        `unsupported schema_version ${String(parsed.schema_version)} at line ${lineNumber}`,
      );
    }

    const result = runEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`invalid run event at line ${lineNumber}`);
    }
    return result.data;
  });
}
