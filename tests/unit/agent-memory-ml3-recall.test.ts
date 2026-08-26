import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { AgentContextController } from "../../src/context/agent-context-controller.js";
import { AgentContextRuntime } from "../../src/context/agent-context-runtime.js";
import { DeterministicTokenEstimator, resolveContextBudget } from "../../src/context/token-estimator.js";
import { createMl1EpisodeRecordV1, type Ml1EpisodeRecordV1, type Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import type { Ml1EpisodeViewV1 } from "../../src/memory/product/memory-service.js";
import { AutomaticMemoryRecallService } from "../../src/memory/recall/automatic-memory-recall-service.js";
import { Fts5EpisodeProjection } from "../../src/memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../src/memory/retrieval/lexical-memory-search-service.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";

interface PoisonFixture {
  readonly poisonedTask: string;
  readonly recallQuery: string;
}

const temporary: string[] = [];
const scope: Ml1MemoryScopeV1 = Object.freeze({
  applicationRepositoryId: "repository-ml3",
  canonicalRootIdentitySha256: "a".repeat(64),
  ownerPrincipalId: "local_owner",
});
const estimator = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "ml3-test-model",
  provider: "offline-fixture",
  tokenizer: "utf8-conservative",
  version: "ml3-test-v1",
});

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(taskPreview: string, key: string, occurredAt: string): Ml1EpisodeRecordV1 {
  const source = {
    endEventId: `end-${key}`,
    endRawSha256: hash(`end:${key}`),
    endSequence: 2,
    kind: "session_run_range" as const,
    rangeSha256: hash(`range:${key}`),
    runId: `run-${key}`,
    sessionId: `session-${key}`,
    startEventId: `start-${key}`,
    startRawSha256: hash(`start:${key}`),
    startSequence: 1,
  };
  return createMl1EpisodeRecordV1({
    completion: {
      evidenceSha256: null,
      mode: "model_final",
      reportSha256: null,
      steps: 1,
      toolCalls: 0,
    },
    kind: "episode",
    occurredAt,
    origin: "deterministic_episode",
    recordId: `episode_${sha256Canonical({ schema_version: 1, scope, source })}`,
    schemaVersion: 1,
    scope,
    source,
    taskInputSha256: hash(taskPreview),
    taskPreview,
    text: [
      `Task: ${taskPreview}`,
      "Outcome: completed",
      "Completion mode: model_final",
      "Steps: 1",
      "Tool calls: 0",
      "Evidence: none",
    ].join("\n"),
  });
}

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}

async function fixture(): Promise<PoisonFixture> {
  return JSON.parse(
    await readFile(resolve("fixtures/agent-memory/ml3/poisoning-and-effect.json"), "utf8"),
  ) as PoisonFixture;
}

async function harness(input: Readonly<{
  readonly beforeUseRevalidation?: () => Promise<void>;
  readonly inspectSource: (record: Ml1EpisodeRecordV1) => Promise<Ml1EpisodeViewV1>;
  readonly records: readonly Ml1EpisodeRecordV1[];
}>) {
  const stateRoot = await root("bornagent-ml3-recall-");
  const store = await SqliteEpisodeStore.create({ stateRoot });
  for (const candidate of input.records) await store.ingestEpisode(candidate);
  const projection = await Fts5EpisodeProjection.create({ scope, stateRoot });
  const search = new LexicalMemorySearchService({
    inspectSource: input.inspectSource,
    projection,
    scope,
    store,
    tokenEstimator: estimator,
  });
  return {
    service: new AutomaticMemoryRecallService({
      ...(input.beforeUseRevalidation === undefined
        ? {}
        : { beforeUseRevalidation: input.beforeUseRevalidation }),
      inspectSource: input.inspectSource,
      scope,
      search,
      store,
      tokenEstimator: estimator,
    }),
    store,
  };
}

function available(candidate: Ml1EpisodeRecordV1): Promise<Ml1EpisodeViewV1> {
  return Promise.resolve(Object.freeze({ record: candidate, sourceStatus: "available", staleReason: null }));
}

