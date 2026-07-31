import type { ModelQualificationGate } from "./model-qualification-gate.js";
import { ModelQualificationError } from "./model-qualification-gate.js";
import type { ModelQualificationIdentity } from "./model-qualification-identity.js";
import type { ModelCapabilityRegistry } from "./model-capability-registry.js";
import { ModelQualificationStoreError } from "./model-qualification-store.js";

export class RegistryModelQualificationGate implements ModelQualificationGate {
  constructor(
    private readonly registry: ModelCapabilityRegistry,
    private readonly resolveIdentity: (input: {
      readonly endpoint?: string | undefined;
      readonly mode: "plan" | "build";
      readonly model: string;
      readonly policyHash: string;
      readonly policyProfileId: string;
      readonly provider: string;
      readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
    }) => Promise<ModelQualificationIdentity> | ModelQualificationIdentity,
  ) {}

  async requireQualified(input: {
    readonly endpoint?: string | undefined;
    readonly mode: "plan" | "build";
    readonly model: string;
    readonly policyHash: string;
    readonly policyProfileId: string;
    readonly provider: string;
    readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
  }): Promise<{ readonly evidenceSha256: string }> {
    try {
      const identity = await this.resolveIdentity(input);
      if (
        identity.provider !== input.provider ||
        identity.model !== input.model ||
        identity.policyProfileSha256 !== input.policyHash
      ) {
        throw new Error("resolved qualification identity does not match the run");
      }
      const record = await this.registry.requireMode(identity, input.mode);
      return Object.freeze({ evidenceSha256: record.evidenceSha256 });
    } catch (error) {
      throw new ModelQualificationError(
        error instanceof ModelQualificationStoreError &&
          error.code === "qualification_record_corrupt"
          ? "model_qualification_corrupt"
          : "model_unqualified",
        error instanceof Error ? error.message : "model qualification failed",
      );
    }
  }
}
