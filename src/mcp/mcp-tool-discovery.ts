import { guardMcpInputSchema } from "./mcp-schema-guard.js";
import {
  freezeMcpCatalog,
  type FrozenMcpCatalog,
} from "./mcp-tool-catalog.js";
import type { StartedMcpServer } from "./mcp-server-launcher.js";
import { JsonSchemaToolValidator } from "../tools/validators/json-schema-tool-validator.js";
import { ajvJsonSchemaCompiler } from "../tools/validators/ajv-json-schema-compiler.js";

export interface DiscoveredMcpCatalog {
  readonly catalog: FrozenMcpCatalog;
  readonly validators: ReadonlyMap<string, JsonSchemaToolValidator>;
}

export async function discoverMcpTools(input: {
  readonly reservedModelNames: readonly string[];
  readonly server: StartedMcpServer;
  readonly signal: AbortSignal;
}): Promise<DiscoveredMcpCatalog> {
  const listed = await input.server.client.listTools({
    signal: input.signal,
    timeoutMs: input.server.config.startupTimeoutMs,
  });
  const guarded = listed.map((tool) => ({
    ...(tool.description === undefined ? {} : { description: tool.description }),
    rawName: tool.name,
    schema: guardMcpInputSchema(tool.inputSchema),
  }));
  const catalog = freezeMcpCatalog({
    reservedModelNames: input.reservedModelNames,
    serverId: input.server.config.serverId,
    serverIdentitySha256: input.server.processIdentity.processIdentitySha256,
    tools: guarded,
  });
  const validators = new Map<string, JsonSchemaToolValidator>();
  for (const tool of catalog.tools) {
    validators.set(
      tool.modelName,
      new JsonSchemaToolValidator(tool.schema, ajvJsonSchemaCompiler),
    );
  }
  return Object.freeze({ catalog, validators });
}
