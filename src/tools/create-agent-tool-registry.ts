import type { EditApprovalMode } from "../agent/agent-types.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import { PatchApprovalGate } from "../approvals/patch-approval-gate.js";
import { ChangeJournal } from "../changes/change-journal.js";
import { AtomicPatchApplier } from "../changes/patch-applier.js";
import { PatchPlanner } from "../changes/patch-planner.js";
import type { EventPublisher } from "../events/event-publisher.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import { createReadonlyToolDefinitions } from "./create-readonly-tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-types.js";

export interface AgentToolRegistryOptions {
  readonly approvalMode: EditApprovalMode;
  readonly approvalPrompt: ApprovalPrompt;
  readonly caseInsensitivePaths: boolean;
  readonly now: () => number;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
  readonly secrets?: readonly (string | undefined)[];
  readonly timestamp: () => string;
  readonly workspace: string;
}

export async function createAgentToolRegistry(
  options: AgentToolRegistryOptions,
): Promise<ToolRegistry> {
  const planner = await PatchPlanner.create(options.workspace, {
    caseInsensitive: options.caseInsensitivePaths,
  });
  const journal = new ChangeJournal();
  const applier = new AtomicPatchApplier({
    journal,
    now: () => new Date(options.timestamp()),
    planner,
    randomId: options.randomUUID,
  });
  const approvalGate = new PatchApprovalGate({
    mode: options.approvalMode,
    prompt: options.approvalPrompt,
    publisher: options.publisher,
    randomUUID: options.randomUUID,
  });
  const definitions: ToolDefinition<unknown>[] = [
    ...(await createReadonlyToolDefinitions(options.workspace)),
    createApplyPatchTool({
      approvalGate,
      applier,
      now: options.now,
      planner,
      publisher: options.publisher,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    }) as ToolDefinition<unknown>,
  ];

  // PHASE5: agent 显式装配唯一 mutation tool；chat 的独立 readonly factory 无法意外继承它。
  // deterministic fake 能证明批准协议和磁盘事实，但不能被重新标记成 live provider 证据。
  const mutations = definitions.filter(
    (definition) => definition.capability === "mutation",
  );
  if (mutations.length !== 1 || mutations[0]?.name !== "apply_patch") {
    throw new Error("agent registry must contain exactly the apply_patch mutation");
  }
  return new ToolRegistry(definitions, options.secrets ?? []);
}
