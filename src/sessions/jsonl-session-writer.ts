import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { RunEvent } from "../events/run-event.js";

export interface SessionWriter {
  readonly path: string;
  close(): Promise<void>;
  write(event: RunEvent): Promise<void>;
}

export class JsonlSessionWriter implements SessionWriter {
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    readonly path: string,
  ) {}

  static async create(
    workspace: string,
    sessionId: string,
  ): Promise<JsonlSessionWriter> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
      throw new Error("invalid session id");
    }

    const directory = join(workspace, ".bornagent", "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sessionId}.jsonl`);
    const handle = await open(path, "wx");
    return new JsonlSessionWriter(handle, path);
  }

  async write(event: RunEvent): Promise<void> {
    if (this.closed) {
      throw new Error("session writer is closed");
    }
    await this.handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.handle.close();
  }
}
