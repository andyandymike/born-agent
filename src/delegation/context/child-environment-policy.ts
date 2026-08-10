import { sha256Canonical } from "../../completion/canonical-json.js";
import { DelegationError } from "../delegation-errors.js";

export interface ChildEnvironmentPolicyV1 {
  readonly schemaVersion: 1;
  readonly allowedVariableNames: readonly string[];
  readonly fixedValueDigests: readonly { readonly name: string; readonly sha256: string }[];
  readonly deniedCategories: readonly string[];
  readonly policySha256: string;
}

const ALLOWED = new Set(["LANG", "LC_ALL", "NO_COLOR", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]);
const DENIED_PATTERNS = [/KEY/u, /TOKEN/u, /SECRET/u, /PASSWORD/u, /CREDENTIAL/u, /^SSH_/u, /^AWS_/u, /^AZURE_/u, /^GOOGLE_/u, /PROXY/u, /^PATH$/u, /^HOME$/u, /^USERPROFILE$/u];

export function buildChildEnvironmentPolicy(input: {
  readonly requestedVariableNames: readonly string[];
  readonly fixedValues?: Readonly<Record<string, string>>;
}): ChildEnvironmentPolicyV1 {
  const names = [...new Set(input.requestedVariableNames)].sort();
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || !ALLOWED.has(name) || DENIED_PATTERNS.some((pattern) => pattern.test(name))) {
      throw new DelegationError("delegation_authority_expansion", `environment variable ${name} is not allowed in a child envelope`);
    }
  }
  const fixedValueDigests = Object.entries(input.fixedValues ?? {})
    .filter(([name]) => names.includes(name))
    .map(([name, value]) => ({ name, sha256: sha256Canonical({ kind: "child_fixed_environment_value_v1", value }) }))
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  const content = {
    schemaVersion: 1 as const,
    allowedVariableNames: names,
    fixedValueDigests,
    deniedCategories: ["credentials", "home_identity", "network_proxy", "path_injection", "shell_startup", "user_profile"],
  };
  return Object.freeze({ ...content, policySha256: sha256Canonical(content) });
}
