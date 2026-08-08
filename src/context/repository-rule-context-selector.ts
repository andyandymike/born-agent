import type { ContextItemInput } from "./context-item.js";
import type { NestedRepositoryRuleSet } from "../repository-rules/repository-rule-manifest.js";
import type { RepositoryRuleScope, RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";

export interface SelectedRepositoryRuleContext {
  readonly bindings: readonly { readonly relativePath: string; readonly scopeSha256: string }[];
  readonly items: readonly ContextItemInput[];
}

export function selectRepositoryRuleContext(
  rules: NestedRepositoryRuleSet,
  resolver: RepositoryRuleScopeResolver,
  input: {
    readonly eventId: string;
    readonly recency: number;
    readonly rootEventId?: string;
    readonly trustedTargetPaths: readonly string[];
  },
): SelectedRepositoryRuleContext {
  const scopes: RepositoryRuleScope[] = input.trustedTargetPaths.map((path) => resolver.resolve(path));
  const entries = new Map(
    scopes.flatMap((scope) => scope.applicableEntries.map((entry) => [entry.relativePath, entry] as const)),
  );
  const root = rules.manifest.entries.find((entry) => entry.relativePath === "AGENTS.md");
  if (root !== undefined) entries.set(root.relativePath, root);
  const ordered = [...entries.values()].sort(
    (left, right) => left.depth - right.depth || (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
  );
  const items = ordered.map(
    (entry): ContextItemInput => ({
      artifactRefs: [
        {
          artifactId: entry.artifact.artifactId,
          bytes: entry.artifact.bytes,
          mediaType: "text/markdown; charset=utf-8",
          relativeRef: entry.artifact.relativeRef,
          sha256: entry.artifact.sha256,
        },
      ],
      authority: "untrusted_content",
      content: rules.content(entry),
      kind: "repository_rules",
      metadata: {
        authority_scope: "repository_rules_only",
        content_sha256: entry.contentSha256,
        depth: entry.depth,
        relative_path: entry.relativePath,
        scope_prefix: entry.scopePrefix,
      },
      priority: "critical",
      protectedCategory: "repository_rules",
      recency: input.recency,
      role: "system",
      sourceEventIds:
        entry.relativePath === "AGENTS.md" && input.rootEventId !== undefined
          ? [input.eventId, input.rootEventId]
          : [input.eventId],
      visibility: "provider_context",
    }),
  );
  return Object.freeze({
    bindings: Object.freeze(scopes.map((scope) => Object.freeze({ relativePath: scope.targetPath, scopeSha256: scope.scopeSha256 }))),
    items: Object.freeze(items),
  });
}
