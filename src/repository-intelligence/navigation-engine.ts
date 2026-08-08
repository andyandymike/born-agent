export type RepositoryEvidenceLevel = "semantic" | "syntactic" | "textual_fallback";
export type RepositoryCoverage = "complete" | "partial" | "unsupported";

export interface RepositorySourceRange {
  readonly endByte: number;
  readonly endColumnUtf16: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly startColumnUtf16: number;
  readonly startLine: number;
}

export interface RepositoryNavigationCandidate {
  readonly kind: "definition" | "file" | "reference" | "symbol";
  readonly name: string | null;
  readonly path: string;
  readonly range: RepositorySourceRange | null;
}

export interface RepositoryNavigationResult {
  readonly candidates: readonly RepositoryNavigationCandidate[];
  readonly confirmedAbsent: boolean;
  readonly coverage: RepositoryCoverage;
  readonly evidenceLevel: RepositoryEvidenceLevel;
  readonly sourceStateSha256: string;
}

export interface RepositoryNavigationEngine {
  readonly identity: Readonly<Record<string, unknown>>;
  query(
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<RepositoryNavigationResult>;
}
