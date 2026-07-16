import type { ChangeJournalEntry } from "./change-journal.js";

export interface RenderedRunLocalDiff {
  readonly addedLines: number;
  readonly paths: readonly string[];
  readonly removedLines: number;
  readonly text: string;
  readonly truncated: boolean;
}

export function renderRunLocalDiff(
  entries: readonly ChangeJournalEntry[],
  options: { readonly maxBytes?: number; readonly maxLines?: number } = {},
): RenderedRunLocalDiff {
  const maxBytes = options.maxBytes ?? 32 * 1024;
  const maxLines = options.maxLines ?? 200;
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;

  const complete = entries.map((entry) => entry.diff).join("");
  for (const line of complete.split("\n")) {
    const rendered = `${line}\n`;
    const size = Buffer.byteLength(rendered, "utf8");
    if (selected.length >= maxLines || bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    selected.push(line);
    bytes += size;
  }

  return {
    addedLines: entries.reduce((total, entry) => total + entry.addedLines, 0),
    paths: entries.map((entry) => entry.path),
    removedLines: entries.reduce((total, entry) => total + entry.removedLines, 0),
    text: `${selected.join("\n")}${truncated ? "\n... [run-local diff truncated]" : ""}`,
    truncated,
  };
}
