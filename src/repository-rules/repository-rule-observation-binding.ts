import type { ToolDefinition, ToolRawResult } from "../tools/tool-types.js";
import { toolError } from "../tools/tool-errors.js";
import type { RepositoryRuleScopeResolver } from "./repository-rule-scope.js";

export interface RepositoryRuleObservationBinding {
  readonly ruleManifestSha256: string;
  readonly ruleScopeTruncated: boolean;
  readonly targetScopes: readonly { readonly relativePath: string; readonly scopeSha256: string }[];
}

interface ObservedPaths {
  readonly acceptedScopeHashes: ReadonlySet<string>;
  readonly binding: RepositoryRuleObservationBinding;
}

export class RepositoryRuleObservationTracker {
  readonly #trustedTargets = new Map<string, string>();

  constructor(readonly resolver: RepositoryRuleScopeResolver) {}

  observe(paths: readonly string[]): ObservedPaths {
    const acceptedScopeHashes = new Set<string>();
    const targetScopes: { relativePath: string; scopeSha256: string }[] = [];
    let truncated = false;
    for (const path of paths) {
      let scope;
      try {
        scope = this.resolver.resolve(path);
      } catch {
        truncated = true;
        continue;
      }
      if (!acceptedScopeHashes.has(scope.scopeSha256)) {
        if (acceptedScopeHashes.size >= 16) {
          truncated = true;
          continue;
        }
        acceptedScopeHashes.add(scope.scopeSha256);
        const target = Object.freeze({ relativePath: scope.targetPath, scopeSha256: scope.scopeSha256 });
        targetScopes.push(target);
        this.#trustedTargets.set(scope.scopeSha256, scope.targetPath);
      }
    }
    targetScopes.sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    return Object.freeze({
      acceptedScopeHashes,
      binding: Object.freeze({
        ruleManifestSha256: this.resolver.manifest.manifestSha256,
        ruleScopeTruncated: truncated,
        targetScopes: Object.freeze(targetScopes),
      }),
    });
  }

  trustedTargetPaths(): readonly string[] {
    return Object.freeze([...this.#trustedTargets.values()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  }

  restore(binding: RepositoryRuleObservationBinding): void {
    if (
      binding.ruleManifestSha256 !== this.resolver.manifest.manifestSha256 ||
      binding.targetScopes.length > 16
    ) {
      throw new TypeError("repository rule observation binding uses a stale manifest");
    }
    for (const target of binding.targetScopes) {
      const current = this.resolver.resolve(target.relativePath);
      if (current.scopeSha256 !== target.scopeSha256) {
        throw new TypeError("repository rule observation binding scope hash mismatch");
      }
      this.#trustedTargets.set(current.scopeSha256, current.targetPath);
    }
  }
}

export interface RepositoryRuleReadRuntime {
  readonly assertFresh: () => Promise<void>;
  readonly tracker: RepositoryRuleObservationTracker;
}

function resultPaths(name: string, input: unknown, result: ToolRawResult): readonly string[] {
  if (!result.ok) return [];
  if (name === "read_file") {
    return typeof input === "object" && input !== null && "path" in input && typeof (input as { path?: unknown }).path === "string"
      ? [(input as { path: string }).path]
      : [];
  }
  if (name === "list_files") {
    return Array.isArray(result.value.files)
      ? result.value.files.filter((path): path is string => typeof path === "string")
      : [];
  }
  if (name === "search" && Array.isArray(result.value.matches)) {
    return result.value.matches.flatMap((entry) =>
      typeof entry === "object" && entry !== null && "path" in entry && typeof (entry as { path?: unknown }).path === "string"
        ? [(entry as { path: string }).path]
        : [],
    );
  }
  if (["repository_outline", "find_symbol", "find_references"].includes(name) && Array.isArray(result.value.result)) {
    return result.value.result.flatMap((entry) =>
      typeof entry === "object" && entry !== null && "relativePath" in entry && typeof (entry as { relativePath?: unknown }).relativePath === "string"
        ? [(entry as { relativePath: string }).relativePath]
        : [],
    );
  }
  return [];
}

function filterToScopes(
  name: string,
  result: Extract<ToolRawResult, { readonly ok: true }>,
  tracker: RepositoryRuleObservationTracker,
  acceptedScopeHashes: ReadonlySet<string>,
): Extract<ToolRawResult, { readonly ok: true }> {
  const accepted = (path: string): boolean => {
    try {
      return acceptedScopeHashes.has(tracker.resolver.resolve(path).scopeSha256);
    } catch {
      return false;
    }
  };
  if (name === "list_files" && Array.isArray(result.value.files)) {
    return {
      ...result,
      truncated: true,
      value: {
        ...result.value,
        files: result.value.files.filter((path) => typeof path === "string" && accepted(path)),
        rule_scope_truncated: true,
        truncated: true,
      },
    };
  }
  if (name === "search" && Array.isArray(result.value.matches)) {
    return {
      ...result,
      truncated: true,
      value: {
        ...result.value,
        matches: result.value.matches.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "path" in entry &&
            typeof (entry as { path?: unknown }).path === "string" &&
            accepted((entry as { path: string }).path),
        ),
        rule_scope_truncated: true,
        truncated: true,
      },
    };
  }
  if (["repository_outline", "find_symbol", "find_references"].includes(name) && Array.isArray(result.value.result)) {
    return {
      ...result,
      truncated: true,
      value: {
        ...result.value,
        result: result.value.result.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "relativePath" in entry &&
            typeof (entry as { relativePath?: unknown }).relativePath === "string" &&
            accepted((entry as { relativePath: string }).relativePath),
        ),
        rule_scope_truncated: true,
        truncated: true,
      },
    };
  }
  return result;
}

export function bindRepositoryRuleObservations<TInput>(
  definition: ToolDefinition<TInput>,
  runtime: RepositoryRuleReadRuntime,
): ToolDefinition<TInput> {
  if (!["list_files", "read_file", "search", "repository_outline", "find_symbol", "find_references"].includes(definition.name)) return definition;
  return {
    ...definition,
    execute: async (input, context) => {
      const result = await definition.execute(input, context);
      try {
        // Source observations are withheld if the run-frozen ancestor rules changed during read.
        await runtime.assertFresh();
      } catch {
        return {
          error: toolError(
            "permission",
            "repository_rules_stale",
            "repository rules changed after this run was frozen; start a new run",
            true,
          ),
          ok: false,
        };
      }
      if (!result.ok) return result;
      const observed = runtime.tracker.observe(resultPaths(definition.name, input, result));
      const bounded = observed.binding.ruleScopeTruncated
        ? filterToScopes(definition.name, result, runtime.tracker, observed.acceptedScopeHashes)
        : result;
      // PHASE17: the source observation remains the model-visible output; this separate binding
      // only tells the next context projection which frozen untrusted rule chains apply.
      return { ...bounded, repositoryRuleBinding: observed.binding };
    },
  };
}
