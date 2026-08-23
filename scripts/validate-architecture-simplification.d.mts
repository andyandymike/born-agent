export interface ArchitectureEvidenceManifestV1 {
  readonly cases: readonly Readonly<Record<string, unknown>>[];
  readonly manifestId: string;
  readonly schemaVersion: 1;
}

export interface ArchitectureEvidenceReportDocumentV1 {
  readonly argv: readonly string[];
  readonly path: string;
  readonly source: string;
}

export interface ArchitectureEvidenceReceiptV1 {
  readonly metrics: Readonly<Record<string, number>>;
  readonly [key: string]: unknown;
}

export class ArchitectureEvidenceError extends Error {
  readonly code: string;
}

export function parseArchitectureArguments(argv: readonly string[]): Readonly<{
  readonly help?: true;
  readonly manifest?: string;
  readonly platform?: string;
  readonly profile?: string;
  readonly receiptOut?: string;
  readonly receipts: readonly string[];
  readonly reportArgv: readonly string[];
  readonly reports: readonly string[];
}>;
export function parseEvidenceManifest(source: string): ArchitectureEvidenceManifestV1;
export function parseEvidenceReceipt(source: string): ArchitectureEvidenceReceiptV1;
export function sha256(source: string | Uint8Array): string;
export function evaluateEvidence(input: {
  readonly manifest: ArchitectureEvidenceManifestV1;
  readonly platform: "linux" | "win32";
  readonly profile: "default" | "built_paths" | "pack" | "metric";
  readonly reportDocuments: readonly ArchitectureEvidenceReportDocumentV1[];
  readonly workspaceRoot: string;
}): Readonly<Record<string, unknown>>;
export function createEvidenceReceipt(input: {
  readonly context: {
    readonly arch: string;
    readonly argv: readonly string[];
    readonly commitSha: string;
    readonly dirty: null | Readonly<Record<string, unknown>>;
    readonly metrics?: Readonly<Record<string, number>>;
    readonly nodeVersion: string;
    readonly pnpmVersion: string;
  };
  readonly manifest: ArchitectureEvidenceManifestV1;
  readonly manifestSource: string;
  readonly platform: "linux" | "win32";
  readonly profile: "default" | "built_paths" | "pack" | "metric";
  readonly reportDocuments: readonly ArchitectureEvidenceReportDocumentV1[];
  readonly workspaceRoot: string;
}): ArchitectureEvidenceReceiptV1;
export function verifyEvidenceReceipt(input: {
  readonly expectedContext?: {
    readonly arch: string;
    readonly commitSha: string;
    readonly dirty: null | Readonly<Record<string, unknown>>;
    readonly metrics?: Readonly<Record<string, number>>;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly pnpmVersion: string;
  };
  readonly manifest: ArchitectureEvidenceManifestV1;
  readonly manifestSource: string;
  readonly receipt: ArchitectureEvidenceReceiptV1;
  readonly workspaceRoot: string;
}): Promise<ArchitectureEvidenceReceiptV1>;
