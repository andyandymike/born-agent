import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentPlanStore } from "../../src/plans/agent-plan-store.js";
import { createUpdatePlanTool } from "../../src/plans/update-plan-tool.js";
import { createPlanToolRegistry } from "../../src/tools/create-plan-tool-registry.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 16D Plan ToolRegistry", () => {
  it("mechanically exposes only read tools and update_plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16d-plan-"));
    workspaces.push(workspace);
    const store: AgentPlanStore = {
      applyAgentMutation: async () => {
        throw new Error("not executed by catalog test");
      },
    };
    const registry = await createPlanToolRegistry(
      workspace,
      createUpdatePlanTool({
        context: () => {
          throw new Error("not executed by catalog test");
        },
        store,
      }),
    );

    expect(registry.modelDefinitions.map((tool) => tool.name).sort()).toEqual([
      "list_files",
      "read_file",
      "search",
      "update_plan",
    ]);
    expect(registry.modelDefinitions.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["apply_patch", "finish_task", "run_command"]),
    );
  });
});
