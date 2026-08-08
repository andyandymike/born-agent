export interface SourceEnumeration {
  readonly gitHeadOid: string | null;
  readonly gitIndexSha256: string | null;
  readonly paths: readonly string[];
  readonly skipped: Readonly<Record<string, number>>;
  readonly sourceKind: "filesystem" | "git_worktree";
}

export interface SourceEnumerator {
  enumerate(signal: AbortSignal): Promise<SourceEnumeration | null>;
}

export function canonicalRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}
