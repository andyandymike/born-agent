import type { TuiViewState } from "../tui-view-state.js";

function budget(value: number | null): string {
  return value === null ? "unbounded" : String(value);
}

/** Historical-only Phase 19 panel. Live process evidence remains a separate
 * observation and is never inferred from these replayed worker events. */
export function renderGraphPanel(view: TuiViewState): string[] {
  if (view.taskGraph.trackingMode !== "phase19") return [];
  const execution = view.taskExecution;
  const graph = execution?.graph ?? view.taskGraph.revisions.at(-1) ?? null;
  if (graph === null) return ["GRAPH | none"];
  const lines = [
    `GRAPH | ${graph.graphId}@${String(graph.revision)} | ${execution?.status ?? graph.status} | sha=${graph.graphSha256.slice(0, 12)}`,
  ];
  if (execution !== null) {
    lines.push(
      `GRAPH BUDGET | attempts=${String(execution.budget.consumed.attempts)}/${budget(execution.budget.limits.attempts)} | commands=${String(execution.budget.consumed.commandExecutions)}/${budget(execution.budget.limits.commandExecutions)} | artifacts=${String(execution.budget.consumed.artifactBytes)}/${budget(execution.budget.limits.artifactBytes)} | usage=${execution.budget.usageCompleteness}`,
    );
    for (const node of execution.nodes) {
      lines.push(
        `GRAPH NODE | ${String(node.node.sequence)}:${node.nodeId} | ${node.status} | attempts=${String(node.attempts.length)} | next=${node.nextAttemptOrigin ?? "none"}`,
      );
    }
    if (execution.blocker !== null) lines.push(`GRAPH BLOCKER | ${execution.blocker.code}`);
  }
  for (const workspace of view.worktrees.workspaces) {
    lines.push(
      `GRAPH WORKSPACE | ${workspace.identity.workspaceId} | ${workspace.status} | source=${workspace.identity.sourceNodeId} | snapshot=${workspace.lastSnapshot?.sha256.slice(0, 12) ?? "none"}`,
    );
  }
  const worker = view.background.current ?? view.background.workers.at(-1) ?? null;
  if (worker !== null) {
    lines.push(
      `GRAPH WORKER | ${worker.workerId} | ${worker.status} | operation=${worker.operationId} | historical-only`,
    );
  }
  return lines;
}
