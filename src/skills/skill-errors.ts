export type SkillErrorCode =
  | "skill_activation_incomplete"
  | "skill_already_active"
  | "skill_content_stale"
  | "skill_context_limit_exceeded"
  | "skill_entry_invalid"
  | "skill_not_available"
  | "skill_not_model_invocable"
  | "skill_resource_invalid"
  | "skill_resource_not_declared";

export class SkillError extends Error {
  override readonly name = "SkillError";

  constructor(
    readonly code: SkillErrorCode,
    message: string,
    readonly exitCode: 2 | 8 = code === "skill_not_available" ? 2 : 8,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
