import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import { McpCoreError } from "./mcp-errors.js";

export interface StdioMcpToolDescription {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}

class SpawnBoundaryTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  public constructor(
    private readonly inner: StdioClientTransport,
    private readonly onSpawned: (pid: number) => Promise<void>,
  ) {}

  public async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => this.onmessage?.(message);
    await this.inner.start();
    const pid = this.inner.pid;
    if (pid === null) {
      throw new McpCoreError("mcp_spawn_identity_missing", "MCP child has no process identity");
    }
    // The callback persists mcp.server.started before Client.connect continues
    // into initialize. A storage failure therefore never lets discovery run.
    await this.onSpawned(pid);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }

  public send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message);
  }
}

export class StdioMcpClient {
  private readonly client: Client;
  private readonly innerTransport: StdioClientTransport;
  private readonly transport: SpawnBoundaryTransport;
  private closed = false;

  public constructor(options: {
    readonly args: readonly string[];
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly onSpawned: (pid: number) => Promise<void>;
    readonly onStderr: (chunk: Uint8Array) => void;
    readonly onToolsChanged: () => void;
  }) {
    this.innerTransport = new StdioClientTransport({
      args: [...options.args],
      command: options.command,
      cwd: options.cwd,
      env: { ...options.environment },
      stderr: "pipe",
    });
    this.innerTransport.stderr?.on("data", (chunk: Buffer | string) => {
      options.onStderr(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    this.transport = new SpawnBoundaryTransport(
      this.innerTransport,
      options.onSpawned,
    );
    this.client = new Client(
      { name: "bornagent", version: "0.0.0-phase12" },
      { capabilities: {} },
    );
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => options.onToolsChanged(),
    );
  }

  public get pid(): number | null {
    return this.innerTransport.pid;
  }

  public async connect(options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<void> {
    await this.client.connect(this.transport, {
      maxTotalTimeout: options.timeoutMs,
      signal: options.signal,
      timeout: options.timeoutMs,
    });
  }

  public async listTools(options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<readonly StdioMcpToolDescription[]> {
    const tools: StdioMcpToolDescription[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const response = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        {
          maxTotalTimeout: options.timeoutMs,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
      );
      for (const tool of response.tools) {
        tools.push({
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
          name: tool.name,
        });
        if (tools.length > 256) {
          throw new McpCoreError("mcp_catalog_limit", "MCP catalog exceeds 256 tools");
        }
      }
      cursor = response.nextCursor;
      if (cursor === undefined) return Object.freeze(tools);
    }
    throw new McpCoreError("mcp_catalog_limit", "MCP catalog pagination did not terminate");
  }

  public async callTool(options: {
    readonly argumentsValue: unknown;
    readonly name: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<unknown> {
    return await this.client.callTool(
      {
        arguments: options.argumentsValue as Record<string, unknown>,
        name: options.name,
      },
      undefined,
      {
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
    );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}
