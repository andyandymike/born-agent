import { describe, expect, it } from "vitest";

import {
  createModelQualificationRecord,
  modelQualificationRecordSchema,
  type ModelQualificationRecordInput,
} from "../../src/model/model-qualification-schema.js";
import {
  modelQualificationIdentitySha256,
  type ModelQualificationIdentity,
} from "../../src/model/model-qualification-identity.js";

const identity: ModelQualificationIdentity = {
  adapterId: "deterministic-fake",
  adapterVersion: "phase16e-test-v1",
  continuationCodecVersion: null,
  endpointScope: { kind: "remote_explicit", originSha256: "1".repeat(64) },
  model: "fixture-v1",
  modelRuntimeIdentity: { fixtureVersion: "fixture-v1", kind: "fake_fixture" },
  policyProfileId: "test-profile",
  policyProfileSha256: "2".repeat(64),
  probeSuiteVersion: "phase16e-v1",
  probeToolSchemaSha256: "3".repeat(64),
  provider: "openai",
};

function input(): ModelQualificationRecordInput {
  const common = { code: "passed", durationMs: 1, status: "passed" as const };
  return {
    createdAt: "2026-07-31T00:00:00.000Z",
    identity,
    identitySha256: modelQualificationIdentitySha256(identity),
    probeResults: [
      {
        ...common,
        observed: { deltaCount: 2, terminalText: true },
        probeId: "streaming_text_v1",
        requestCount: 0,
      },
      {
        ...common,
        observed: { argumentsStrict: true, callIdPresent: true, toolCallCount: 1 },
        probeId: "strict_tool_args_v1",
        requestCount: 1,
      },
      {
        ...common,
        observed: { acknowledgementMatched: true, terminalText: true },
        probeId: "tool_continuation_v1",
        requestCount: 1,
      },
      {
        ...common,
        observed: { ordered: true, toolCallCount: 2 },
        probeId: "sequential_tools_v1",
        requestCount: 3,
      },
      {
        ...common,
        observed: { abortObserved: true, cancelLatencyMs: 1, lateEventCount: 0 },
        probeId: "cancellation_v1",
        requestCount: 1,
      },
      {
        ...common,
        observed: { availability: "complete" as const },
        probeId: "usage_semantics_v1",
        requestCount: 0,
      },
    ],
    qualifiedModes: ["plan", "build"],
    schemaVersion: 1,
    totalDurationMs: 6,
    totalRequestCount: 6,
  };
}

describe("Phase 16E qualification record schema", () => {
  it("binds identity, result matrix, counts, and evidence self-hash", () => {
    const record = createModelQualificationRecord(input());
    expect(modelQualificationRecordSchema.parse(record)).toEqual(record);

    expect(
      modelQualificationRecordSchema.safeParse({
        ...record,
        identitySha256: "4".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      modelQualificationRecordSchema.safeParse({
        ...record,
        qualifiedModes: ["plan"],
      }).success,
    ).toBe(false);
    expect(
      modelQualificationRecordSchema.safeParse({
        ...record,
        totalRequestCount: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects extra observed fields and probe reordering", () => {
    const record = createModelQualificationRecord(input());
    const first = record.probeResults[0]!;
    expect(
      modelQualificationRecordSchema.safeParse({
        ...record,
        probeResults: [
          { ...first, observed: { ...first.observed, rawText: "secret" } },
          ...record.probeResults.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      modelQualificationRecordSchema.safeParse({
        ...record,
        probeResults: [record.probeResults[1], first, ...record.probeResults.slice(2)],
      }).success,
    ).toBe(false);
  });
});
