import { toolError } from "../tools/tool-errors.js";
import {
  FatalToolExecutionError,
  type ToolContext,
  type ToolDefinition,
  type ToolRawResult,
} from "../tools/tool-types.js";
import type {
  AgentPlanMutationContext,
  AgentPlanMutationResult,
  AgentPlanStore,
} from "./agent-plan-store.js";
import { renderPlanToolObservation } from "./plan-tool-observation.js";
import {
  updatePlanInputSchema,
  type UpdatePlanInput,
} from "./update-plan-input-schema.js";

export interface UpdatePlanToolOptions {
  readonly context: (toolContext: ToolContext) => AgentPlanMutationContext;
  readonly onResult?: (result: AgentPlanMutationResult) => void;
  readonly store: AgentPlanStore;
}

export async function executeUpdatePlanMutation(
  options: UpdatePlanToolOptions,
  input: UpdatePlanInput,
  toolContext: ToolContext,
): Promise<{
  readonly result: AgentPlanMutationResult;
  readonly toolResult: ToolRawResult;
}> {
  let result: AgentPlanMutationResult;
  try {
    result = await options.store.applyAgentMutation(
      options.context(toolContext),
      input,
    );
  } catch (error) {
    throw new FatalToolExecutionError(
      "storage",
      "update_plan could not establish a durable mutation result",
      { cause: error, workspaceMayHaveChanged: false },
    );
  }
  options.onResult?.(result);
  const output = renderPlanToolObservation(result.observation);
  return {
    result,
    toolResult:
      result.status === "applied"
        ? {
            ...(result.control === null ? {} : { control: result.control }),
            ok: true,
            preSerializedOutput: output,
            truncated: false,
            value: { ...result.observation },
          }
        : {
            error: toolError(
              "tool",
              result.observation.code,
              result.observation.message,
            ),
            ok: false,
            preSerializedOutput: output,
            truncated: false,
            value: { ...result.observation },
          },
  };
}

export function createUpdatePlanTool(
  options: UpdatePlanToolOptions,
): ToolDefinition<UpdatePlanInput> {
  return {
    capability: "mutation",
    description:
      "Propose or revise a reviewable plan, or update progress on the current approved plan. It cannot approve plans or grant permissions.",
    execute: async (input, context) =>
      (await executeUpdatePlanMutation(options, input, context)).toolResult,
    inputSchema: updatePlanInputSchema,
    name: "update_plan",
  };
}
