import { serializeToolError, toolError } from "./tool-errors.js";
import type {
  ToolExecution,
  ToolInvocation,
  ToolRegistryLike,
} from "./tool-types.js";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A physical registry boundary for delegated actors. The underlying registry
 * may contain package capabilities required by ordinary agents, but neither
 * model discovery nor a forged tool call can cross this exact allowlist.
 */
export class RestrictedToolRegistry implements ToolRegistryLike {
  readonly artifactOutput?: NonNullable<ToolRegistryLike["artifactOutput"]>;
  readonly completion?: ToolRegistryLike["completion"];
  readonly modelDefinitions: ToolRegistryLike["modelDefinitions"];
  readonly #allowed: ReadonlySet<string>;

  constructor(
    private readonly base: ToolRegistryLike,
    allowedToolIds: readonly string[],
  ) {
    if (new Set(allowedToolIds).size !== allowedToolIds.length) {
      throw new TypeError("delegated tool allowlist must be unique");
    }
    const available = new Map(base.modelDefinitions.map((definition) => [definition.name, definition]));
    for (const id of allowedToolIds) {
      if (!available.has(id)) {
        throw new TypeError(`delegated tool is unavailable in the frozen runtime: ${id}`);
      }
    }
    this.#allowed = new Set(allowedToolIds);
    this.modelDefinitions = [...allowedToolIds]
      .sort(compare)
      .map((id) => available.get(id)!);
    if (base.artifactOutput !== undefined) this.artifactOutput = base.artifactOutput;
    if (this.#allowed.has("finish_task") && base.completion !== undefined) {
      this.completion = base.completion;
    }
  }

  execute(invocation: ToolInvocation, signal: AbortSignal): Promise<ToolExecution> {
    if (!this.#allowed.has(invocation.name)) {
      // PHASE20: filtering model definitions is not authority. A buggy or
      // adversarial backend can still name a hidden tool, so execution must
      // independently fail closed before reaching the package registry.
      return Promise.resolve(serializeToolError(toolError(
        "permission",
        "delegated_tool_not_allowed",
        "tool is outside the delegated child envelope",
      )));
    }
    return this.base.execute(invocation, signal);
  }
}
