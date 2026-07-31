import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ModelCapabilityRegistry } from "../../src/model/model-capability-registry.js";
import {
  ModelQualificationLock,
} from "../../src/model/model-qualification-lock.js";
import {
  modelQualificationIdentitySha256,
  type ModelQualificationIdentity,
} from "../../src/model/model-qualification-identity.js";
import {
  createModelQualificationRecord,
  type ModelQualificationRecordV1,
} from "../../src/model/model-qualification-schema.js";
import {
  ModelQualificationStore,
} from "../../src/model/model-qualification-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase16e-"));
  roots.push(value);
  return value;
}

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

function record(): ModelQualificationRecordV1 {
  const common = { code: "passed", durationMs: 1, status: "passed" as const };
  return createModelQualificationRecord({
    createdAt: "2026-07-31T00:00:00.000Z",
    identity,
    identitySha256: modelQualificationIdentitySha256(identity),
    probeResults: [
      { ...common, observed: { deltaCount: 1, terminalText: true }, probeId: "streaming_text_v1", requestCount: 0 },
      { ...common, observed: { argumentsStrict: true, callIdPresent: true, toolCallCount: 1 }, probeId: "strict_tool_args_v1", requestCount: 1 },
      { ...common, observed: { acknowledgementMatched: true, terminalText: true }, probeId: "tool_continuation_v1", requestCount: 1 },
      { ...common, observed: { ordered: true, toolCallCount: 2 }, probeId: "sequential_tools_v1", requestCount: 3 },
      { ...common, observed: { abortObserved: true, cancelLatencyMs: 1, lateEventCount: 0 }, probeId: "cancellation_v1", requestCount: 1 },
      { ...common, observed: { availability: "complete" }, probeId: "usage_semantics_v1", requestCount: 0 },
    ],
    qualifiedModes: ["plan", "build"],
    schemaVersion: 1,
    totalDurationMs: 6,
    totalRequestCount: 6,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 16E capability registry and lock", () => {
  it("atomically round-trips exact evidence and preserves it after a rejected commit", async () => {
    const store = await ModelQualificationStore.create({ root: await root() });
    const valid = record();
    await store.commit(valid);
    expect(await store.read(valid.identitySha256)).toEqual(valid);
    await expect(
      store.commit({ ...valid, evidenceSha256: "9".repeat(64) }),
    ).rejects.toThrow();
    expect(await store.read(valid.identitySha256)).toEqual(valid);

    const registry = new ModelCapabilityRegistry(store);
    await expect(registry.requireMode(identity, "build")).resolves.toEqual(valid);
    await expect(
      registry.lookup({ ...identity, adapterVersion: "phase16e-test-v2" }),
    ).resolves.toMatchObject({ status: "missing" });
  });

  it("fails closed on duplicate-key corruption without deleting the record", async () => {
    const store = await ModelQualificationStore.create({ root: await root() });
    const hash = modelQualificationIdentitySha256(identity);
    await writeFile(store.pathFor(hash), '{"schemaVersion":1,"schemaVersion":1}\n', "utf8");
    await expect(store.read(hash)).rejects.toMatchObject({
      code: "qualification_record_corrupt",
    });
  });

  it("allows one owner and recovers only with same-host dead-process proof", async () => {
    const store = await ModelQualificationStore.create({ root: await root() });
    const hash = modelQualificationIdentitySha256(identity);
    const options = {
      hostFingerprint: "4".repeat(64),
      minimumRecoveryAgeMs: 0,
      now: () => new Date("2026-07-31T00:00:00.000Z"),
      processIdentity: { pid: 111, startIdentity: "5".repeat(64) },
    } as const;
    const first = await ModelQualificationLock.acquire(store.root, hash, {
      ...options,
      nonce: "00000000-0000-4000-8000-000000000001",
      ownerProbe: { probe: async () => "matching" },
    });
    await expect(
      ModelQualificationLock.acquire(store.root, hash, {
        ...options,
        nonce: "00000000-0000-4000-8000-000000000002",
        ownerProbe: { probe: async () => "matching" },
      }),
    ).rejects.toMatchObject({ code: "qualification_busy" });

    await first.release();
    const staleOwner = await ModelQualificationLock.acquire(store.root, hash, {
      ...options,
      nonce: "00000000-0000-4000-8000-000000000003",
      ownerProbe: { probe: async () => "matching" },
    });
    await expect(
      ModelQualificationLock.acquire(store.root, hash, {
        ...options,
        nonce: "00000000-0000-4000-8000-000000000004",
        ownerProbe: { probe: async () => "unknown" },
      }),
    ).rejects.toMatchObject({ code: "qualification_busy" });
    const stalePath = staleOwner.path;
    void stalePath;
    const recovered = await ModelQualificationLock.acquire(store.root, hash, {
      ...options,
      nonce: "00000000-0000-4000-8000-000000000005",
      ownerProbe: { probe: async () => "missing" },
    });
    await recovered.release();
  });
});
