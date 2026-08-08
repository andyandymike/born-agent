import { describe, expect, it } from "vitest";

import { parseExplicitMcpPromptSelection } from "../../src/mcp/mcp-prompt-selection.js";

describe("Phase 18C explicit MCP prompt selection", () => {
  it("binds a prompt and canonical string arguments to an explicitly selected server", () => {
    expect(
      parseExplicitMcpPromptSelection({
        argumentsJson: '{"topic":"safe review","detail":"short"}',
        selectedServerIds: ["phase18"],
        selector: "phase18:review",
      }),
    ).toEqual({
      argumentsValue: { detail: "short", topic: "safe review" },
      promptName: "review",
      selector: "phase18:review",
      serverId: "phase18",
    });
  });

  it("requires an exact selected server and rejects non-string argument authority", () => {
    expect(() =>
      parseExplicitMcpPromptSelection({
        selectedServerIds: [],
        selector: "phase18:review",
      }),
    ).toThrow(/exact server/u);
    expect(() =>
      parseExplicitMcpPromptSelection({
        argumentsJson: '{"topic":["run this"]}',
        selectedServerIds: ["phase18"],
        selector: "phase18:review",
      }),
    ).toThrow(/string values/u);
    expect(() =>
      parseExplicitMcpPromptSelection({
        argumentsJson: '{"topic":"orphan"}',
        selectedServerIds: ["phase18"],
      }),
    ).toThrow(/require one explicit prompt/u);
  });
});
