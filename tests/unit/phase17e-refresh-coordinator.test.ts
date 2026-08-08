import { describe, expect, it, vi } from "vitest";

import type {
  CurrentGeneration,
  RepositoryNavigationService,
} from "../../src/repository-intelligence/navigation-service.js";
import { RepositoryRefreshCoordinator } from "../../src/repository-intelligence/repository-refresh-coordinator.js";
import { buildRepositoryStatusProjection } from "../../src/repository-intelligence/repository-status-projection.js";

const HASH = {
  engine: "a".repeat(64),
  generation: "b".repeat(64),
  rules: "c".repeat(64),
  source: "d".repeat(64),
};

function current(): CurrentGeneration {
  return {
    buildMode: "cold",
    stored: {
      generation: {
        buildMode: "cold",
        counts: { failed: 0, indexed: 1, references: 0, symbols: 1, units: 1, unsupported: 0 },
        coverage: "complete",
        engineIdentitySha256: HASH.engine,
        generationSha256: HASH.generation,
        ruleManifestSha256: HASH.rules,
        schemaVersion: 1,
        sourceStateSha256: HASH.source,
      },
    },
  } as unknown as CurrentGeneration;
}

function readyStatus() {
  return buildRepositoryStatusProjection({
    buildPhase: null,
    coverage: "complete",
    engineId: "typescript-language-service",
    engineIdentitySha256: HASH.engine,
    generationSha256: HASH.generation,
    indexState: "ready",
    reason: null,
    ruleManifestSha256: HASH.rules,
    schemaVersion: 1,
    sourceStateSha256: HASH.source,
    watchState: "available",
  });
}

function service(input: {
  readonly ensure: (signal: AbortSignal) => Promise<CurrentGeneration>;
  readonly status?: () => Promise<ReturnType<typeof readyStatus>>;
}): RepositoryNavigationService {
  return {
    ensureCurrent: ({ signal }) => input.ensure(signal),
    findReferences: async () => { throw new Error("unused"); },
    findSymbols: async () => { throw new Error("unused"); },
    outline: async () => { throw new Error("unused"); },
    status: input.status ?? (async () => readyStatus()),
  };
}

describe("Phase 17E foreground repository refresh coordinator", () => {
  it("does not start work on invalidation and shares one active foreground job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => { await gate; return current(); });
    const expected = current();
    ensure.mockImplementation(async () => { await gate; return expected; });
    const states: string[] = [];
    const coordinator = new RepositoryRefreshCoordinator(service({ ensure }), {
      createJobId: () => "job-one",
      onState: (state) => states.push(state.kind === "building" ? `${state.kind}:${state.phase}` : state.kind),
    });

    coordinator.invalidate({ kind: "source", relativePath: "src/a.ts" });
    expect(ensure).not.toHaveBeenCalled();
    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe(expected);
    expect(states).toEqual(["dirty", "building:snapshot", "building:index", "building:verify", "ready"]);
  });

  it("revalidates invalidation received during build before publishing ready", async () => {
    const reference: { current?: RepositoryRefreshCoordinator } = {};
    const status = vi.fn(async () => readyStatus());
    const coordinator = new RepositoryRefreshCoordinator(service({
      ensure: async () => {
        reference.current!.invalidate({ kind: "unknown", relativePath: null });
        return current();
      },
      status,
    }));
    reference.current = coordinator;

    await expect(coordinator.refresh()).resolves.toMatchObject({ buildMode: "cold" });
    expect(status).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toMatchObject({ kind: "ready", generationSha256: HASH.generation });
  });

  it("rejects a post-build stale status and retains only dirty facts", async () => {
    const dirty = buildRepositoryStatusProjection({
      buildPhase: null,
      coverage: "complete",
      engineId: "typescript-language-service",
      engineIdentitySha256: HASH.engine,
      generationSha256: HASH.generation,
      indexState: "dirty",
      reason: "source_changed",
      ruleManifestSha256: HASH.rules,
      schemaVersion: 1,
      sourceStateSha256: HASH.source,
      watchState: "available",
    });
    const coordinator = new RepositoryRefreshCoordinator(service({
      ensure: async () => current(),
      status: async () => dirty,
    }));

    await expect(coordinator.refresh()).rejects.toMatchObject({ code: "repository_index_stale" });
    expect(coordinator.state).toEqual({ kind: "dirty", reasons: ["source_changed"] });
  });

  it("propagates cancellation and can stop without leaving an active job", async () => {
    const ensure = vi.fn((signal: AbortSignal) => new Promise<CurrentGeneration>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const coordinator = new RepositoryRefreshCoordinator(service({ ensure }));
    const refresh = coordinator.refresh();
    coordinator.cancel();

    await expect(refresh).rejects.toMatchObject({ code: "repository_navigation_cancelled", exitCode: 130 });
    expect(coordinator.state).toEqual({ kind: "dirty", reasons: ["refresh_cancelled"] });
    await coordinator.stop();
    await coordinator.stop();
    await expect(coordinator.refresh()).rejects.toMatchObject({ code: "repository_navigation_cancelled" });
  });
});
