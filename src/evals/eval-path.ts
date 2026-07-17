import { EvalCoreError } from "./eval-errors.js";

const WINDOWS_DRIVE = /^[A-Za-z]:/u;

export function assertCanonicalEvalRelativePath(path: string, label = "path"): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    WINDOWS_DRIVE.test(path)
  ) {
    throw new EvalCoreError("eval_manifest_invalid", `${label} must be a canonical POSIX relative path`, 1);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new EvalCoreError("eval_manifest_invalid", `${label} contains a non-canonical segment`, 1);
  }
  return path;
}

export function assertCanonicalEvalPrefix(prefix: string, label = "prefix"): string {
  if (!prefix.endsWith("/")) {
    throw new EvalCoreError("eval_manifest_invalid", `${label} must end with '/'`, 1);
  }
  assertCanonicalEvalRelativePath(prefix.slice(0, -1), label);
  return prefix;
}

export function assertWorkspaceCwd(cwd: string): string {
  if (cwd === "/workspace") {
    return cwd;
  }
  if (!cwd.startsWith("/workspace/") || cwd.includes("\\") || cwd.includes("\0")) {
    throw new EvalCoreError("eval_manifest_invalid", "command cwd must be /workspace or a canonical child", 1);
  }
  assertCanonicalEvalRelativePath(cwd.slice("/workspace/".length), "command cwd");
  return cwd;
}

export interface EvalPathRules {
  readonly allowedExact: readonly string[];
  readonly allowedPrefixes: readonly string[];
  readonly forbiddenExact: readonly string[];
  readonly forbiddenPrefixes: readonly string[];
}

function matches(path: string, exact: readonly string[], prefixes: readonly string[]): boolean {
  return exact.includes(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

export type EvalPathDecision = "allowed" | "forbidden" | "outside_allowlist";

export function decideEvalChangedPath(path: string, rules: EvalPathRules): EvalPathDecision {
  assertCanonicalEvalRelativePath(path, "changed path");
  if (matches(path, rules.forbiddenExact, rules.forbiddenPrefixes)) {
    return "forbidden";
  }
  return matches(path, rules.allowedExact, rules.allowedPrefixes) ? "allowed" : "outside_allowlist";
}
