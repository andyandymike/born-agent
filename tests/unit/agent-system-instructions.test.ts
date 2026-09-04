import { describe, expect, it } from "vitest";

import {
  AGENT_SYSTEM_INSTRUCTIONS,
  READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS,
} from "../../src/agent/system-instructions.js";

describe("agent single-tool-turn protocol", () => {
  it.each([
    ["coding", AGENT_SYSTEM_INSTRUCTIONS],
    ["read-only", READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS],
  ])("tells the %s actor about the Host cardinality boundary", (_mode, instructions) => {
    expect(instructions).toContain("exactly one tool per model turn");
    expect(instructions).toContain("never emit parallel or multiple tool calls");
  });

  it.each([
    ["coding", AGENT_SYSTEM_INSTRUCTIONS],
    ["read-only", READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS],
  ])("does not advertise tools absent from a restricted %s catalog", (_mode, instructions) => {
    expect(instructions).toContain("Use only tools in the current tool catalog");
    expect(instructions).not.toContain("search, and list_files");
  });
});
