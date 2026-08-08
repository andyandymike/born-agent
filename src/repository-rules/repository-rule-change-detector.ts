import type { NestedAgentsLoader } from "./nested-agents-loader.js";
import type { NestedRepositoryRuleSet } from "./repository-rule-manifest.js";

export type RepositoryRuleManifestChange =
  | { readonly changed: false; readonly reason: "unchanged" }
  | {
      readonly changed: true;
      readonly currentIdentity: readonly { relativePath: string; contentBytes: number; contentSha256: string }[] | null;
      readonly reason: "content_changed" | "created" | "invalid" | "removed";
    };

export class RepositoryRulesStaleError extends Error {
  constructor(
    readonly code: "repository_rule_scope_stale" = "repository_rule_scope_stale",
    message = "repository rules changed after this run was frozen; start a new run",
  ) {
    super(message);
    this.name = "RepositoryRulesStaleError";
  }
}

export class RepositoryRuleChangeDetector {
  constructor(
    private readonly loader: NestedAgentsLoader,
    private readonly frozen: NestedRepositoryRuleSet,
  ) {}

  async detect(): Promise<RepositoryRuleManifestChange> {
    let current;
    try {
      current = await this.loader.inspectCurrentIdentity();
    } catch {
      return Object.freeze({ changed: true, currentIdentity: null, reason: "invalid" as const });
    }
    const frozen = this.frozen.manifest.entries.map((entry) => ({
      contentBytes: entry.contentBytes,
      contentSha256: entry.contentSha256,
      relativePath: entry.relativePath,
    }));
    const frozenByPath = new Map(frozen.map((entry) => [entry.relativePath, entry]));
    const currentByPath = new Map(current.map((entry) => [entry.relativePath, entry]));
    const created = current.find((entry) => !frozenByPath.has(entry.relativePath));
    if (created !== undefined) return Object.freeze({ changed: true, currentIdentity: current, reason: "created" as const });
    const removed = frozen.find((entry) => !currentByPath.has(entry.relativePath));
    if (removed !== undefined) return Object.freeze({ changed: true, currentIdentity: current, reason: "removed" as const });
    const modified = current.find((entry) => {
      const prior = frozenByPath.get(entry.relativePath);
      return prior?.contentBytes !== entry.contentBytes || prior.contentSha256 !== entry.contentSha256;
    });
    return modified === undefined
      ? Object.freeze({ changed: false, reason: "unchanged" as const })
      : Object.freeze({ changed: true, currentIdentity: current, reason: "content_changed" as const });
  }

  async assertFresh(): Promise<void> {
    if ((await this.detect()).changed) throw new RepositoryRulesStaleError();
  }
}
