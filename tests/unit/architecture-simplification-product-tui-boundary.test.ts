import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { createDomainHarness, isDomainHarnessRuntime } from "../../src/coordination/domain-harness.js";
import { createTuiApplicationFacade } from "../../src/tui/tui-application-facade.js";
import { parseTuiCommand } from "../../src/tui/tui-command-parser.js";
import { createRuntime } from "../helpers.js";

const root = resolve(import.meta.dirname, "../..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

function undefinedRootComparisons(text: string, path: string): readonly string[] {
  const unit = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const value = node.getText(unit);
      if (value.includes("controlPlaneStateRoot") && /(?:===|!==)\s*undefined|undefined\s*(?:===|!==)/u.test(value)) {
        violations.push(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return Object.freeze(violations);
}

describe("AS4 product and TUI boundaries", () => {
  it("AS4.1 product single path grants direct mutation only to an explicit DomainHarness", async () => {
    const mutationSurfaces = [
      "src/commands/goal.ts",
      "src/commands/plan.ts",
      "src/commands/graph.ts",
      "src/commands/delegations.ts",
      "src/commands/sessions.ts",
      "src/tui/run-tui.ts",
    ];
    const violations = (await Promise.all(mutationSurfaces.map(async (path) =>
      undefinedRootComparisons(await source(path), path).map((expression) => `${path}: ${expression}`)
    ))).flat();
    expect(violations).toEqual([]);

    const agent = await source("src/control-plane/adapters/agent-cli-adapter.ts");
    const chat = await source("src/control-plane/adapters/chat-application-cli-adapter.ts");
    expect(agent.slice(agent.indexOf("export async function executeAgentThroughApplicationService")))
      .toContain("if (isDomainHarnessRuntime(runtime))");
    expect(chat).toContain("if (isDomainHarnessRuntime(runtime))");
    expect(await source("src/cli/node-runtime.ts")).toContain(
      "controlPlaneStateRoot: resolveControlStateRoot",
    );

    expect(isDomainHarnessRuntime(createRuntime())).toBe(true);
    expect(isDomainHarnessRuntime(createRuntime({ controlPlaneStateRoot: resolve(root, ".tmp-product-root") }))).toBe(false);
    expect(isDomainHarnessRuntime({})).toBe(false);
    expect(() => isDomainHarnessRuntime({
      controlPlaneStateRoot: resolve(root, ".tmp-overlap"),
      domainHarness: createDomainHarness(),
    })).toThrow(/overlaps/u);
  });

  it("AS4.2 TuiCommandParser owns one pure ordered command grammar", () => {
    expect(parseTuiCommand("exit")).toEqual({ kind: "exit" });
    expect(parseTuiCommand("/mode build")).toEqual({ kind: "mode", mode: "build" });
    expect(parseTuiCommand("/session 00000000-0000-4000-8000-000000000001")).toMatchObject({ kind: "session" });
    expect(parseTuiCommand("/skill repo:review strict")).toEqual({ argumentsText: "strict", kind: "skill", selector: "repo:review" });
    expect(parseTuiCommand("/mcp-prompt local:inspect {\"a\":1}")).toEqual({ argumentsJson: "{\"a\":1}", kind: "mcp_prompt", selector: "local:inspect" });
    expect(parseTuiCommand("/resume 00000000-0000-4000-8000-000000000001 continue")).toMatchObject({ kind: "resume", message: "continue" });
    expect(parseTuiCommand("/graph run foreground")).toEqual({ command: "run foreground", kind: "graph" });
    expect(parseTuiCommand("/new! replacement")).toEqual({ confirmedAbandon: true, kind: "new_goal", text: "replacement" });
    expect(parseTuiCommand("/goal set revised")).toEqual({ kind: "goal_set", text: "revised" });
    expect(parseTuiCommand("/goal abandon obsolete")).toEqual({ kind: "goal_abandon", reason: "obsolete" });
    expect(parseTuiCommand("/plan approve-build")).toEqual({ decision: "approve_build", kind: "plan_approve" });
    expect(parseTuiCommand("/plan reject unsafe")).toEqual({ kind: "plan_reject", reason: "unsafe" });
    expect(parseTuiCommand("/plan replace plan.json")).toEqual({ kind: "plan_replace", path: "plan.json" });
    expect(parseTuiCommand("/retry")).toEqual({ kind: "retry_or_continue", operation: "retry" });
    expect(parseTuiCommand("ordinary task")).toEqual({ kind: "text", text: "ordinary task" });
  });

  it("AS4.2 TuiApplicationFacade keeps controller code free of writer composition and domain mutation authority", async () => {
    const controller = await source("src/tui/tui-controller.ts");
    const controllerImports = controller.slice(0, controller.indexOf("export class TuiController"));
    for (const forbidden of [
      "V2SessionWriter",
      "SessionCatalog",
      "GoalManager",
      "PlanStore",
      "ApplicationService",
      "CliRuntime",
      "taskWriterFactory",
    ]) {
      expect(controllerImports, forbidden).not.toContain(forbidden);
    }
    const abortActiveOwnerRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const facade = createTuiApplicationFacade({
      abortActiveOwnerRun,
      cancelActiveRun,
      loadSession: async () => [],
      resumeSession: async () => ({ diagnostic: null, exitCode: 0 }),
      startTask: async () => ({ diagnostic: null, exitCode: 0 }),
    });
    facade.abortActiveOwnerRun();
    facade.cancelActiveRun();
    expect(abortActiveOwnerRun).toHaveBeenCalledOnce();
    expect(cancelActiveRun).toHaveBeenCalledOnce();
    expect(Object.isFrozen(facade)).toBe(true);
    expect(await source("src/coordination/run-coordinator.ts")).not.toContain("../tui/");
  });
});
