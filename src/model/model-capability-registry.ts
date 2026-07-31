import type { AgentMode } from "../agent/agent-mode.js";
import {
  modelQualificationIdentitySchema,
  modelQualificationIdentitySha256,
  type ModelQualificationIdentity,
} from "./model-qualification-identity.js";
import type { ModelQualificationRecordV1 } from "./model-qualification-schema.js";
import type { ModelQualificationStore } from "./model-qualification-store.js";

export type ModelCapabilityLookup =
  | { readonly record: ModelQualificationRecordV1; readonly status: "valid" }
  | { readonly identitySha256: string; readonly status: "missing" };

export class ModelCapabilityRegistry {
  constructor(private readonly store: ModelQualificationStore) {}

  async lookup(identityInput: ModelQualificationIdentity): Promise<ModelCapabilityLookup> {
    const identity = modelQualificationIdentitySchema.parse(identityInput);
    const identitySha256 = modelQualificationIdentitySha256(identity);
    const record = await this.store.read(identitySha256);
    return record === null
      ? Object.freeze({ identitySha256, status: "missing" })
      : Object.freeze({ record, status: "valid" });
  }

  async requireMode(
    identity: ModelQualificationIdentity,
    mode: AgentMode,
  ): Promise<ModelQualificationRecordV1> {
    const lookup = await this.lookup(identity);
    if (lookup.status === "missing") {
      throw new Error("model qualification evidence is missing or stale");
    }
    if (!lookup.record.qualifiedModes.includes(mode)) {
      throw new Error(`model qualification evidence does not cover ${mode} mode`);
    }
    return lookup.record;
  }
}
