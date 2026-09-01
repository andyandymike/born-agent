import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { modelQualificationIdentitySha256 } from "../../../../src/model/model-qualification-identity.js";
import {
  createModelQualificationRecord,
  type ModelQualificationRecordV1,
} from "../../../../src/model/model-qualification-schema.js";
import {
  loadMemE0ActorQualificationFixture,
  type MemE0ActorQualificationConfig,
} from "../src/actor-qualification-fixture.js";
import {
  validateMemE0ActorQualificationModelEvidence,
  type MemE0ActorQualificationModelEvidenceInput,
} from "../src/actor-qualification-model-evidence.js";

const sha = (value: string): string => value.repeat(64);

function qualificationRecord(
  config: MemE0ActorQualificationConfig,
  changes?: Readonly<{
    readonly identityModel?: string;
    readonly sequentialToolsPassed?: boolean;
    readonly usageComplete?: boolean;
    readonly zeroRequests?: boolean;
  }>,
): ModelQualificationRecordV1 {
  const identity = {
    ...config.genericModelQualification.expectedIdentity,
    model: changes?.identityModel ??
      config.genericModelQualification.expectedIdentity.model,
  };
  const requestCount = changes?.zeroRequests === true ? 0 : 1;
  const sequentialToolsPassed = changes?.sequentialToolsPassed !== false;
  const common = {
    code: "passed",
    durationMs: 1,
    status: "passed" as const,
  };
  return createModelQualificationRecord({
    createdAt: "2026-08-31T00:00:00.000Z",
    identity,
    identitySha256: modelQualificationIdentitySha256(identity),
    probeResults: [
      {
        ...common,
        observed: { deltaCount: 1, terminalText: true },
        probeId: "streaming_text_v1",
        requestCount,
      },
      {
        ...common,
        observed: {
          argumentsStrict: true,
          callIdPresent: true,
          toolCallCount: 1,
        },
        probeId: "strict_tool_args_v1",
        requestCount,
      },
      {
        ...common,
        observed: { acknowledgementMatched: true, terminalText: true },
        probeId: "tool_continuation_v1",
        requestCount,
      },
      {
        ...common,
        code: sequentialToolsPassed ? "passed" : "failed",
        observed: { ordered: sequentialToolsPassed, toolCallCount: 2 },
        probeId: "sequential_tools_v1",
        requestCount,
        status: sequentialToolsPassed ? "passed" as const : "failed" as const,
      },
      {
        ...common,
        observed: {
          abortObserved: true,
          cancelLatencyMs: 1,
          lateEventCount: 0,
        },
        probeId: "cancellation_v1",
        requestCount,
      },
      {
        ...common,
        code: changes?.usageComplete === false ? "failed" : "passed",
        observed: {
          availability: changes?.usageComplete === false
            ? "partial" as const
            : "complete" as const,
        },
        probeId: "usage_semantics_v1",
        requestCount,
        status: changes?.usageComplete === false
          ? "failed" as const
          : "passed" as const,
      },
    ],
    qualifiedModes: sequentialToolsPassed ? ["plan", "build"] : ["plan"],
    schemaVersion: 1,
    totalDurationMs: 6,
    totalRequestCount: requestCount * 6,
  });
}

function validationInput(
  config: MemE0ActorQualificationConfig,
  record: ModelQualificationRecordV1,
): MemE0ActorQualificationModelEvidenceInput {
  const recordSha256 = sha256Canonical(record);
  return {
    actorConfig: config,
    developmentEvidence: {
      descriptor: {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        qualificationCompletedRequestCount: record.totalRequestCount,
        qualificationEvidenceKind: "model_capability_probe_suite",
        qualificationEvidenceRef:
          ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/ds0-00000000-0000-4000-8000-000000000000/qualification-record.json",
        qualificationEvidenceSha256: record.evidenceSha256,
        qualificationRequestCount: record.totalRequestCount,
        qualificationStatus: "passed",
        qualificationUsageCapability: "complete",
        schemaVersion: 1,
      },
      ds0ActorReportSha256: null,
      ds0EntryEvidenceClass: "functional_entry_only",
      ds0ObservationSha256: sha("a"),
      ds0PricingSha256: sha("b"),
      ds0ProtocolSha256: sha("c"),
      ds0QualificationRecordSha256: recordSha256,
    },
    record,
  };
}

