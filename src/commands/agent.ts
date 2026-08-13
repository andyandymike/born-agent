import type { AgentCommandOptions, AgentExitCode } from "../agent/agent-types.js";
import {
  executeAgentExecution,
  type FreshTaskExecution,
  type ResumedAgentExecution,
} from "../agent/agent-execution-service.js";
import {
  createAgentExecutionPresentationPort,
  createAgentExecutionRuntimePort,
} from "../agent/agent-execution-cli-ports.js";
import type { CliIO, CliRuntime } from "../cli/types.js";

export type { FreshTaskExecution, ResumedAgentExecution } from "../agent/agent-execution-service.js";

/** CLI parse/render adapter; execution authority lives in the typed owner. */
export async function executeAgent(
  options: AgentCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
  resumedExecution?: ResumedAgentExecution,
  freshTaskExecution?: FreshTaskExecution,
): Promise<AgentExitCode> {
  return executeAgentExecution(
    options,
    createAgentExecutionRuntimePort(runtime, io),
    createAgentExecutionPresentationPort(
      io,
      options.verbose,
      options.reportFormat === "json" ? "json" : "text",
    ),
    resumedExecution,
    freshTaskExecution,
  );
}
