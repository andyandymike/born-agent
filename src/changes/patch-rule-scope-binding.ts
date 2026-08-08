import { sha256Canonical } from "../completion/canonical-json.js";
import { RepositoryRulesStaleError } from "../repository-rules/repository-rule-change-detector.js";
import type { RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";

export interface PatchRuleScopeBinding {
  readonly manifestSha256: string;
  readonly ruleScopeSetSha256: string;
  readonly targets: readonly { readonly relativePath: string; readonly scopeSha256: string }[];
}

export function createPatchRuleScopeBinding(
  resolver: RepositoryRuleScopeResolver,
  paths: readonly string[],
): PatchRuleScopeBinding {
  const sorted = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(sorted).size !== sorted.length || sorted.length === 0) {
    throw new TypeError("patch rule scope targets must be non-empty and unique");
  }
  const targets = sorted.map((relativePath) => {
    const scope = resolver.resolve(relativePath);
    return Object.freeze({ relativePath: scope.targetPath, scopeSha256: scope.scopeSha256 });
  });
  const manifestSha256 = resolver.manifest.manifestSha256;
  // PHASE17: this hash only makes an old approval stale. It grants no permission and cannot
  // relax the independent patch preimage, approval, sandbox, or completion boundaries.
  return Object.freeze({
    manifestSha256,
    ruleScopeSetSha256: sha256Canonical({ manifestSha256, targets }),
    targets: Object.freeze(targets),
  });
}

export function assertPatchRuleScopeBinding(
  frozen: PatchRuleScopeBinding,
  currentResolver: RepositoryRuleScopeResolver,
): void {
  const current = createPatchRuleScopeBinding(
    currentResolver,
    frozen.targets.map((target) => target.relativePath),
  );
  if (
    current.manifestSha256 !== frozen.manifestSha256 ||
    current.ruleScopeSetSha256 !== frozen.ruleScopeSetSha256
  ) {
    throw new RepositoryRulesStaleError();
  }
}
