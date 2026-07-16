import { describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { createMemoryIO, InMemorySessionWriter } from "../helpers.js";

describe("Phase 6 production agent registry", () => {
  it("assembles run_command beside the existing controlled tools", async () => {
    const memory = createMemoryIO();
    const runtime = createNodeRuntime({
      approvalInput: {
        interactive: false,
        readLine: async () => null,
      },
      cwd: process.cwd(),
      env: process.env,
      execPath: process.execPath,
      killProcess: (identity, signal) => {
        process.kill(identity, signal);
      },
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-test",
    });
    const publisher = new EventPublisher({
      randomUUID: () => "00000000-0000-4000-8000-000000000003",
      renderer: { render: () => undefined },
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      timestamp: () => "2026-07-17T00:00:00.000Z",
      writer: new InMemorySessionWriter(),
    });

    const registry = await runtime.createAgentToolRegistry({
      approvalMode: "deny",
      approvalPrompt: runtime.createApprovalPrompt(memory.io),
      caseInsensitivePaths: process.platform === "win32",
      commandApprovalMode: "deny",
      commandTimeoutMs: 120_000,
      maxCommandOutputBytes: 131_072,
      now: () => 0,
      publisher,
      randomUUID: () => "00000000-0000-4000-8000-000000000004",
      timestamp: () => "2026-07-17T00:00:00.000Z",
      workspace: process.cwd(),
    });

    expect(registry.modelDefinitions.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "list_files",
      "read_file",
      "run_command",
      "search",
    ]);
    expect(
      registry.modelDefinitions.find((tool) => tool.name === "run_command"),
    ).toMatchObject({
      parameters: {
        additionalProperties: false,
        required: ["args", "cwd", "executable", "purpose", "timeout_ms"],
        type: "object",
      },
      strict: true,
    });
  });
});
