import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareNodeAttemptWorkspace } from "../../src/evals/attempt-workspace-node.js";
import { EvalApprovalPolicy } from "../../src/evals/eval-approval-policy.js";
import { InProcessEvalAgentDriver } from "../../src/evals/eval-agent-driver.js";
import { preflightEvalNoCostPolicy } from "../../src/evals/eval-no-cost-policy.js";
import { loadEvalAssets } from "../../src/evals/eval-suite-loader.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  ),
);

describe("Phase 14 production-path eval scenarios", () => {
  it("hits every post-fsync fault boundary and follows Phase 9 recovery rules", async () => {
    const assets = await loadEvalAssets(path.join(process.cwd(), "evals"));
    const root = await mkdtemp(path.join(tmpdir(), "bornagent-phase14-scenarios-"));
    roots.push(root);
    const source = { kind: "in_process_test", provider: "fake" } as const;
    const cases = [
      {
        completed: true,
        hookEvent: "patch.apply.started",
        id: "edit-boundary",
        recovery: "exact",
      },
      {
        completed: false,
        hookEvent: "command.started",
        id: "verify-fresh-run",
        recovery: null,
      },
      {
        completed: true,
        hookEvent: "backend.checkpoint.created",
        id: "resume-checkpoint",
        recovery: "exact",
      },
      {
        completed: true,
        hookEvent: "context_plan_created",
        id: "rules-priority",
        recovery: "canonical_degraded",
      },
      {
        completed: false,
        hookEvent: "mcp.tool.call.started",
        id: "mcp-origin",
        recovery: null,
      },
    ] as const;

    for (const fixture of cases) {
      const task = assets.tasks.get(fixture.id);
      if (task === undefined) throw new Error(`missing eval task ${fixture.id}`);
      const attemptRoot = path.join(root, fixture.id);
      await mkdir(attemptRoot);
      const workspace = await prepareNodeAttemptWorkspace(
        task.workspaceRoot,
        attemptRoot,
      );
      const workspaceId = `${fixture.id}-r1`;
      const result = await new InProcessEvalAgentDriver().run({
        approvalPolicy: new EvalApprovalPolicy(task.task.manifest, workspaceId),
        disposableWorkspaceId: workspaceId,
        guard: preflightEvalNoCostPolicy(source),
        model: "deterministic-v1",
        signal: new AbortController().signal,
        source,
        task,
        workspacePath: workspace.workspacePath,
      });

      expect(result.completed, fixture.id).toBe(fixture.completed);
      expect(
        result.events.some((event) => event.type === fixture.hookEvent),
        fixture.id,
      ).toBe(true);
      expect(
        result.evidence.secondaryCodes?.some((code) =>
          code.startsWith("fault_observed:"),
        ),
        fixture.id,
      ).toBe(true);
      if (fixture.recovery === null) {
        expect(result.terminal, fixture.id).toBe("incomplete");
        expect(result.evidence.secondaryCodes, fixture.id).toContain(
          "scenario_resume_blocked",
        );
      } else {
        expect(
          result.events.some(
            (event) =>
              event.type === "resume_adopted" &&
              event.fields.recoveryStatus === fixture.recovery,
          ),
          fixture.id,
        ).toBe(true);
      }

      const answer = await readFile(
        path.join(workspace.workspacePath, "answer.txt"),
        "utf8",
      ).catch(() => null);
      expect(answer, fixture.id).toBe(
        fixture.id === "mcp-origin" ? null : `PASS:${fixture.id}\n`,
      );
      // PHASE14: raw prompts, patches, command argv, outputs, and grader bytes
      // stay outside the terminal-only projection returned by the driver.
      const projected = JSON.stringify(result.events);
      expect(projected, fixture.id).not.toContain("arguments_json");
      expect(projected, fixture.id).not.toContain("PASS:");
      if (fixture.id === "verify-fresh-run") {
        expect(
          result.events.some(
            (event) => event.type === "sandbox.container.cleaned",
          ),
        ).toBe(true);
      }
      if (fixture.id === "mcp-origin") {
        expect(
          result.events.filter(
            (event) => event.type === "mcp.tool.call.started",
          ),
        ).toHaveLength(1);
        expect(result.events.some((event) => event.type === "mcp_terminal")).toBe(
          false,
        );
      }
    }

    const overflowTask = assets.tasks.get("context-overflow");
    if (overflowTask === undefined) throw new Error("missing context-overflow");
    const overflowRoot = path.join(root, "context-overflow");
    await mkdir(overflowRoot);
    const overflowWorkspace = await prepareNodeAttemptWorkspace(
      overflowTask.workspaceRoot,
      overflowRoot,
    );
    const overflowId = "context-overflow-r1";
    const overflow = await new InProcessEvalAgentDriver().run({
      approvalPolicy: new EvalApprovalPolicy(
        overflowTask.task.manifest,
        overflowId,
      ),
      disposableWorkspaceId: overflowId,
      guard: preflightEvalNoCostPolicy(source),
      model: "deterministic-v1",
      signal: new AbortController().signal,
      source,
      task: overflowTask,
      workspacePath: overflowWorkspace.workspacePath,
    });
    expect(overflow.completed).toBe(false);
    expect(overflow.terminal).toBe("incomplete");
    expect(overflow.evidence.context).toBe(true);
    await expect(
      readFile(path.join(overflowWorkspace.workspacePath, "answer.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);
});
