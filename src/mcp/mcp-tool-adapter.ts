import type { ToolContext, ToolRawResult, RegisteredTool } from "../tools/tool-types.js";
import type { RuntimeToolValidator } from "../tools/validators/runtime-tool-validator.js";
import type { FrozenMcpTool } from "./mcp-tool-catalog.js";

export interface McpToolCaller {
  call(
    serverId: string,
    modelToolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolRawResult>;
}

export function createMcpToolAdapter(input: {
  readonly caller: McpToolCaller;
  readonly catalogSha256: string;
  readonly serverId: string;
  readonly tool: FrozenMcpTool;
  readonly validator: RuntimeToolValidator;
}): RegisteredTool {
  return Object.freeze({
    // Server annotations are display-only and untrusted. MCP calls always pass
    // the mutation-grade per-call approval boundary in Phase 12.
    capability: "mutation" as const,
    description: input.tool.description,
    execute: async (value: unknown, context: ToolContext) =>
      await input.caller.call(input.serverId, input.tool.modelName, value, context),
    name: input.tool.modelName,
    origin: Object.freeze({
      catalogSha256: input.catalogSha256,
      kind: "mcp" as const,
      rawName: input.tool.rawName,
      serverId: input.serverId,
    }),
    validator: input.validator,
  });
}
