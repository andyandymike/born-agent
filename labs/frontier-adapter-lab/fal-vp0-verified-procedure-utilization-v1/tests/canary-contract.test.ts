import { readFile } from "node:fs/promises";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { describe, expect, it } from "vitest";

import {
  falVp0CanaryObservationSchema,
  falVp0CanaryPackSchema,
  runFalVp0CanaryPack,
} from "../src/mechanics-canaries.js";
import {
  evaluateFalVp0PreProviderBoundary,
  falVp0PreProviderBoundaryDecisionSchema,
} from "../src/pre-provider-boundary.js";

describe("FAL-VP0 pre-provider canaries", () => {
  it("blocks all twelve variants with zero provider and protected-state effects", async () => {
    const pack = falVp0CanaryPackSchema.parse(JSON.parse(await readFile(
      "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/mechanics/canary-pack.json",
      "utf8",
    )));
    const run = runFalVp0CanaryPack({
      pack,
      protocolSha256: sha256Canonical({ protocol: "test" }),
      runId: "canary-test-run",
    });

    expect(run.observations).toHaveLength(12);
    expect(run.results).toHaveLength(6);
    expect(run.results.every((entry) => entry.passed)).toBe(true);
    expect(run.observations.every((entry) =>
      !entry.candidateInvoked &&
      !entry.carrierGenerated &&
      entry.providerCalls === 0 &&
      entry.canonicalMemoryMutations === 0 &&
      entry.currentInstructionMutations === 0 &&
      entry.approvalOrEffectMutations === 0)).toBe(true);
  });

  it("accepts a schema-valid actual failure without relabeling it as pass", () => {
    const content = {
      schemaVersion: 1 as const,
      runId: "canary-failed-run",
      canaryClass: "scope_mismatch" as const,
      variantId: "scope-failed-actual",
      canaryManifestSha256: sha256Canonical({ manifest: 1 }),
      inputSha256: sha256Canonical({ input: 1 }),
      protocolSha256: sha256Canonical({ protocol: 1 }),
      gateImplementationSha256: sha256Canonical({ gate: 1 }),
      decisionStage: "scope" as const,
      candidateInvoked: true,
      carrierGenerated: true,
      providerCalls: 1,
      rejectionCode: "scope_mismatch" as const,
      canonicalMemoryMutations: 1,
      currentInstructionMutations: 0,
      approvalOrEffectMutations: 0,
    };
    const decoded = falVp0CanaryObservationSchema.parse({
      ...content,
      observationSha256: sha256Canonical(content),
    });
    expect(decoded).toMatchObject({ candidateInvoked: true, providerCalls: 1 });
  });

  it("allows the positive boundary only after every typed check passes", () => {
    const decision = evaluateFalVp0PreProviderBoundary({
      sourceState: "settled",
      receiptIntegrity: "valid",
      principalScope: "matches",
      repositoryScope: "matches",
      runtimeVersion: "applicable",
      admissionState: "clean",
      authorityState: "advisory_only",
    });
    expect(falVp0PreProviderBoundaryDecisionSchema.parse(decision)).toMatchObject({
      accepted: true,
      candidateInvoked: true,
      decisionStage: "selected",
      providerCalls: 0,
    });
  });
});
