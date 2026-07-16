export const MODEL_PROVIDER_CREDENTIAL_VARIABLES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const);

const MODEL_PROVIDER_CREDENTIAL_NAMES = new Set<string>(
  MODEL_PROVIDER_CREDENTIAL_VARIABLES,
);

export function sanitizeChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    // PHASE8: Windows treats environment names case-insensitively, while test
    // doubles and worker environments may not. Compare canonically and omit
    // every casing variant so no child process receives a paid-provider key.
    if (
      value !== undefined &&
      !MODEL_PROVIDER_CREDENTIAL_NAMES.has(name.toUpperCase())
    ) {
      sanitized[name] = value;
    }
  }
  return Object.freeze(sanitized);
}
