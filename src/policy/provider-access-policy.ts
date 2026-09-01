import type { ProviderId } from "../model/model-backend.js";
import { RuntimePolicyError } from "./policy-errors.js";
import { resolveProviderPolicyRequest, type EffectiveRuntimePolicy, type ResolvedProviderPolicyRequest } from "./policy-resolver.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { canonicalPolicyProfileData } from "./runtime-policy-schema.js";
import { credentialVariableForProvider } from "../security/credential-resolver.js";

export function credentialSecretsForPolicy(
  policy: EffectiveRuntimePolicy,
  provider: ProviderId,
  environment: Readonly<Record<string, string | undefined>>,
): readonly (string | undefined)[] {
  if (policy.entry.profile.modelAccess.kind === "local_free") {
    // PHASE15: local-free means credential non-access, not merely credential
    // non-use. Keep this branch before either secret-bearing property lookup.
    return Object.freeze([]);
  }
  const variableName = credentialVariableForProvider(provider);
  if (variableName === null) {
    throw new RuntimePolicyError(
      "policy_provider_denied",
      "remote policy cannot authorize a credential-free provider",
    );
  }
  return Object.freeze([environment[variableName]]);
}

export class ProviderRequestLedger {
  #reserved = 0;

  constructor(private readonly maximum: number | null) {}

  reserve(): number {
    // PHASE15: a failed remote send can still affect billing/quota, so the
    // request slot is consumed immediately before transport and never refunded.
    if (this.maximum !== null && this.#reserved >= this.maximum) {
      throw new RuntimePolicyError("policy_request_ceiling_exceeded", "provider request ceiling is exhausted");
    }
    this.#reserved += 1;
    return this.#reserved;
  }

  report(): { readonly maximum: number | null; readonly reserved: number } {
    return Object.freeze({ maximum: this.maximum, reserved: this.#reserved });
  }
}

export class ProviderAccessPolicy {
  readonly #ledger: ProviderRequestLedger;

  constructor(readonly effective: EffectiveRuntimePolicy) {
    const access = effective.entry.profile.modelAccess;
    this.#ledger = new ProviderRequestLedger(
      access.kind === "remote_explicit" ? access.limits.maxProviderRequestsPerRun : null,
    );
  }

  resolve(input: {
    readonly endpoint?: string | undefined;
    readonly model: string;
    readonly provider: string;
    readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
  }): ResolvedProviderPolicyRequest {
    return resolveProviderPolicyRequest(this.effective, input);
  }

  assertFrozen(input: {
    readonly endpoint: string | undefined;
    readonly model: string;
    readonly provider: ProviderId;
    readonly source: "in_process_test" | "local_ollama" | "provider_network";
  }): void {
    // PHASE15: transport revalidates the frozen selection rather than trusting
    // an earlier CLI decision after credentials/runtime objects exist.
    if (
      sha256Canonical(canonicalPolicyProfileData(this.effective.entry.profile)) !==
      this.effective.entry.profileSha256
    ) {
      throw new RuntimePolicyError(
        "policy_profile_drift",
        "runtime policy hash drifted after preflight",
        1,
      );
    }
    const resolved = this.resolve(input);
    if (
      resolved.provider !== input.provider ||
      resolved.model !== input.model ||
      resolved.endpoint !== input.endpoint ||
      resolved.source !== input.source
    ) {
      throw new RuntimePolicyError("policy_profile_drift", "provider request drifted from the frozen runtime policy", 1);
    }
  }

  reserveRemoteSend(): number {
    return this.#ledger.reserve();
  }

  report(): ReturnType<ProviderRequestLedger["report"]> {
    return this.#ledger.report();
  }
}
