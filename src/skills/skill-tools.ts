import { z } from "zod";

import { toolError } from "../tools/tool-errors.js";
import type { ToolDefinition, ToolRawResult } from "../tools/tool-types.js";
import { SkillError } from "./skill-errors.js";
import type { SkillRuntime } from "./skill-runtime.js";

const listSkillsSchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    query: z.string().max(256).optional(),
  })
  .strict();

const useSkillSchema = z
  .object({
    reason: z.string().max(512).optional(),
    skill_id: z.string().min(1).max(512),
  })
  .strict();

const readSkillResourceSchema = z
  .object({
    max_bytes: z.number().int().min(1).max(256 * 1024).optional(),
    offset: z.number().int().nonnegative().max(2 * 1024 * 1024).optional(),
    resource_id: z.string().min(1).max(80),
    skill_activation_id: z.string().uuid(),
  })
  .strict();

function failure(error: unknown): ToolRawResult {
  if (error instanceof SkillError) {
    const category = error.code === "skill_context_limit_exceeded"
      ? "limit"
      : error.code === "skill_not_available"
        ? "not_found"
        : "permission";
    return {
      error: toolError(category, error.code, error.message),
      ok: false,
    };
  }
  return {
    error: toolError("system", "skill_activation_incomplete", "Skill operation failed safely"),
    ok: false,
  };
}

export function createSkillTools(runtime: SkillRuntime): readonly ToolDefinition<unknown>[] {
  const list: ToolDefinition<z.infer<typeof listSkillsSchema>> = {
    capability: "read",
    description:
      "List bounded metadata for model-invocable Skills in this run-frozen catalog. User-only Skills are intentionally absent.",
    execute: async (input) => {
      try {
        const page = runtime.listModelAllowed({
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.query === undefined ? {} : { query: input.query }),
        });
        return {
          ok: true,
          truncated: false,
          value: page as unknown as Readonly<Record<string, unknown>>,
        };
      } catch (error) {
        return failure(error);
      }
    },
    inputSchema: listSkillsSchema,
    name: "list_skills",
  };
  const use: ToolDefinition<z.infer<typeof useSkillSchema>> = {
    capability: "read",
    description:
      "Activate one exact model-allowed Skill as untrusted reference content. This never grants tools, permissions, providers, network, or script execution.",
    execute: async (input) => {
      try {
        return {
          ok: true,
          truncated: false,
          value: await runtime.activateModel(input.skill_id),
        };
      } catch (error) {
        return failure(error);
      }
    },
    inputSchema: useSkillSchema,
    name: "use_skill",
  };
  const read: ToolDefinition<z.infer<typeof readSkillResourceSchema>> = {
    capability: "read",
    description:
      "Read a bounded UTF-8 slice of a resource declared by an already-active Skill. Raw package paths are never accepted.",
    execute: async (input) => {
      try {
        return {
          ok: true,
          truncated: false,
          value: await runtime.readResource({
            activationId: input.skill_activation_id,
            ...(input.max_bytes === undefined ? {} : { maxBytes: input.max_bytes }),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
            resourceId: input.resource_id,
          }),
        };
      } catch (error) {
        return failure(error);
      }
    },
    inputSchema: readSkillResourceSchema,
    name: "read_skill_resource",
  };
  return Object.freeze([
    list as ToolDefinition<unknown>,
    use as ToolDefinition<unknown>,
    read as ToolDefinition<unknown>,
  ]);
}
