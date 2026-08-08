import { describe, expect, it } from "vitest";

import {
  applyRepositoryJobState,
  invalidateRepositoryStatus,
  repositoryStatusProjectionSchema,
} from "../../src/repository-intelligence/repository-status-projection.js";
import { BornAgentViewComponent } from "../../src/tui/components/bornagent-view.js";
import { createInitialTuiEphemeralState } from "../../src/tui/tui-ephemeral-state.js";
import { reducePersistedEvent, type TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";

const SHA = {
  engine: "a".repeat(64),
  generation: "b".repeat(64),
  rules: "c".repeat(64),
  source: "d".repeat(64),
};

function event(type: string, data: unknown, sessionSeq: number): TuiPersistedEvent {
  return {
    data,
    eventId: `00000000-0000-4000-8000-${String(sessionSeq).padStart(12, "0")}`,
    runId: "00000000-0000-4000-8000-000000000100",
    runSeq: sessionSeq,
    scope: "run",
    sessionId: "00000000-0000-4000-8000-000000000200",
    sessionSeq,
    sourceSchemaVersion: 2,
    timestamp: "2026-08-08T00:00:00.000Z",
    type,
  } as unknown as TuiPersistedEvent;
}

describe("Phase 17E repository TUI projection", () => {
  it("renders the same bounded ready/dirty identities used by durable replay", () => {
    let view = createInitialTuiViewState();
    view = reducePersistedEvent(view, event("repository.source.snapshot.captured", {
      coverage: "complete",
      entries_sha256: "1".repeat(64),
      file_count: 1,
      inventory_policy_sha256: "2".repeat(64),
      skipped_count: 0,
      source_kind: "filesystem",
      source_state_sha256: SHA.source,
    }, 1));
    view = reducePersistedEvent(view, event("repository.index.selected", {
      build_mode: "cold",
      cache_manifest_sha256: "3".repeat(64),
      counts: { failed: 0, indexed: 1, references: 0, symbols: 1, units: 1, unsupported: 0 },
      coverage: "complete",
      engine_id: "typescript-language-service",
      engine_identity_sha256: SHA.engine,
      generation_sha256: SHA.generation,
      rule_manifest_sha256: SHA.rules,
      source_state_sha256: SHA.source,
    }, 2));
    expect(repositoryStatusProjectionSchema.parse(view.repository)).toEqual(view.repository);
    expect(view.repository).toMatchObject({ generationSha256: SHA.generation, indexState: "ready" });
    const lines = new BornAgentViewComponent(view, createInitialTuiEphemeralState()).render(200);
    expect(lines).toContain("REPO | engine=typescript-language-service | gen=bbbbbbbb | coverage=complete | index=ready");

    view = reducePersistedEvent(view, event("repository.index.invalidated", {
      changed_path_count: 1,
      current_source_state_sha256: "e".repeat(64),
      old_generation_sha256: SHA.generation,
      reason: "source_changed",
    }, 3));
    expect(view.repository).toMatchObject({ indexState: "dirty", reason: "source_changed" });
  });

  it("does not let watcher/mode-like updates clear a real blocked rule state", () => {
    const initial = createInitialTuiViewState().repository;
    const blocked = applyRepositoryJobState(initial, { code: "repository_rules_changed", kind: "blocked" });
    const invalidated = invalidateRepositoryStatus(blocked, { kind: "source", relativePath: "src/a.ts" });
    const degraded = applyRepositoryJobState(invalidated, { code: "repository_watch_unavailable", kind: "degraded" });
    expect(degraded).toEqual(blocked);
  });

  it("shows a real build phase without inventing wall-clock progress", () => {
    const building = applyRepositoryJobState(createInitialTuiViewState().repository, {
      jobId: "job-one",
      kind: "building",
      phase: "verify",
    });
    const view = { ...createInitialTuiViewState(), repository: building };
    const line = new BornAgentViewComponent(view, createInitialTuiEphemeralState()).render(200)[1];
    expect(line).toBe("REPO | engine=none | gen=none | coverage=none | index=building:verify");
    expect(line).not.toContain("%");
  });
});
