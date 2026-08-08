import { describe, expect, it } from "vitest";

import { ContextProjector, type ProjectableContextEvent } from "../../src/context/context-projector.js";
import { DeterministicTokenEstimator } from "../../src/context/token-estimator.js";

const HASH = {
  engine: "a".repeat(64),
  firstGeneration: "b".repeat(64),
  firstSource: "c".repeat(64),
  rules: "d".repeat(64),
  secondGeneration: "e".repeat(64),
  secondSource: "f".repeat(64),
};

const estimator = new DeterministicTokenEstimator({
  bytesPerToken: 1,
  itemOverheadTokens: 0,
  model: "fixture",
  provider: "fake",
  tokenizer: "utf8-byte-upper-bound",
  version: "phase17d-v1",
});

function event(sessionSeq: number, type: string, data: unknown): ProjectableContextEvent {
  return { data, eventId: `repo-event-${String(sessionSeq)}`, runId: "run-one", runSeq: sessionSeq, sessionSeq, type };
}

function source(sessionSeq: number, sourceStateSha256: string): ProjectableContextEvent {
  return event(sessionSeq, "repository.source.snapshot.captured", {
    coverage: "complete",
    entries_sha256: "1".repeat(64),
    file_count: 2,
    inventory_policy_sha256: "2".repeat(64),
    skipped_count: 0,
    source_kind: "filesystem",
    source_state_sha256: sourceStateSha256,
  });
}

function selected(sessionSeq: number, sourceStateSha256: string, generationSha256: string): ProjectableContextEvent {
  return event(sessionSeq, "repository.index.selected", {
    build_mode: "cold",
    cache_manifest_sha256: "3".repeat(64),
    counts: { failed: 0, indexed: 2, references: 1, symbols: 2, units: 2, unsupported: 0 },
    coverage: "complete",
    engine_id: "typescript-language-service",
    engine_identity_sha256: HASH.engine,
    generation_sha256: generationSha256,
    rule_manifest_sha256: HASH.rules,
    source_state_sha256: sourceStateSha256,
  });
}

describe("Phase 17D bounded repository context", () => {
  it("projects only the latest source/index identities and no eager symbol map", () => {
    const events = [
      source(1, HASH.firstSource),
      selected(2, HASH.firstSource, HASH.firstGeneration),
      source(3, HASH.secondSource),
      selected(4, HASH.secondSource, HASH.secondGeneration),
    ];
    const projected = new ContextProjector(estimator).project({
      epoch: 0,
      events,
      repositoryRules: null,
      systemInstructions: [],
    });
    const repository = projected.items.filter((item) => item.protectedCategory === "repository_state");
    expect(repository).toHaveLength(2);
    expect(repository.map((item) => item.sourceEventIds[0]).sort()).toEqual(["repo-event-3", "repo-event-4"]);
    expect(repository.every((item) => item.authority === "authoritative")).toBe(true);
    expect(repository.map((item) => item.content).join("\n")).toContain(HASH.secondGeneration);
    expect(repository.map((item) => item.content).join("\n")).not.toContain(HASH.firstGeneration);
    expect(repository.map((item) => item.content).join("\n")).not.toContain("relativePath");
    expect(repository.reduce((bytes, item) => bytes + Buffer.byteLength(item.content, "utf8"), 0)).toBeLessThan(2_048);
  });

  it("keeps an invalidation after the selected generation as an unresolved protected fact", () => {
    const projected = new ContextProjector(estimator).project({
      epoch: 0,
      events: [
        source(1, HASH.firstSource),
        selected(2, HASH.firstSource, HASH.firstGeneration),
        event(3, "repository.index.invalidated", {
          changed_path_count: 1,
          current_source_state_sha256: HASH.secondSource,
          old_generation_sha256: HASH.firstGeneration,
          reason: "source_changed",
        }),
      ],
      repositoryRules: null,
      systemInstructions: [],
    });
    expect(projected.items.some((item) =>
      item.protectedCategory === "unresolved_errors" && item.content.includes("source_changed"),
    )).toBe(true);
  });
});
