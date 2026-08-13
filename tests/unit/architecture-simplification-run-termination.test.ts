import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { EventPersistenceError, EventPublisher } from "../../src/events/event-publisher.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { HookError } from "../../src/hooks/hook-errors.js";
import { McpCoreError } from "../../src/mcp/mcp-errors.js";
import { FatalToolExecutionError } from "../../src/tools/tool-types.js";
import { RunResourceScope } from "../../src/agent/run-resource-scope.js";
import {
  classifyRunExecutionError,
  RunTerminator,
  RunTerminationStateError,
} from "../../src/agent/run-terminator.js";
import { InMemorySessionWriter } from "../helpers.js";
import { testBackendSelected } from "../phase8-event-helpers.js";

const root = resolve(import.meta.dirname, "../..");

function createPublisher(
  writer: InMemorySessionWriter,
  render: (event: RunEvent) => void = () => undefined,
): EventPublisher {
  let uuid = 2;
  return new EventPublisher({
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    renderer: { render },
    runId: "00000000-0000-4000-8000-000000000002",
    sessionId: "00000000-0000-4000-8000-000000000001",
    timestamp: () => "2026-08-13T00:00:00.000Z",
    writer,
  });
}

async function startChat(publisher: EventPublisher): Promise<void> {
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "hello" },
      model: "test-model",
      provider: "openai",
      timeout_ms: 1_000,
      workspace: root,
    },
    type: "run.started",
  });
  await publisher.publish(testBackendSelected("openai", "test-model"));
}

function failedEvent() {
  return {
    data: {
      category: "internal" as const,
      code: "test_failure",
      duration_ms: 1,
      message: "test failure",
      output_chars: 0,
      retryable: false,
      steps: 0,
      tool_calls: 0,
    },
    type: "run.failed" as const,
  };
}

function directTerminalPublications(sourceText: string, path: string): readonly string[] {
  const unit = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const terminalTypes = new Set([
    "run.budget_exceeded",
    "run.cancelled",
    "run.completed",
    "run.failed",
    "run.incomplete",
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(unit) === "publisher.publish" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0]!)
    ) {
      const typeProperty = node.arguments[0]!.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText(unit) === "type",
      );
      if (
        typeProperty !== undefined &&
        ts.isStringLiteral(typeProperty.initializer) &&
        terminalTypes.has(typeProperty.initializer.text)
      ) {
        violations.push(typeProperty.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return Object.freeze(violations);
}

describe("AS5.1 terminal ownership", () => {
  it("AS5.1 RunTerminator owns hook then one durable terminal publication", async () => {
    const order: string[] = [];
    const writer = new InMemorySessionWriter("memory://as5-order", (event) => {
      order.push(`persist:${event.type}`);
    });
    const publisher = createPublisher(writer, (event) => {
      order.push(`render:${event.type}`);
    });
    await startChat(publisher);
    order.length = 0;
    const terminator = new RunTerminator({
      beforeTerminal: async () => {
        order.push("hook");
      },
      publisher,
    });

    await expect(
      terminator.terminate({ exitCode: 1, type: "failed" }, failedEvent()),
    ).resolves.toEqual({ exitCode: 1, type: "failed" });
    expect(order).toEqual([
      "hook",
      "persist:run.failed",
      "render:run.failed",
    ]);
    expect(terminator.state).toBe("published");
    await expect(
      terminator.terminate({ exitCode: 1, type: "failed" }, failedEvent()),
    ).rejects.toMatchObject({ state: "published" });
    expect(writer.events.filter((event) => event.type === "run.failed")).toHaveLength(1);
  });

  it("AS5.1 persistence failure permanently prevents a compensating terminal", async () => {
    const terminalAttempts: string[] = [];
    const writer = new InMemorySessionWriter("memory://as5-failure", (event) => {
      if (event.type.startsWith("run.") && event.type !== "run.started") {
        terminalAttempts.push(event.type);
        throw new Error("disk unavailable");
      }
    });
    const publisher = createPublisher(writer);
    await startChat(publisher);
    const terminator = new RunTerminator({ publisher });

    await expect(
      terminator.terminate({ exitCode: 1, type: "failed" }, {
        data: {
          category: "internal",
          code: "test_failure",
          duration_ms: 1,
          message: "test failure",
          output_chars: 0,
          retryable: false,
          steps: 0,
          tool_calls: 0,
        },
        type: "run.failed",
      }),
    ).rejects.toBeInstanceOf(EventPersistenceError);
    expect(terminator.state).toBe("persistence_failed");
    await expect(
      terminator.terminate({ exitCode: 1, type: "failed" }, failedEvent()),
    ).rejects.toEqual(new RunTerminationStateError("persistence_failed"));
    expect(terminalAttempts).toEqual(["run.failed"]);
    expect(writer.events.map((event) => event.type)).toEqual([
      "run.started",
      "backend.selected",
    ]);
  });

  it("AS5.1 pure classification preserves storage cancel provider tool Hook MCP and TUI fatal classes", () => {
    const storage = new FatalToolExecutionError("storage", "disk", {
      workspaceMayHaveChanged: true,
    });
    const cancelled = new FatalToolExecutionError("user_cancelled", "cancel", {
      workspaceMayHaveChanged: false,
    });
    expect(classifyRunExecutionError(new EventPersistenceError(new Error()), { wasUserCancelled: false })).toEqual({ kind: "persistence" });
    expect(classifyRunExecutionError(storage, { wasUserCancelled: false })).toEqual({ kind: "storage", workspaceMayHaveChanged: true });
    expect(classifyRunExecutionError(cancelled, { wasUserCancelled: false })).toEqual({ kind: "user_cancelled" });
    expect(classifyRunExecutionError(new HookError("hook_gate_denied", "denied"), { wasUserCancelled: false })).toMatchObject({ kind: "hook" });
    expect(classifyRunExecutionError(new McpCoreError("mcp_protocol_failed", "bad"), { wasUserCancelled: false })).toMatchObject({ kind: "mcp" });
    expect(classifyRunExecutionError(new Error("provider escaped"), { wasUserCancelled: false })).toEqual({ kind: "internal" });
    expect(classifyRunExecutionError(new Error("surface"), { hostEmergencyReason: "tui_surface_fatal", wasUserCancelled: true })).toEqual({ kind: "host_surface_fatal" });
  });

  it("AS5.1 RunResourceScope closes listener MCP capability and writer resources once", async () => {
    const closed: string[] = [];
    const scope = new RunResourceScope();
    scope.add("listener", () => {
      closed.push("listener");
    });
    scope.add("mcp", async () => {
      closed.push("mcp");
    });
    scope.add("capability", () => {
      closed.push("capability");
    });
    scope.add("writer", () => {
      closed.push("writer");
    }, "persistence");

    const runtimeA = scope.closePhase("runtime");
    const runtimeB = scope.closePhase("runtime");
    expect(runtimeA).toBe(runtimeB);
    await runtimeA;
    await scope.close();
    await scope.close();
    expect(closed).toEqual(["listener", "mcp", "capability", "writer"]);
  });

  it("AS5.1 AgentLoop and outer execution have no direct terminal publisher", async () => {
    for (const path of [
      "src/agent/agent-loop.ts",
      "src/agent/agent-execution-service.ts",
    ]) {
      const text = await readFile(resolve(root, path), "utf8");
      expect(text).not.toContain("beforeRunTerminal");
      expect(directTerminalPublications(text, path), path).toEqual([]);
    }
  });
});
