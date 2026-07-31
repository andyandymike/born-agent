import { describe, expect, it } from "vitest";

import {
  modelQualificationIdentitySha256,
  modelQualificationIdentitySchema,
  type ModelQualificationIdentity,
} from "../../src/model/model-qualification-identity.js";

const base: ModelQualificationIdentity = {
  adapterId: "pi-ai",
  adapterVersion: "0.80.7",
  continuationCodecVersion: null,
  endpointScope: { kind: "literal_loopback", origin: "http://127.0.0.1:11434" },
  model: "qwen3:1.7b",
  modelRuntimeIdentity: {
    digest: `sha256:${"a".repeat(64)}`,
    kind: "ollama_digest",
  },
  policyProfileId: "local-free-v1",
  policyProfileSha256: "b".repeat(64),
  probeSuiteVersion: "phase16e-v1",
  probeToolSchemaSha256: "c".repeat(64),
  provider: "ollama",
};

describe("Phase 16E qualification identity", () => {
  it("changes its canonical key for every authority-bearing field", () => {
    const original = modelQualificationIdentitySha256(base);
    const variants: ModelQualificationIdentity[] = [
      { ...base, provider: "openai" },
      { ...base, model: "qwen3:other" },
      { ...base, adapterId: "pi-ai-next" },
      { ...base, adapterVersion: "0.80.8" },
      { ...base, continuationCodecVersion: "codec-v1" },
      { ...base, endpointScope: { kind: "remote_explicit", originSha256: "d".repeat(64) } },
      { ...base, modelRuntimeIdentity: { fixtureVersion: "v2", kind: "fake_fixture" } },
      { ...base, policyProfileId: "local-free-v2" },
      { ...base, policyProfileSha256: "e".repeat(64) },
      { ...base, probeSuiteVersion: "phase16e-v2" },
      { ...base, probeToolSchemaSha256: "f".repeat(64) },
    ];
    expect(new Set(variants.map(modelQualificationIdentitySha256)).size).toBe(
      variants.length,
    );
    expect(variants.every((variant) => modelQualificationIdentitySha256(variant) !== original)).toBe(true);
  });

  it("accepts only credential-free bounded endpoint identity", () => {
    expect(modelQualificationIdentitySchema.parse(base)).toEqual(base);
    expect(
      modelQualificationIdentitySchema.safeParse({
        ...base,
        endpointScope: { kind: "literal_loopback", origin: "http://user:key@127.0.0.1:11434" },
      }).success,
    ).toBe(false);
  });
});
