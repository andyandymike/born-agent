import { describe, expect, it } from "vitest";

import {
  createMcpPromptGetActionIdentity,
  createMcpResourceReadActionIdentity,
  verifyMcpPermissionActionIdentity,
} from "../../src/mcp/mcp-action-identity.js";
import { freezeMcpServerNegotiation } from "../../src/mcp/mcp-capability-negotiation.js";
import {
  freezeMcpPromptCatalog,
  freezeMcpResourceCatalog,
} from "../../src/mcp/mcp-primitive-catalog.js";

const SHA = "a".repeat(64);

describe("Phase 18C MCP primitive identities", () => {
  it("freezes declared capabilities and binds item IDs to process/catalog generations", () => {
    const negotiation = freezeMcpServerNegotiation({
      configSha256: SHA,
      processIdentitySha256: "b".repeat(64),
      raw: {
        capabilities: {
          prompts: { listChanged: true },
          resources: { listChanged: true, subscribe: false },
          tools: {},
        },
        instructions: "untrusted instructions",
        protocolVersion: "2025-06-18",
        serverName: "fixture",
        serverVersion: "1",
      },
      serverId: "fixture",
    });
    expect(negotiation).toMatchObject({
      prompts: { listChanged: true, supported: true },
      resources: { listChanged: true, subscribe: false, supported: true },
      tools: { supported: true },
    });
    expect(negotiation.instructionsSha256).toMatch(/^[a-f0-9]{64}$/u);

    const first = freezeMcpResourceCatalog({
      negotiationSha256: negotiation.negotiationSha256,
      processIdentitySha256: negotiation.processIdentitySha256,
      resources: [{ name: "Guide", uri: "fixture://docs/guide" }],
      serverId: "fixture",
    });
    const restarted = freezeMcpResourceCatalog({
      negotiationSha256: negotiation.negotiationSha256,
      processIdentitySha256: "c".repeat(64),
      resources: [{ name: "Guide", uri: "fixture://docs/guide" }],
      serverId: "fixture",
    });
    expect(first.resources[0]?.resourceId).not.toBe(restarted.resources[0]?.resourceId);
    expect(() => freezeMcpResourceCatalog({
      negotiationSha256: negotiation.negotiationSha256,
      processIdentitySha256: negotiation.processIdentitySha256,
      resources: [
        { name: "One", uri: "fixture://docs/same" },
        { name: "Two", uri: "fixture://docs/same" },
      ],
      serverId: "fixture",
    })).toThrow(/duplicate URI/u);
  });

  it("creates separately verifiable resource and explicit-user prompt action digests", () => {
    const resource = createMcpResourceReadActionIdentity({
      callTimeoutMs: 5000,
      catalogGenerationSha256: "b".repeat(64),
      configSha256: "c".repeat(64),
      negotiationSha256: "d".repeat(64),
      processIdentitySha256: "e".repeat(64),
      resourceId: `mcp-resource:${"f".repeat(64)}`,
      resourceItemSha256: "1".repeat(64),
      serverId: "fixture",
      uri: "fixture://docs/guide",
    });
    expect(verifyMcpPermissionActionIdentity(resource)).toBe(true);
    expect(verifyMcpPermissionActionIdentity({ ...resource, callTimeoutMs: 1 })).toBe(false);

    const prompts = freezeMcpPromptCatalog({
      negotiationSha256: "2".repeat(64),
      processIdentitySha256: "3".repeat(64),
      prompts: [{ arguments: [{ name: "topic", required: true }], name: "review" }],
      serverId: "fixture",
    });
    const prompt = prompts.prompts[0]!;
    const action = createMcpPromptGetActionIdentity({
      argumentsValue: { topic: "quoted; $(not-shell)" },
      callTimeoutMs: 5000,
      catalogGenerationSha256: prompt.catalogGenerationSha256,
      configSha256: "4".repeat(64),
      invocationEventId: "50000000-0000-4000-8000-000000000018",
      negotiationSha256: "2".repeat(64),
      processIdentitySha256: prompt.processIdentitySha256,
      promptId: prompt.promptId,
      promptItemSha256: prompt.itemSha256,
      promptName: prompt.name,
      serverId: prompt.serverId,
    });
    expect(action.argumentsJson).toContain("$(not-shell)");
    expect(verifyMcpPermissionActionIdentity(action)).toBe(true);
  });
});
