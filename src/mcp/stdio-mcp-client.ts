import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import { McpCoreError } from "./mcp-errors.js";

export interface StdioMcpToolDescription {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}

export interface StdioMcpResourceDescription {
  readonly description?: string;
  readonly mimeType?: string;
  readonly name: string;
  readonly size?: number;
  readonly title?: string;
  readonly uri: string;
}

export interface StdioMcpPromptDescription {
  readonly arguments?: readonly Readonly<{
    description?: string;
    name: string;
    required?: boolean;
  }>[];
  readonly description?: string;
  readonly name: string;
  readonly title?: string;
}

export interface StdioMcpNegotiation {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly instructions?: string;
  readonly protocolVersion: string;
  readonly serverName: string;
  readonly serverVersion?: string;
}

class SpawnBoundaryTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  public constructor(
    private readonly inner: StdioClientTransport,
    private readonly onSpawned: (pid: number) => Promise<void>,
  ) {}

  private initializeRequestId: number | string | null = null;
  public negotiatedProtocolVersion: string | null = null;

  public async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      const record = message as unknown as Readonly<Record<string, unknown>>;
      if (
        this.initializeRequestId !== null &&
        record.id === this.initializeRequestId &&
        record.result !== null &&
        typeof record.result === "object" &&
        !Array.isArray(record.result)
      ) {
        const protocolVersion = (record.result as Readonly<Record<string, unknown>>).protocolVersion;
        if (typeof protocolVersion === "string") this.negotiatedProtocolVersion = protocolVersion;
      }
      this.onmessage?.(message);
    };
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
    const record = message as unknown as Readonly<Record<string, unknown>>;
    if (
      record.method === "initialize" &&
      (typeof record.id === "number" || typeof record.id === "string")
    ) {
      this.initializeRequestId = record.id;
    }
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
    readonly onPromptsChanged?: () => void;
    readonly onResourcesChanged?: () => void;
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
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => options.onResourcesChanged?.(),
    );
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => options.onPromptsChanged?.(),
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

  public negotiation(): StdioMcpNegotiation {
    const capabilities = this.client.getServerCapabilities();
    const version = this.client.getServerVersion();
    const protocolVersion = this.transport.negotiatedProtocolVersion;
    if (capabilities === undefined || version === undefined || protocolVersion === null) {
      throw new McpCoreError(
        "mcp_protocol_failed",
        "MCP initialize negotiation is incomplete",
      );
    }
    return Object.freeze({
      capabilities: Object.freeze({ ...capabilities }),
      ...(this.client.getInstructions() === undefined
        ? {}
        : { instructions: this.client.getInstructions()! }),
      protocolVersion,
      serverName: version.name,
      ...(version.version === undefined ? {} : { serverVersion: version.version }),
    });
  }

  public async listResources(options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<readonly StdioMcpResourceDescription[]> {
    const resources: StdioMcpResourceDescription[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const response = await this.client.listResources(
        cursor === undefined ? undefined : { cursor },
        {
          maxTotalTimeout: options.timeoutMs,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
      );
      for (const resource of response.resources) {
        resources.push({
          ...(resource.description === undefined ? {} : { description: resource.description }),
          ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
          name: resource.name,
          ...(resource.size === undefined ? {} : { size: resource.size }),
          ...(resource.title === undefined ? {} : { title: resource.title }),
          uri: resource.uri,
        });
        if (resources.length > 256) {
          throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource catalog exceeds 256 items");
        }
      }
      cursor = response.nextCursor;
      if (cursor === undefined) return Object.freeze(resources);
      if (cursors.has(cursor)) {
        throw new McpCoreError("mcp_catalog_invalid", "MCP resource cursor loop detected");
      }
      cursors.add(cursor);
    }
    throw new McpCoreError("mcp_resource_limit_exceeded", "MCP resource pagination did not terminate");
  }

  public async readResource(options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly uri: string;
  }): Promise<unknown> {
    return await this.client.readResource(
      { uri: options.uri },
      {
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
    );
  }

  public async listPrompts(options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<readonly StdioMcpPromptDescription[]> {
    const prompts: StdioMcpPromptDescription[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const response = await this.client.listPrompts(
        cursor === undefined ? undefined : { cursor },
        {
          maxTotalTimeout: options.timeoutMs,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
      );
      for (const prompt of response.prompts) {
        prompts.push({
          ...(prompt.arguments === undefined
            ? {}
            : {
                arguments: Object.freeze(prompt.arguments.map((argument) => Object.freeze({
                  ...(argument.description === undefined ? {} : { description: argument.description }),
                  name: argument.name,
                  ...(argument.required === undefined ? {} : { required: argument.required }),
                }))),
              }),
          ...(prompt.description === undefined ? {} : { description: prompt.description }),
          name: prompt.name,
          ...(prompt.title === undefined ? {} : { title: prompt.title }),
        });
        if (prompts.length > 128) {
          throw new McpCoreError("mcp_catalog_invalid", "MCP prompt catalog exceeds 128 items");
        }
      }
      cursor = response.nextCursor;
      if (cursor === undefined) return Object.freeze(prompts);
      if (cursors.has(cursor)) {
        throw new McpCoreError("mcp_catalog_invalid", "MCP prompt cursor loop detected");
      }
      cursors.add(cursor);
    }
    throw new McpCoreError("mcp_catalog_invalid", "MCP prompt pagination did not terminate");
  }

  public async getPrompt(options: {
    readonly argumentsValue: Readonly<Record<string, string>>;
    readonly name: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<unknown> {
    return await this.client.getPrompt(
      { arguments: { ...options.argumentsValue }, name: options.name },
      {
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
    );
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
