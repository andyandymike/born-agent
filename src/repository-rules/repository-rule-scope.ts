import { sha256Canonical } from "../completion/canonical-json.js";
import type { RepositoryRuleEntryV1, RepositoryRuleManifestV1 } from "./repository-rule-manifest-schema.js";

export const MAX_APPLICABLE_RULE_CHAIN_FILES = 32;
export const MAX_APPLICABLE_RULE_CHAIN_BYTES = 256 * 1024;

export class RepositoryRuleScopeError extends Error {
  constructor(
    readonly code:
      | "repository_rule_chain_too_deep"
      | "repository_rule_chain_too_large"
      | "repository_rule_scope_invalid",
    message: string,
    readonly exitCode: 7 | 8 = 8,
  ) {
    super(message);
    this.name = "RepositoryRuleScopeError";
  }
}

export interface RepositoryRuleScope {
  readonly applicableEntries: readonly RepositoryRuleEntryV1[];
  readonly scopeSha256: string;
  readonly targetPath: string;
}

function canonicalTarget(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RepositoryRuleScopeError("repository_rule_scope_invalid", "target path must be canonical and workspace-relative");
  }
  return normalized;
}

function applies(scopePrefix: string, targetPath: string): boolean {
  // PHASE17: scope matching is segment-aware; `src/app` must never match `src/application`.
  return scopePrefix === "" || targetPath === scopePrefix || targetPath.startsWith(`${scopePrefix}/`);
}

export class RepositoryRuleScopeResolver {
  constructor(readonly manifest: RepositoryRuleManifestV1) {}

  resolve(targetPathInput: string): RepositoryRuleScope {
    const targetPath = canonicalTarget(targetPathInput);
    const applicableEntries = this.manifest.entries.filter((entry) => applies(entry.scopePrefix, targetPath));
    if (applicableEntries.length > MAX_APPLICABLE_RULE_CHAIN_FILES) {
      throw new RepositoryRuleScopeError("repository_rule_chain_too_deep", "applicable repository rule chain exceeds 32 files", 7);
    }
    if (applicableEntries.reduce((total, entry) => total + entry.contentBytes, 0) > MAX_APPLICABLE_RULE_CHAIN_BYTES) {
      throw new RepositoryRuleScopeError("repository_rule_chain_too_large", "applicable repository rule chain exceeds 256 KiB", 7);
    }
    // PHASE17: deeper entries are later/higher only inside the untrusted repository-rule layer;
    // they cannot override the user, Host policy, permissions, approvals, or completion checks.
    return Object.freeze({
      applicableEntries: Object.freeze(applicableEntries),
      scopeSha256: sha256Canonical({
        entries: applicableEntries.map((entry) => ({ contentSha256: entry.contentSha256, relativePath: entry.relativePath })),
        manifestSha256: this.manifest.manifestSha256,
        targetPath,
      }),
      targetPath,
    });
  }
}
