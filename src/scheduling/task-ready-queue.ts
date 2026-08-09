import type { TaskExecutionProjectionV1, TaskNodeExecutionProjectionV1 } from "./task-execution-projector.js";

export function deterministicReadyQueue(
  execution: TaskExecutionProjectionV1,
): readonly TaskNodeExecutionProjectionV1[] {
  const ready = new Set(execution.readyNodeIds);
  return Object.freeze(
    execution.nodes
      .filter((node) => ready.has(node.nodeId))
      .sort((left, right) =>
        left.node.sequence - right.node.sequence ||
        left.nodeId.localeCompare(right.nodeId, "en")
      ),
  );
}
