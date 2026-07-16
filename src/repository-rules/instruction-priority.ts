import type { RepositoryRuleSet } from "./repository-rule-set.js";
import type { RepositoryRulesArtifactReference } from "./repository-rule-set.js";

export const INSTRUCTION_PRIORITY_ORDER = Object.freeze([
  "system_policy" as const,
  "current_user" as const,
  "repository_rules" as const,
  "historical_model_narrative" as const,
  "repository_tool_artifact_content" as const,
]);

export type InstructionSource = (typeof INSTRUCTION_PRIORITY_ORDER)[number];

export interface InstructionAuthority {
  readonly canExpandPermissions: boolean;
  readonly canRelaxCompletionPolicy: boolean;
  readonly priority: number;
  readonly source: InstructionSource;
  readonly trust: "authoritative_policy" | "trusted_user" | "untrusted_content";
}

export interface RepositoryInstruction {
  readonly artifact: RepositoryRulesArtifactReference;
  readonly authority: InstructionAuthority;
  readonly content: string;
  readonly contentSha256: string;
  readonly relativePath: "AGENTS.md";
}

const authorities: Readonly<Record<InstructionSource, InstructionAuthority>> =
  Object.freeze({
    current_user: Object.freeze({
      canExpandPermissions: false,
      canRelaxCompletionPolicy: false,
      priority: 400,
      source: "current_user",
      trust: "trusted_user",
    }),
    historical_model_narrative: Object.freeze({
      canExpandPermissions: false,
      canRelaxCompletionPolicy: false,
      priority: 200,
      source: "historical_model_narrative",
      trust: "untrusted_content",
    }),
    repository_rules: Object.freeze({
      canExpandPermissions: false,
      canRelaxCompletionPolicy: false,
      priority: 300,
      source: "repository_rules",
      trust: "untrusted_content",
    }),
    repository_tool_artifact_content: Object.freeze({
      canExpandPermissions: false,
      canRelaxCompletionPolicy: false,
      priority: 100,
      source: "repository_tool_artifact_content",
      trust: "untrusted_content",
    }),
    system_policy: Object.freeze({
      canExpandPermissions: true,
      canRelaxCompletionPolicy: true,
      priority: 500,
      source: "system_policy",
      trust: "authoritative_policy",
    }),
  });

export function instructionAuthority(source: InstructionSource): InstructionAuthority {
  return authorities[source];
}

export function higherPriorityInstruction(
  left: InstructionSource,
  right: InstructionSource,
): InstructionSource {
  return instructionAuthority(left).priority >= instructionAuthority(right).priority
    ? left
    : right;
}

export function canOverrideInstruction(
  candidate: InstructionSource,
  existing: InstructionSource,
): boolean {
  return instructionAuthority(candidate).priority > instructionAuthority(existing).priority;
}

export function repositoryInstruction(
  rules: RepositoryRuleSet,
): RepositoryInstruction | null {
  const { snapshot } = rules;
  if (snapshot.state === "missing") {
    return null;
  }

  // PHASE10: Root repository rules are structured as untrusted instructions
  // below the current user. Their text is never parsed into PermissionEngine or
  // CompletionPolicy authority, so prompt injection cannot grant capabilities.
  return Object.freeze({
    artifact: snapshot.artifact,
    authority: instructionAuthority("repository_rules"),
    content: snapshot.content,
    contentSha256: snapshot.contentSha256,
    relativePath: snapshot.relativePath,
  });
}
