import { MODEL_PROVIDER_CREDENTIAL_VARIABLES } from "./child-environment.js";

const AUTHORIZATION_BEARER = /Authorization\s*:\s*Bearer\s+\S+/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu;
const OPENAI_STYLE_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}/gu;

export function redactSensitiveText(
  value: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }

  return redacted
    .replace(AUTHORIZATION_BEARER, "Authorization: Bearer [redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(OPENAI_STYLE_TOKEN, "[redacted]");
}

export function redactModelProviderSecrets(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return redactSensitiveText(
    value,
    MODEL_PROVIDER_CREDENTIAL_VARIABLES.map((name) => environment[name]),
  );
}
