import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeterministicTokenEstimator } from "../../src/context/token-estimator.js";
import type { Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import { createExplicitMemoryRecordV1 } from "../../src/memory/core/memory-record-v1.js";
import { MemoryService } from "../../src/memory/product/memory-service.js";
import { AutomaticMemoryRecallService } from "../../src/memory/recall/automatic-memory-recall-service.js";
import { Fts5EpisodeProjection } from "../../src/memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../src/memory/retrieval/lexical-memory-search-service.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Agent memory ML4 active explicit recall", () => {
  it("injects the active revision as historical-only context and selects zero after retract", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-ml4-recall-state-"));
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-ml4-recall-workspace-"));
    temporary.push(stateRoot, workspace);
    const scope: Ml1MemoryScopeV1 = Object.freeze({
      applicationRepositoryId: "00000000-0000-4000-8000-000000000421",
      canonicalRootIdentitySha256: "6".repeat(64),
      ownerPrincipalId: "local_owner",
    });
    const store = await SqliteEpisodeStore.create({ stateRoot });
    try {
      const record = createExplicitMemoryRecordV1({
        commandId: "00000000-0000-4000-8000-000000000422",
        kind: "constraint",
        occurredAt: "2026-08-26T06:00:00.000Z",
        revision: 1,
        scope,
        supersedesRevisionId: null,
        text: "Currentnebula changes must stay repository scoped.",
      });
      await store.addExplicitRecord(record);
      const projection = await Fts5EpisodeProjection.create({ scope, stateRoot });
      const memory = new MemoryService({
        repositoryId: scope.applicationRepositoryId,
        scope,
        store,
        workspace,
      });
      const estimator = new DeterministicTokenEstimator({
        bytesPerToken: 3,
        itemOverheadTokens: 8,
        model: "ml4-test-model",
        provider: "offline-fixture",
        tokenizer: "utf8-conservative",
        version: "ml4-test-v1",
      });
      const search = new LexicalMemorySearchService({
        inspectSource: (candidate) => memory.inspectRecordSource(candidate),
        projection,
        scope,
        store,
        tokenEstimator: estimator,
      });
      const recall = new AutomaticMemoryRecallService({
        inspectSource: (candidate) => memory.inspectRecordSource(candidate),
        scope,
        search,
        store,
        tokenEstimator: estimator,
      });

      const selected = await recall.prepare({
        contextTargetTokens: 20_000,
        inputKind: "user_prompt",
        query: "currentnebula repository scope",
        runId: "run-current",
        sessionId: "session-current",
        step: 1,
      });
      expect(selected.selection.selectedRecords).toEqual([
        expect.objectContaining({
          recordId: record.recordId,
          recordSha256: record.recordSha256,
          revisionId: record.revisionId,
          sourceStatus: "available",
        }),
      ]);
      expect(selected.items).toHaveLength(1);
      expect(selected.items[0]).toMatchObject({
        authority: "historical_only",
        kind: "historical_memory",
        metadata: {
          active_status: "available",
          record_id: record.recordId,
          revision_id: record.revisionId,
        },
        priority: "low",
        protectedCategory: null,
      });
      expect(selected.items[0]!.content).toContain("Currentnebula changes must stay repository scoped.");

      await store.retractRecord({
        commandId: "00000000-0000-4000-8000-000000000423",
        occurredAt: "2026-08-26T06:01:00.000Z",
        recordId: record.recordId,
        scope,
      });
      const absent = await recall.prepare({
        contextTargetTokens: 20_000,
        inputKind: "user_prompt",
        query: "currentnebula repository scope",
        runId: "run-current",
        sessionId: "session-current",
        step: 2,
      });
      expect(absent).toMatchObject({
        items: [],
        selection: { selectedRecords: [], status: "abstained" },
      });
    } finally {
      store.close();
    }
  });
});