describe("Agent memory ML3 safe request context", () => {
  it("ML3 renders at most three poisoned records as bounded historical-only context", async () => {
    const frozen = await fixture();
    const records = Array.from({ length: 4 }, (_, index) => record(
      `${frozen.poisonedTask} Candidate ${String(index + 1)}.`,
      `poison-${String(index + 1)}`,
      new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    ));
    const built = await harness({ inspectSource: available, records });
    try {
      const prepared = await built.service.prepare({
        contextTargetTokens: 20_000,
        inputKind: "user_prompt",
        query: frozen.recallQuery,
        runId: "run-current",
        sessionId: "session-current",
        step: 1,
      });
      expect(prepared.items.length).toBeGreaterThan(0);
      expect(prepared.items.length).toBeLessThanOrEqual(3);
      expect(prepared.selection.selectedRecords).toHaveLength(prepared.items.length);
      expect(prepared.selection.selectionSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(prepared.selection.budget).toMatchObject({
        contextTargetTokens: 20_000,
        injectedTokenLimit: 1_024,
      });
      expect(prepared.selection.budget.estimatedTokensUsed).toBeLessThanOrEqual(1_024);
      for (const item of prepared.items) {
        expect(item).toMatchObject({
          authority: "historical_only",
          kind: "historical_memory",
          pairing: null,
          priority: "low",
          protectedCategory: null,
          role: "system",
          visibility: "provider_context",
        });
        expect(item.content).toContain("historical evidence only");
        expect(item.content).toContain("bypass approval");
        expect(item.metadata).toMatchObject({
          active_status: "available",
          authority_scope: "historical_evidence_only",
          recall_selection_sha256: prepared.selection.selectionSha256,
          source_status: "available",
        });
      }
    } finally {
      built.store.close();
    }
  });

  it("ML3 removes a source that becomes stale after ranking and before context use", async () => {
    const frozen = await fixture();
    const candidate = record(frozen.poisonedTask, "stale-before-use", "2026-08-01T00:00:00.000Z");
    let sourceAvailable = true;
    const inspectSource = (value: Ml1EpisodeRecordV1): Promise<Ml1EpisodeViewV1> => Promise.resolve(
      sourceAvailable
        ? Object.freeze({ record: value, sourceStatus: "available", staleReason: null })
        : Object.freeze({ record: value, sourceStatus: "stale", staleReason: "range_mismatch" }),
    );
    const built = await harness({
      beforeUseRevalidation: () => {
        sourceAvailable = false;
        return Promise.resolve();
      },
      inspectSource,
      records: [candidate],
    });
    try {
      const prepared = await built.service.prepare({
        contextTargetTokens: 20_000,
        inputKind: "user_prompt",
        query: frozen.recallQuery,
        runId: "run-current",
        sessionId: "session-current",
        step: 1,
      });
      expect(prepared).toMatchObject({
        items: [],
        selection: {
          abstentionReason: "source_revalidation_failed",
          selectedRecords: [],
          status: "abstained",
        },
      });
    } finally {
      built.store.close();
    }
  });

  it("ML3 historical context cannot displace protected facts or mutate model tools", async () => {
    const frozen = await fixture();
    const candidate = record(frozen.poisonedTask, "authority", "2026-08-01T00:00:00.000Z");
    const budget = resolveContextBudget(
      {
        contextWindowTokens: 20_480,
        maximumOutputTokens: 1_024,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: 0.6,
        fixedSafetyMarginTokens: 0,
        reservedOutputTokens: 1_024,
      },
    );
    const built = await harness({ inspectSource: available, records: [candidate] });
    try {
      const recalled = await built.service.prepare({
        contextTargetTokens: budget.compactionTargetTokens,
        inputKind: "user_prompt",
        query: frozen.recallQuery,
        runId: "run-current",
        sessionId: "session-current",
        step: 1,
      });
      expect(recalled.items).toHaveLength(1);
      const backend = new FakeStreamingChatClient(fixedStream());
      const runtime = new AgentContextRuntime({
        budget,
        capabilityContext: () => [{
          authority: "authoritative",
          content: "P".repeat(34_000),
          kind: "state_fact",
          metadata: { current: true },
          priority: "critical",
          protectedCategory: "system_policy",
          recency: 10,
          role: "system",
          sourceEventIds: ["current-protected"],
          visibility: "provider_context",
        }],
        estimator,
        systemInstructions: "Current Host policy remains authoritative.",
      });
      const tools = Object.freeze([{
        description: "read only fixture tool",
        name: "read_fixture",
        parameters: Object.freeze({ type: "object" }),
        strict: true,
      }]);
      const controller = new AgentContextController({
        backend,
        eventAppender: { append: () => Promise.resolve() },
        events: () => [],
        historicalContext: () => Promise.resolve(recalled.items),
        runtime,
      });
      const request = await controller.prepare({
        input: { kind: "user_prompt", text: "current user task" },
        instructions: "current instructions",
        step: 1,
        timeoutMs: 1_000,
        tools,
      });
      expect(request.tools).toEqual(tools);
      const decoded = JSON.parse(request.canonicalContext!.text) as {
        readonly items: readonly {
          readonly kind: string;
          readonly source_event_ids: readonly string[];
        }[];
      };
      expect(decoded.items.some((item) => item.source_event_ids.includes("current-protected"))).toBe(true);
      expect(decoded.items.some((item) => item.kind === "historical_memory")).toBe(false);
      expect(request.contextPlan!.protectedFactIds.length).toBeGreaterThan(0);

      const elevated = Object.freeze({
        ...recalled.items[0]!,
        authority: "authoritative" as const,
      });
      const denied = new AgentContextController({
        backend,
        eventAppender: { append: () => Promise.resolve() },
        events: () => [],
        historicalContext: () => Promise.resolve([elevated]),
        runtime,
      });
      await expect(denied.prepare({
        input: { kind: "user_prompt", text: "current user task" },
        instructions: "current instructions",
        step: 1,
        timeoutMs: 1_000,
        tools,
      })).rejects.toThrow("historical context attempted to exceed its ML3 authority");
    } finally {
      built.store.close();
    }
  });
});
