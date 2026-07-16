import type {
  ExecutionResult,
  ExecutionSignal,
  Executor,
  PreparedExecution,
} from "./execution-types.js";

export interface ExecutionObserver {
  onSignal(signal: ExecutionSignal): Promise<void> | void;
}

export async function executeAndCollect(
  executor: Executor,
  prepared: PreparedExecution,
  signal: AbortSignal,
  observer?: ExecutionObserver,
): Promise<ExecutionResult> {
  let completed: ExecutionResult | undefined;
  for await (const executionSignal of executor.execute(prepared, signal)) {
    await observer?.onSignal(executionSignal);
    if (executionSignal.type === "completed") {
      if (completed) {
        throw new Error("executor emitted more than one completion signal");
      }
      completed = executionSignal.result;
    } else if (completed) {
      throw new Error("executor emitted a signal after completion");
    }
  }
  if (!completed) {
    throw new Error("executor ended without a completion signal");
  }
  return completed;
}
