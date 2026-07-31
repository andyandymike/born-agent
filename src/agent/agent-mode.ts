import { z } from "zod";

export const agentModeSchema = z.enum(["plan", "build"]);
export const agentModeSourceSchema = z.enum([
  "explicit_cli",
  "explicit_tui",
  "tui_default",
  "legacy_default",
]);

export type AgentMode = z.infer<typeof agentModeSchema>;
export type AgentModeSource = z.infer<typeof agentModeSourceSchema>;

export interface ResolvedAgentMode {
  readonly mode: AgentMode;
  readonly source: AgentModeSource;
}

export function resolveAgentMode(input: {
  readonly explicitMode?: string;
  readonly surface?: "cli" | "tui";
}): ResolvedAgentMode {
  if (input.explicitMode !== undefined) {
    return Object.freeze({
      mode: agentModeSchema.parse(input.explicitMode),
      source: input.surface === "tui" ? "explicit_tui" : "explicit_cli",
    });
  }
  return Object.freeze({ mode: "build", source: "legacy_default" });
}
