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
    // PHASE2: "wx" 只创建新文件，UUID 意外碰撞时失败，不会覆盖旧 session。
    const handle = await open(path, "wx");
    return new JsonlSessionWriter(handle, path);
  }

  async write(event: RunEvent): Promise<void> {
    if (this.closed) {
      throw new Error("session writer is closed");
    }
    // PHASE2: JSONL = 一行一个完整 JSON 事件。尾部换行让 reader 能识别完整写入的行；
    // Phase 2 对崩溃留下的不完整尾行选择报错，恢复策略留给后续阶段。
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
