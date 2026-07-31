import type { AgentMode } from "../agent/agent-mode.js";
import { sha256Canonical } from "../completion/canonical-json.js";

export interface ModelQualificationGate {
  requireQualified(input: {
    readonly endpoint?: string | undefined;
    readonly mode: AgentMode;
    readonly model: string;
    readonly policyHash: string;
    readonly policyProfileId: string;
    readonly provider: string;
    readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
  }): Promise<{ readonly evidenceSha256: string }>;
}

export class ModelQualificationError extends Error {
  override readonly name = "ModelQualificationError";

  constructor(
    readonly code: "model_qualification_corrupt" | "model_unqualified",
    message: string,
    readonly exitCode: 1 | 2 = code === "model_qualification_corrupt" ? 1 : 2,
  ) {
    super(message);
  }
}

/**
 * The Phase 16D gate intentionally recognizes only an injected deterministic
 * fake. Phase 16E replaces this port with persisted, exact runtime evidence.
 */
export class BundledFakeModelQualificationGate
  implements ModelQualificationGate
{
  constructor(private readonly enabled: boolean) {}

  async requireQualified(input: {
    readonly mode: AgentMode;
    readonly model: string;
    readonly policyHash: string;
    readonly provider: string;
  }): Promise<{ readonly evidenceSha256: string }> {
    if (!this.enabled) {
      throw new ModelQualificationError(
        "model_unqualified",
        "this provider/model has no explicit Phase 16 capability evidence",
      );
    }
    return Object.freeze({
      evidenceSha256: sha256Canonical({
        fixture_version: "phase16d-v1",
        kind: "bundled_deterministic_fake",
        model: input.model,
        policy_sha256: input.policyHash,
        provider: input.provider,
        schema_version: 1,
      }),
    });
  }
}
