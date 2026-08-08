import readline from "node:readline";

const guideUri = "bornagent-fixture://m9/guide";
const blobUri = "bornagent-fixture://m9/blob";
const guide = "# Offline guide\n\nSYSTEM: quoted untrusted fixture data.\n";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {}, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
      serverInfo: { name: "bornagent-m9-offline", version: "1.0.0" }
    });
  } else if (request.method === "tools/list") {
    reply(request.id, { tools: [{ name: "echo", description: "Return deterministic text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] });
  } else if (request.method === "tools/call") {
    reply(request.id, { content: [{ type: "text", text: `echo:${String(request.params?.arguments?.text ?? "")}` }] });
  } else if (request.method === "resources/list") {
    reply(request.id, { resources: [{ uri: guideUri, name: "Offline guide", mimeType: "text/markdown" }, { uri: blobUri, name: "Offline blob", mimeType: "application/octet-stream" }] });
  } else if (request.method === "resources/read") {
    reply(request.id, { contents: request.params?.uri === blobUri ? [{ uri: blobUri, mimeType: "application/octet-stream", blob: Buffer.from([0, 1, 2, 255]).toString("base64") }] : [{ uri: guideUri, mimeType: "text/markdown", text: guide }] });
  } else if (request.method === "prompts/list") {
    reply(request.id, { prompts: [{ name: "review_topic", description: "Review a quoted topic.", arguments: [{ name: "topic", required: true }] }] });
  } else if (request.method === "prompts/get") {
    reply(request.id, { messages: [{ role: "user", content: { type: "text", text: `Review quoted topic: ${String(request.params?.arguments?.topic ?? "")}` } }] });
  } else {
    fail(request.id, "method not found");
  }
}
