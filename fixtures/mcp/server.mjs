import { readFile } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "normal";
if (mode === "--malformed") {
  process.stdout.write("not-json\n");
  setTimeout(() => process.exit(2), 20);
} else if (mode === "--crash") {
  process.exit(3);
} else {
  if (mode === "--ansi-stderr") {
    process.stderr.write("\u001b]52;c;bm90LWEtc2VjcmV0\u0007fixture diagnostic\n");
  }

  const server = new Server(
    { name: "bornagent-offline-fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        description: "Read the checked-in package version without network access.",
        inputSchema: { additionalProperties: false, properties: {}, type: "object" },
        name: "get_project_version",
      },
      {
        description: "Return an MCP tool-level error.",
        inputSchema: { additionalProperties: false, properties: {}, type: "object" },
        name: "return_tool_error",
      },
      {
        description: "Return deterministic long text for truncation tests.",
        inputSchema: {
          additionalProperties: false,
          properties: { bytes: { maximum: 200000, minimum: 1, type: "integer" } },
          required: ["bytes"],
          type: "object",
        },
        name: "long_output",
      },
      {
        description: "Delay locally for cancellation and timeout tests.",
        inputSchema: {
          additionalProperties: false,
          properties: { milliseconds: { maximum: 120000, minimum: 0, type: "integer" } },
          required: ["milliseconds"],
          type: "object",
        },
        name: "delay",
      },
      {
        description: "Return image content that BornAgent must reject explicitly.",
        inputSchema: { additionalProperties: false, properties: {}, type: "object" },
        name: "unsupported_content",
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === "get_project_version") {
      const packageJson = JSON.parse(await readFile("package.json", "utf8"));
      return { content: [{ type: "text", text: String(packageJson.version) }] };
    }
    if (name === "return_tool_error") {
      return { content: [{ type: "text", text: "fixture tool error" }], isError: true };
    }
    if (name === "long_output") {
      return { content: [{ type: "text", text: "x".repeat(Number(args.bytes)) }] };
    }
    if (name === "delay") {
      await new Promise((resolve) => setTimeout(resolve, Number(args.milliseconds)));
      return { content: [{ type: "text", text: "delayed" }] };
    }
    if (name === "unsupported_content") {
      return {
        content: [
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      };
    }
    return { content: [{ type: "text", text: "unknown fixture tool" }], isError: true };
  });

  await server.connect(new StdioServerTransport());
}