describe("FAL MEM-E0 run-local generic DS0 model evidence", () => {
  it("returns only a RemoteLiveQualifiedModelEvidence descriptor and receipt-safe hashes", async () => {
    const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
    const record = qualificationRecord(fixture.config);
    const result = validateMemE0ActorQualificationModelEvidence(
      validationInput(fixture.config, record),
    );

    expect(result.descriptor).toEqual({
      backend: "deepseek",
      baseUrl: "https://api.deepseek.com",
      endpointScope: "remote_https",
      kind: "remote_live_qualified",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      qualificationCompletedRequestCount: 6,
      qualificationEvidenceKind: "model_capability_probe_suite",
      qualificationEvidenceRef:
        ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/ds0-00000000-0000-4000-8000-000000000000/qualification-record.json",
      qualificationEvidenceSha256: record.evidenceSha256,
      qualificationRequestCount: 6,
      qualificationStatus: "passed",
      qualificationUsageCapability: "complete",
      remoteBillableRequests: 6,
      remoteQualificationRequests: 6,
      requestCountScope: "qualification_only",
    });
    expect(result).toMatchObject({
      modelQualificationEvidenceSha256: record.evidenceSha256,
      modelQualificationIdentitySha256: record.identitySha256,
      modelQualificationObservationSha256: sha("a"),
      modelQualificationPricingSha256: sha("b"),
      modelQualificationProtocolSha256: sha("c"),
      modelQualificationRecordSha256: sha256Canonical(record),
    });
    expect(result).not.toHaveProperty("record");
    expect(result).not.toHaveProperty("observation");
    expect(result).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain(record.createdAt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.descriptor)).toBe(true);
  });

  it("rejects exact identity drift even when the replacement record self-hashes", async () => {
    const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
    const record = qualificationRecord(fixture.config, {
      identityModel: "deepseek-v4-flash-drifted",
    });
    expect(() => validateMemE0ActorQualificationModelEvidence(
      validationInput(fixture.config, record),
    )).toThrow(/identity/u);
  });

  it("rejects missing build, incomplete usage, and zero-request evidence", async () => {
    const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
    for (const [record, reason] of [
      [qualificationRecord(fixture.config, { sequentialToolsPassed: false }), /build/u],
      [qualificationRecord(fixture.config, { usageComplete: false }), /usage/u],
      [qualificationRecord(fixture.config, { zeroRequests: true }), /minimum|request count/u],
    ] as const) {
      expect(() => validateMemE0ActorQualificationModelEvidence(
        validationInput(fixture.config, record),
      )).toThrow(reason);
    }
  });

  it("rejects descriptor and record hash/count drift", async () => {
    const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
    const record = qualificationRecord(fixture.config);
    const wrongCount = structuredClone(
      validationInput(fixture.config, record),
    );
    wrongCount.developmentEvidence.descriptor.qualificationRequestCount = 5;
    expect(() => validateMemE0ActorQualificationModelEvidence(
      wrongCount,
    )).toThrow(/completed qualification|request count/u);

    const original = validationInput(fixture.config, record);
    const wrongHash = {
      ...original,
      developmentEvidence: {
        ...original.developmentEvidence,
        ds0QualificationRecordSha256: sha("f"),
      },
    };
    expect(() => validateMemE0ActorQualificationModelEvidence(
      wrongHash,
    )).toThrow(/binding/u);
  });

  it("contains no environment, credential, or network access", async () => {
    const source = await readFile(
      resolve(
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-model-evidence.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\bprocess\.env\b/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/DEEPSEEK_API_KEY/u);
  });
});
