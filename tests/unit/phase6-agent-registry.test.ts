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
      modelEvidence: {
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      },
      now: () => 0,
      publisher,
      randomUUID: () => "00000000-0000-4000-8000-000000000004",
      reportFormat: "text",
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      taskProfile: "coding",
      timestamp: () => "2026-07-17T00:00:00.000Z",
      workspace: process.cwd(),
    });

    expect(registry.modelDefinitions.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "finish_task",
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

  it("keeps read-only tool output redacted when provider keys coexist with Ollama", async () => {
    const secret = "phase8-provider-credential-sentinel-4711";
    const memory = createMemoryIO();
    const runtime = createNodeRuntime({
      approvalInput: {
        interactive: false,
        readLine: async () => null,
      },
      cwd: process.cwd(),
      env: {
        ANTHROPIC_API_KEY: secret,
        BORN_PROVIDER: "ollama",
        OPENAI_API_KEY: secret,
      },
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
      randomUUID: () => "00000000-0000-4000-8000-000000000013",
      renderer: { render: () => undefined },
      runId: "00000000-0000-4000-8000-000000000012",
      sessionId: "00000000-0000-4000-8000-000000000011",
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
      modelEvidence: {
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      },
      now: () => 0,
      publisher,
      randomUUID: () => "00000000-0000-4000-8000-000000000014",
      reportFormat: "text",
      runId: "00000000-0000-4000-8000-000000000012",
      secrets: [secret],
      sessionId: "00000000-0000-4000-8000-000000000011",
      taskProfile: "read-only",
      timestamp: () => "2026-07-17T00:00:00.000Z",
      workspace: process.cwd(),
    });

    const execution = await registry.execute(
      {
        argumentsJson: "{}",
        callId: "phase8-redaction-call",
        name: secret,
        step: 1,
      },
      new AbortController().signal,
    );

    expect(execution.ok).toBe(false);
    expect(execution.output).toContain("[redacted]");
    expect(execution.output).not.toContain(secret);
  });
});
