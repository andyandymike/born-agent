import { randomUUID } from "node:crypto";

import type { CurrentGeneration, RepositoryNavigationService } from "./navigation-service.js";
import type { RepositoryInvalidation } from "./repository-invalidation-watcher.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { RepositoryJobState } from "./repository-job-state.js";

export interface RepositoryRefreshCoordinatorOptions {
  readonly createJobId?: () => string;
  readonly onState?: (state: RepositoryJobState) => void;
}

function invalidationReason(value: RepositoryInvalidation): string {
  return value.relativePath === null
    ? `${value.kind}_changed`
    : `${value.kind}_changed:${value.relativePath}`;
}

function boundedReasons(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort().slice(0, 32));
}

export class RepositoryRefreshCoordinator {
  private active: Promise<CurrentGeneration> | null = null;
  private activeController: AbortController | null = null;
  private cacheValidationEpoch = 0;
  private dirtyReasons = new Set<string>();
  private stopped = false;
  private currentState: RepositoryJobState = Object.freeze({ kind: "idle" });

  constructor(
    private readonly service: RepositoryNavigationService,
    private readonly options: RepositoryRefreshCoordinatorOptions = {},
  ) {}

  get state(): RepositoryJobState {
    return this.currentState;
  }

  invalidate(invalidation: RepositoryInvalidation): void {
    if (this.stopped) return;
    const reason = invalidationReason(invalidation);
    const validationEpoch = ++this.cacheValidationEpoch;
    if (
      invalidation.kind === "cache" &&
      this.active === null &&
      this.currentState.kind === "ready"
    ) {
      // A current.json atomic rename can be emitted after the foreground job's
      // Promise has settled. Re-read authority before turning that self-write
      // into dirty state; external deletion/tamper still becomes dirty.
      void this.revalidateReadyCache(
        this.currentState.generationSha256,
        reason,
        validationEpoch,
      );
      return;
    }
    this.dirtyReasons.add(reason);
    // PHASE17: invalidation stores only bounded dirty facts. It never queues a
    // model/user query and never starts a hidden refresh job.
    if (this.active === null) {
      this.transition({ kind: "dirty", reasons: boundedReasons(this.dirtyReasons) });
    }
  }

  markWatchUnavailable(): void {
    if (this.stopped || this.active !== null || this.currentState.kind === "dirty") return;
    this.transition({ code: "repository_watch_unavailable", kind: "degraded" });
  }

  refresh(signal: AbortSignal = new AbortController().signal): Promise<CurrentGeneration> {
    if (this.stopped) {
      return Promise.reject(new RepositoryIntelligenceError("repository_navigation_cancelled", "repository refresh coordinator has stopped", 130));
    }
    if (this.active !== null) return this.active;
    this.cacheValidationEpoch += 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    this.activeController = controller;
    const jobId = (this.options.createJobId ?? randomUUID)();
    this.dirtyReasons.clear();
    const job = this.execute(jobId, controller.signal).finally(() => {
      signal.removeEventListener("abort", onAbort);
      if (this.active === job) {
        this.active = null;
        this.activeController = null;
      }
    });
    this.active = job;
    return job;
  }

  cancel(): void {
    this.activeController?.abort(new Error("repository refresh cancelled"));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cacheValidationEpoch += 1;
    this.cancel();
    await this.active?.catch(() => undefined);
    this.active = null;
    this.activeController = null;
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<CurrentGeneration> {
    try {
      this.transition({ jobId, kind: "building", phase: "snapshot" });
      await Promise.resolve();
      if (signal.aborted) throw signal.reason ?? new Error("repository refresh cancelled");
      this.transition({ jobId, kind: "building", phase: "index" });
      const current = await this.service.ensureCurrent({ allowBuild: true, signal });
      this.transition({ jobId, kind: "building", phase: "verify" });
      const status = await this.service.status();
      if (
        status.indexState !== "ready" ||
        status.generationSha256 !== current.stored.generation.generationSha256
      ) {
        this.dirtyReasons.add(status.reason ?? "freshness_changed");
        this.transition({ kind: "dirty", reasons: boundedReasons(this.dirtyReasons) });
        throw new RepositoryIntelligenceError("repository_index_stale", "repository changed during foreground refresh", 8);
      }
      // PHASE17: invalidation received during build is resolved only by this
      // post-build authoritative status check; no stale generation is labelled ready.
      this.dirtyReasons.clear();
      this.transition({
        coverage: current.stored.generation.coverage,
        generationSha256: current.stored.generation.generationSha256,
        kind: "ready",
      });
      return current;
    } catch (error) {
      if (signal.aborted) {
        if (this.dirtyReasons.size === 0) this.dirtyReasons.add("refresh_cancelled");
        this.transition({ kind: "dirty", reasons: boundedReasons(this.dirtyReasons) });
        throw new RepositoryIntelligenceError("repository_navigation_cancelled", "repository refresh was cancelled", 130, { cause: error });
      }
      if (this.currentState.kind !== "dirty") {
        const code = error instanceof RepositoryIntelligenceError ? error.code : "repository_refresh_failed";
        this.transition({ code, kind: "blocked" });
      }
      throw error;
    }
  }

  private async revalidateReadyCache(
    expectedGenerationSha256: string,
    reason: string,
    validationEpoch: number,
  ): Promise<void> {
    let valid = false;
    let dirtyReason: string;
    try {
      const status = await this.service.status();
      valid = status.indexState === "ready" &&
        status.generationSha256 === expectedGenerationSha256;
      dirtyReason = status.reason ?? reason;
    } catch {
      dirtyReason = "cache_status_failed";
    }
    if (
      this.stopped ||
      validationEpoch !== this.cacheValidationEpoch ||
      this.active !== null ||
      this.currentState.kind !== "ready" ||
      this.currentState.generationSha256 !== expectedGenerationSha256
    ) {
      return;
    }
    if (valid) return;
    this.dirtyReasons.add(dirtyReason);
    this.transition({ kind: "dirty", reasons: boundedReasons(this.dirtyReasons) });
  }

  private transition(state: RepositoryJobState): void {
    this.currentState = Object.freeze(state);
    this.options.onState?.(this.currentState);
  }
}
