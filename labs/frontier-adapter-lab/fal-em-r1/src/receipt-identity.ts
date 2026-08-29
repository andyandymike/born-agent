import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

function mutableObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EM-R1 receipt ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function emR1LogicalReceiptIdentity(
  receiptContent: Readonly<Record<string, unknown>>,
): string {
  const normalized = structuredClone(receiptContent) as Record<string, unknown>;
  normalized.actualElapsedMinutes = 0;
  const cost = mutableObject(normalized.cost, "cost");
  for (const field of [
    "calibrationProjectionBuildMs",
    "calibrationRecordEmbeddingMs",
    "calibrationQueryPreparationMs",
    "coldLoadMs",
    "warmQueryEmbeddingP95Ms",
    "vectorScan10000P95Ms",
    "hybridSearchP95Ms",
  ]) cost[field] = null;
  const calibration = mutableObject(normalized.calibration, "calibration");
  if (!Array.isArray(calibration.diagnosticCases)) {
    throw new Error("EM-R1 receipt diagnosticCases is not an array");
  }
  calibration.diagnosticCases = calibration.diagnosticCases.map((entry) => {
    const observation = mutableObject(entry, "diagnostic case");
    const result = mutableObject(observation.result, "diagnostic result");
    return { ...observation, result: { ...result, queryEmbeddingDurationMs: null } };
  });
  return sha256Canonical(normalized);
}
