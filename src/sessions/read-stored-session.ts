import { readFile, stat } from "node:fs/promises";

import {
  decodeStoredEvents,
  type DecodedStoredEvent,
} from "../events/event-decoder-registry.js";

export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export class StoredSessionReadError extends Error {
  constructor(
    readonly code:
      | "empty_jsonl_line"
      | "invalid_json"
      | "invalid_utf8"
      | "session_file_too_large"
      | "unterminated_tail",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "StoredSessionReadError";
  }
}

export async function readStoredSession(
  path: string,
): Promise<readonly DecodedStoredEvent[]> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_SESSION_FILE_BYTES) {
    throw new StoredSessionReadError(
      "session_file_too_large",
      "session JSONL is not a bounded regular file",
    );
  }
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new StoredSessionReadError(
      "invalid_utf8",
      "session JSONL is not valid UTF-8",
      { cause: error },
    );
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    // PHASE9: read-only replay never guesses whether a final fragment is a
    // durable event. Only the locked writer recovery path may back it up and
    // repair one unterminated tail.
    throw new StoredSessionReadError(
      "unterminated_tail",
      "session JSONL has an unterminated final fragment",
    );
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  const values = lines.map((line, index): unknown => {
    if (line.length === 0) {
      throw new StoredSessionReadError(
        "empty_jsonl_line",
        `empty JSONL line at line ${index + 1}`,
      );
    }
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new StoredSessionReadError(
        "invalid_json",
        `invalid JSON at line ${index + 1}`,
        { cause: error },
      );
    }
  });
  return decodeStoredEvents(values);
}
