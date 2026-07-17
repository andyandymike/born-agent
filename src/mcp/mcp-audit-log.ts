import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { McpEventAppender } from "./mcp-approval-gate.js";
import { phase12McpRunEventDataSchemas } from "./mcp-event-schema.js";
import type {
  Phase12McpRunEventData,
  Phase12McpRunEventType,
} from "./mcp-event-schema.js";

export class McpAuditLog implements McpEventAppender {
  private sequence = 0;

  private constructor(
    private readonly handle: FileHandle,
    public readonly relativeRef: string,
  ) {}

  public static async create(input: {
    readonly auditId: string;
    readonly workspace: string;
  }): Promise<McpAuditLog> {
    const directory = path.join(input.workspace, ".bornagent", "mcp-audit");
    await mkdir(directory, { recursive: true });
    const fileName = `${input.auditId}.jsonl`;
    return new McpAuditLog(
      await open(path.join(directory, fileName), "wx", 0o600),
      `mcp-audit/${fileName}`,
    );
  }

  public async append<TType extends Phase12McpRunEventType>(
    type: TType,
    data: Phase12McpRunEventData<TType>,
  ): Promise<void> {
    phase12McpRunEventDataSchemas[type].parse(data);
    this.sequence += 1;
    const line = JSON.stringify({
      data,
      schema_version: 1,
      seq: this.sequence,
      timestamp: new Date().toISOString(),
      type,
    });
    await this.handle.write(`${line}\n`, undefined, "utf8");
    await this.handle.sync();
  }

  public async close(): Promise<void> {
    await this.handle.close();
  }
}
