import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import {
  BackendContinuation,
  type ModelBackend,
  type ModelTurnRequest,
  type PreparedModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import type { CompleteModelUsage, ModelEvent } from "../../../../src/model/model-events.js";

import {
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  memE0ActorQualificationProviderUsageSchema,
} from "../src/actor-qualification.js";
import {
  MemE0ActorQualificationProviderMeter,
  MemE0ActorQualificationProviderMeterError,
} from "../src/actor-qualification-provider-meter.js";

const PRICING_SHA256 = "a".repeat(64);
const PRODUCTION_IMPLEMENTATION_SHA256 = "b".repeat(64);

class TestContinuation extends BackendContinuation {}

interface BackendFixture {
  readonly backend: ModelBackend;
  readonly calls: { value: number };
  readonly prepared: { value: number };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function completeUsage(
  value: Partial<CompleteModelUsage> = {},
): CompleteModelUsage {
  return Object.freeze({
    cacheReadTokens: value.cacheReadTokens ?? 10,
    cacheWriteTokens: value.cacheWriteTokens ?? 5,
    completeness: "complete",
    inputTokens: value.inputTokens ?? 100,
    outputTokens: value.outputTokens ?? 20,
    totalTokens: value.totalTokens ?? 135,
  });
}

function backendFixture(
  stream: (requestIndex: number) => AsyncIterable<ModelEvent>,
  withPreparation = true,
): BackendFixture {
  const calls = { value: 0 };
  const prepared = { value: 0 };
  const capabilities = Object.freeze({
    cancellation: "abort_signal" as const,
    reasoning: "opaque_passthrough" as const,
    streaming: true,
    tools: "best_effort" as const,
    usage: "complete" as const,
  });
  const contextCapacity = Object.freeze({
    contextWindowTokens: 128_000,
    maximumOutputTokens: 2_048,
    source: "pinned_catalog" as const,
  });
  const identity = Object.freeze({
    adapter: "pi-ai",
    adapterVersion: "phase8-pi-runtime-v1",
    configFingerprint: "c".repeat(64),
    model: "deepseek-v4-flash",
    provider: "deepseek" as const,
  });
  const resume = Object.freeze({
    capability: "canonical_only" as const,
    supportsCanonicalDegradedResume: true,
  });
  const prepareTurnRequest = withPreparation
    ? (request: ModelTurnRequest): PreparedModelTurnRequest => {
        prepared.value += 1;
        return Object.freeze({
          adapterEncodingVersion: "test-v1",
          encodedRequestSha256: "d".repeat(64),
          request,
        });
      }
    : undefined;
  const backend: ModelBackend = {
    capabilities,
    contextCapacity,
    identity,
    ...(prepareTurnRequest === undefined ? {} : { prepareTurnRequest }),
    resume,
    async *runTurn(request: ModelTurnRequest): AsyncIterable<ModelEvent> {
      calls.value += 1;
      yield* stream(calls.value);
      void request;
    },
  };
  return { backend, calls, prepared };
}

function successfulStream(
  usage: CompleteModelUsage = completeUsage(),
): (requestIndex: number) => AsyncIterable<ModelEvent> {
  return async function* () {
    yield { type: "usage", usage };
    yield {
      continuation: new TestContinuation(),
      outcome: "text",
      providerRequestId: "raw-provider-response-id",
      type: "turn_completed",
    };
  };
}

function modelRequest(
  index: number,
  items: readonly Readonly<Record<string, unknown>>[] = [
    Object.freeze({ kind: "user_message" }),
  ],
): ModelTurnRequest {
  const text = canonicalJson({
    items,
    schema_version: 1,
  });
  const canonicalContextSha256 = sha256Text(text);
  return Object.freeze({
    canonicalContext: Object.freeze({
      conversationMode: "augment",
      encoding: "bornagent.context.v1+json",
      sha256: canonicalContextSha256,
      text,
    }),
    contextPlan: Object.freeze({
      canonicalContextSha256,
      epoch: index,
      estimatedInputTokens: 12,
      includedItemIds: Object.freeze([`ctx:${String(index)}`]),
      plannerVersion: "test-v1",
      protectedFactIds: Object.freeze([]),
    }),
    input: Object.freeze({
      kind: "user_prompt",
      text: `RAW-SECRET-PROMPT-${String(index)}`,
    }),
    instructions: `RAW-SECRET-INSTRUCTIONS-${String(index)}`,
    timeoutMs: 30_000,
    tools: Object.freeze([Object.freeze({
      description: "RAW-SECRET-TOOL-DESCRIPTION",
      name: "read_file",
      parameters: Object.freeze({ type: "object" }),
      strict: true,
    })]),
  });
}

function meter(): MemE0ActorQualificationProviderMeter {
  return new MemE0ActorQualificationProviderMeter({
    frozenProductionImplementationIdentitySha256:
      PRODUCTION_IMPLEMENTATION_SHA256,
    pricingSha256: PRICING_SHA256,
  });
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<readonly ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return Object.freeze(events);
}

describe("MEM-E0 actor qualification provider meter", () => {
  it("admits only the exact effect-lane excerpt and keeps qualification zero-memory by default", async () => {
    const content = "public synthetic memory for an offline contract test";
    const allowed = { disclosureClass: "public_synthetic" as const, excerptContentSha256: sha256Text(content),
      recordId: `memory_${"c".repeat(64)}`, recordSha256: "d".repeat(64), sourceReferenceSha256: "e".repeat(64) };
    const item = { kind: "historical_memory", authority: "historical_only", content,
      metadata: { record_id: allowed.recordId, record_sha256: allowed.recordSha256, source_reference_sha256: allowed.sourceReferenceSha256 } };
    for (const items of [[item], [{ ...item, content: `${content} changed` }],
      [{ ...item, authority: "system" }], [{ ...item, metadata: { ...item.metadata, record_id: `memory_${"f".repeat(64)}` } }], [], [item, item]]) {
      const fixture = backendFixture(successfulStream());
      const providerMeter = new MemE0ActorQualificationProviderMeter({ pricingSha256: PRICING_SHA256,
        frozenProductionImplementationIdentitySha256: PRODUCTION_IMPLEMENTATION_SHA256, publicSyntheticMemory: allowed });
      const stream = collect(providerMeter.wrap(fixture.backend).runTurn(modelRequest(1, items), new AbortController().signal));
      if (items.length === 1 && items[0] === item) {
        await stream;
        expect(providerMeter.finalize().historicalMemoryItemCount).toBe(1);
        expect(fixture.calls.value).toBe(1);
      } else {
        await expect(stream).rejects.toMatchObject({ failure: { code: "historical_memory_binding_mismatch" } });
        expect(fixture.calls.value).toBe(0);
      }
    }
    const fixture = backendFixture(successfulStream());
    await expect(collect(meter().wrap(fixture.backend).runTurn(modelRequest(1, [item]), new AbortController().signal)))
      .rejects.toMatchObject({ failure: { code: "historical_memory_present" } });
    expect(fixture.calls.value).toBe(0);
  });
  it("preserves the complete backend surface and finalizes ordered hash-only usage evidence", async () => {
    const fixture = backendFixture(successfulStream());
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);

    expect(wrapped.capabilities).toBe(fixture.backend.capabilities);
    expect(wrapped.contextCapacity).toBe(fixture.backend.contextCapacity);
    expect(wrapped.identity).toBe(fixture.backend.identity);
    expect(wrapped.resume).toBe(fixture.backend.resume);
    expect(wrapped.prepareTurnRequest?.(modelRequest(0))).toMatchObject({
      adapterEncodingVersion: "test-v1",
      encodedRequestSha256: "d".repeat(64),
    });
    expect(fixture.prepared.value).toBe(1);

    for (let index = 1; index <= 4; index += 1) {
      await expect(
        collect(wrapped.runTurn(modelRequest(index), new AbortController().signal)),
      ).resolves.toHaveLength(2);
    }

    const observation = providerMeter.finalize();
    expect(observation).toEqual({
      historicalMemoryItemCount: 0,
      providerUsage: {
        accountedPeakCostUsdMicros: 308,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        completeUsageEvents: 4,
        inputTokens: 400,
        isProviderInvoice: false,
        maximumAuthorizedCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        maximumObservedOutputTokensPerRequest: 20,
        outputTokens: 80,
        partialUsageEvents: 0,
        pricingSha256: PRICING_SHA256,
        requestObservationSha256s: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/u),
        ]),
        requestsCompleted: 4,
        requestsStarted: 4,
        retries: 0,
        retryPolicyEvidence: {
          configuredMaximumRetries: 0,
          evidenceKind: "frozen_production_implementation_identity",
          frozenProductionImplementationIdentitySha256:
            PRODUCTION_IMPLEMENTATION_SHA256,
          transportRetriesObserved: null,
        },
        totalTokens: 540,
        usageObservationSha256s: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/u),
        ]),
      },
    });
    expect(observation.providerUsage.requestObservationSha256s).toHaveLength(4);
    expect(observation.providerUsage.usageObservationSha256s).toHaveLength(4);
    expect(() =>
      memE0ActorQualificationProviderUsageSchema.parse(
        observation.providerUsage,
      )
    ).not.toThrow();
    expect(new Set(observation.providerUsage.requestObservationSha256s).size).toBe(4);
    expect(new Set(observation.providerUsage.usageObservationSha256s).size).toBe(4);
    const persisted = JSON.stringify(observation);
    expect(persisted).not.toContain("RAW-SECRET");
    expect(persisted).not.toContain("raw-provider-response-id");
    expect(providerMeter.finalize()).toBe(observation);
  });

  it("preserves an absent optional prepareTurnRequest instead of inventing one", () => {
    const fixture = backendFixture(successfulStream(), false);
    expect(meter().wrap(fixture.backend).prepareTurnRequest).toBeUndefined();
  });

  it("accepts the exact six-request, 12288-output, and 100000-total boundary", async () => {
    const fixture = backendFixture((requestIndex) => successfulStream(
      completeUsage({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: requestIndex <= 4 ? 14_619 : 14_618,
        outputTokens: 2_048,
        totalTokens: requestIndex <= 4 ? 16_667 : 16_666,
      }),
    )(requestIndex));
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);
    for (let index = 1; index <= 6; index += 1) {
      await collect(wrapped.runTurn(modelRequest(index), new AbortController().signal));
    }

    expect(providerMeter.finalize().providerUsage).toMatchObject({
      accountedPeakCostUsdMicros:
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
      maximumObservedOutputTokensPerRequest: 2_048,
      outputTokens: 12_288,
      totalTokens: 100_000,
    });
  });

  it("blocks a seventh provider request before entering the backend and keeps a conservative snapshot", async () => {
    const fixture = backendFixture(successfulStream(completeUsage({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })));
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);
    for (let index = 1; index <= 6; index += 1) {
      await collect(wrapped.runTurn(modelRequest(index), new AbortController().signal));
    }

    await expect(
      collect(wrapped.runTurn(modelRequest(7), new AbortController().signal)),
    ).rejects.toMatchObject({
      failure: {
        code: "provider_request_ceiling_exceeded",
        kind: "cap",
        limit: 6,
        observed: 7,
        stage: "before_provider_request",
      },
    });
    expect(fixture.calls.value).toBe(6);
    expect(providerMeter.snapshot()).toMatchObject({
      providerUsage: {
        accountedPeakCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        requestsCompleted: 6,
        requestsStarted: 6,
      },
    });
    expect(() => providerMeter.finalize()).toThrow(
      MemE0ActorQualificationProviderMeterError,
    );
  });

  it("snapshots a possibly billed request without usage at the full authorized reserve", async () => {
    const fixture = backendFixture(async function* () {
      yield* [] as readonly ModelEvent[];
    });
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);

    await expect(
      collect(wrapped.runTurn(modelRequest(1), new AbortController().signal)),
    ).rejects.toMatchObject({
      failure: {
        code: "stream_ended_without_turn_completed",
        kind: "contract",
      },
    });
    expect(providerMeter.snapshot()).toMatchObject({
      providerUsage: {
        accountedPeakCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        completeUsageEvents: 0,
        partialUsageEvents: 0,
        requestObservationSha256s: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
        requestsCompleted: 0,
        requestsStarted: 1,
        usageObservationSha256s: [],
      },
    });
    expect(() => providerMeter.finalize()).toThrow(
      MemE0ActorQualificationProviderMeterError,
    );
  });

  it("fails closed before provider access when canonical context contains historical memory", async () => {
    const fixture = backendFixture(successfulStream());
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);

    await expect(collect(wrapped.runTurn(
      modelRequest(1, [Object.freeze({ kind: "historical_memory" })]),
      new AbortController().signal,
    ))).rejects.toMatchObject({
      failure: {
        code: "historical_memory_present",
        kind: "contract",
        observed: 1,
        stage: "before_provider_request",
      },
    });
    expect(fixture.calls.value).toBe(0);
    expect(providerMeter.snapshot()).toMatchObject({
      historicalMemoryItemCount: 1,
      providerUsage: {
        accountedPeakCostUsdMicros: 0,
        requestsStarted: 0,
      },
    });
  });

  it("records cache tokens in total and rejects a mismatched complete usage contract", async () => {
    const fixture = backendFixture(successfulStream(completeUsage({
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      inputTokens: 13,
      outputTokens: 17,
      totalTokens: 47,
    })));
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);

    await expect(
      collect(wrapped.runTurn(modelRequest(1), new AbortController().signal)),
    ).rejects.toMatchObject({
      failure: {
        code: "invalid_usage",
        kind: "contract",
        observed: 47,
      },
    });
    expect(providerMeter.snapshot()).toMatchObject({
      providerUsage: {
        accountedPeakCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        cacheReadTokens: 7,
        cacheWriteTokens: 11,
        completeUsageEvents: 1,
        inputTokens: 13,
        outputTokens: 17,
        requestsCompleted: 0,
        requestsStarted: 1,
        totalTokens: 47,
        usageObservationSha256s: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      },
    });
  });

  it("enforces the 2048 per-request output ceiling and retains the billed usage hash", async () => {
    const fixture = backendFixture(successfulStream(completeUsage({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 1,
      outputTokens: 2_049,
      totalTokens: 2_050,
    })));
    const providerMeter = meter();
    const wrapped = providerMeter.wrap(fixture.backend);

    await expect(
      collect(wrapped.runTurn(modelRequest(1), new AbortController().signal)),
    ).rejects.toMatchObject({
      failure: {
        code: "per_request_output_token_ceiling_exceeded",
        kind: "cap",
        limit: 2_048,
        observed: 2_049,
      },
    });
    expect(providerMeter.snapshot()).toMatchObject({
      providerUsage: {
        accountedPeakCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        maximumObservedOutputTokensPerRequest: 2_049,
        outputTokens: 2_049,
        requestsCompleted: 0,
        requestsStarted: 1,
        usageObservationSha256s: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      },
    });
  });
});
