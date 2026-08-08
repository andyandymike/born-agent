import { sha256Canonical } from "../completion/canonical-json.js";
import { createIndexGeneration, type IndexGenerationV1 } from "./index-generation-schema.js";
import {
  indexedImportSchema,
  indexedReferenceSchema,
  indexedSourceUnitSchema,
  indexedSymbolSchema,
  type RepositoryIndexRecords,
} from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeIndexRecords(records: RepositoryIndexRecords): RepositoryIndexRecords {
  try {
    const units = records.units.map((entry) => indexedSourceUnitSchema.parse(entry)).sort((left, right) => ordinal(left.relativePath, right.relativePath));
    const symbols = records.symbols.map((entry) => indexedSymbolSchema.parse(entry)).sort((left, right) =>
      ordinal(`${left.relativePath}:${String(left.range.startByte).padStart(16, "0")}:${left.recordId}`, `${right.relativePath}:${String(right.range.startByte).padStart(16, "0")}:${right.recordId}`),
    );
    const references = records.references.map((entry) => indexedReferenceSchema.parse(entry)).sort((left, right) =>
      ordinal(`${left.sourcePath}:${String(left.range.startByte).padStart(16, "0")}:${left.relation}`, `${right.sourcePath}:${String(right.range.startByte).padStart(16, "0")}:${right.relation}`),
    );
    const imports = records.imports.map((entry) => indexedImportSchema.parse(entry)).sort((left, right) =>
      ordinal(`${left.sourcePath}:${String(left.range.startByte).padStart(16, "0")}:${left.specifier}`, `${right.sourcePath}:${String(right.range.startByte).padStart(16, "0")}:${right.specifier}`),
    );
    if (new Set(units.map((entry) => entry.relativePath)).size !== units.length) throw new Error("duplicate index source unit");
    if (new Set(symbols.map((entry) => entry.recordId)).size !== symbols.length) throw new Error("duplicate index symbol record");
    const symbolIds = new Set(symbols.map((entry) => entry.recordId));
    const unitByPath = new Map(units.map((entry) => [entry.relativePath, entry]));
    for (const symbol of symbols) {
      const unit = unitByPath.get(symbol.relativePath);
      if (unit === undefined || unit.sourceSha256 !== symbol.sourceSha256 || symbol.range.endByte > unit.bytes) {
        throw new Error("symbol is not bound to an exact indexed source unit");
      }
    }
    for (const reference of references) {
      const unit = unitByPath.get(reference.sourcePath);
      if (unit === undefined || unit.sourceSha256 !== reference.sourceSha256 || reference.range.endByte > unit.bytes) {
        throw new Error("reference is not bound to an exact indexed source unit");
      }
      if (reference.targetSymbolRecordId !== null && !symbolIds.has(reference.targetSymbolRecordId)) {
        throw new Error("reference target is absent from the same generation");
      }
      // PHASE17: an unresolved syntactic/textual name is never rebound to an arbitrary same-name
      // symbol. Only the semantic engine may provide a concrete same-generation record ID.
    }
    return Object.freeze({ imports: Object.freeze(imports), references: Object.freeze(references), symbols: Object.freeze(symbols), units: Object.freeze(units) });
  } catch (error) {
    throw new RepositoryIntelligenceError("repository_index_build_failed", "repository index records failed canonical validation", 1, { cause: error });
  }
}

export interface BuiltIndexGeneration {
  readonly generation: IndexGenerationV1;
  readonly records: RepositoryIndexRecords;
}

export function buildIndexGeneration(
  input: {
    readonly engineIdentitySha256: string;
    readonly records: RepositoryIndexRecords;
    readonly ruleManifestSha256: string;
    readonly sourceCoverage: "complete" | "partial";
    readonly sourceStateSha256: string;
  },
): BuiltIndexGeneration {
  const records = canonicalizeIndexRecords(input.records);
  const counts = Object.freeze({
    failed: records.units.filter((unit) => unit.parseStatus === "failed").length,
    indexed: records.units.filter((unit) => unit.parseStatus === "indexed").length,
    references: records.references.length,
    symbols: records.symbols.length,
    units: records.units.length,
    unsupported: records.units.filter((unit) => unit.parseStatus === "unsupported").length,
  });
  const coverage = input.sourceCoverage === "complete" && counts.failed === 0 && counts.unsupported === 0
    ? "complete" as const
    : "partial" as const;
  const generation = createIndexGeneration({
    counts,
    coverage,
    engineIdentitySha256: input.engineIdentitySha256,
    referencesSha256: sha256Canonical({ imports: records.imports, references: records.references }),
    ruleManifestSha256: input.ruleManifestSha256,
    sourceStateSha256: input.sourceStateSha256,
    symbolsSha256: sha256Canonical(records.symbols),
    unitsSha256: sha256Canonical(records.units),
  });
  // PHASE17: IDs and cursors later bind this immutable generation hash. Reinterpreting old
  // records under a new engine/config/source envelope is mechanically impossible.
  return Object.freeze({ generation, records });
}
