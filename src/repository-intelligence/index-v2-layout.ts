import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { BuiltIndexGeneration } from "./index-generation.js";
import {
  createRepositoryFactReceiptV1,
  createRepositoryStorageRootV2,
  parseRepositoryCacheObjectV2,
  repositoryCacheObjectSha256,
  repositoryFactSchemaIdentitySha256,
  type RepositoryCacheObjectV2,
  type RepositoryFactReceiptV1,
  type RepositoryObjectRefV2,
  type RepositoryStorageRootV2,
} from "./index-v2-schema.js";
import type { IndexedImport, IndexedReference, IndexedSourceUnit, IndexedSymbol } from "./navigation-types.js";
import {
  repositoryCacheStoragePolicySha256,
  repositoryCacheStoragePolicyV1,
  type RepositoryCacheObjectKindV2,
} from "./repository-cache-storage-policy.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

export interface EncodedRepositoryCacheObjectV2 {
  readonly bytes: Buffer;
  readonly ref: RepositoryObjectRefV2;
  readonly value: RepositoryCacheObjectV2;
}

export interface BuiltRepositoryStorageLayoutV2 {
  readonly objects: readonly EncodedRepositoryCacheObjectV2[];
  readonly root: RepositoryStorageRootV2;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unitPartitionKey(path: string): string {
  return `unit/${sha256Canonical({ path, schemaVersion: 1 })}`;
}

function encodeObject(
  kind: RepositoryCacheObjectKindV2,
  logicalPartitionKey: string,
  input: Omit<RepositoryCacheObjectV2, "kind" | "logicalPartitionKey" | "schemaVersion">,
): EncodedRepositoryCacheObjectV2 {
  const value = parseRepositoryCacheObjectV2(kind, {
    ...input,
    kind,
    logicalPartitionKey,
    schemaVersion: 1,
  });
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const bound = repositoryCacheStoragePolicyV1.objectKindBounds.find((entry) => entry.kind === kind)!;
  if (bytes.byteLength <= 0 || bytes.byteLength > bound.maxEncodedBytes) {
    throw new RepositoryIntelligenceError(
      "repository_index_budget_exceeded",
      `repository cache ${kind} object exceeds its encoded byte bound`,
      7,
    );
  }
  const unsigned = {
    bytes: bytes.byteLength,
    encoding: "canonical-json-v1" as const,
    kind,
    logicalPartitionKey,
    objectSchemaVersion: 1 as const,
  };
  return Object.freeze({
    bytes,
    ref: Object.freeze({ ...unsigned, sha256: repositoryCacheObjectSha256(unsigned, bytes) }),
    value,
  });
}

function partition<T>(input: {
  readonly entries: readonly T[];
  readonly keyPrefix: string;
  readonly kind: RepositoryCacheObjectKindV2;
  readonly targetBytes?: number;
  readonly value: (entries: readonly T[]) => Omit<RepositoryCacheObjectV2, "kind" | "logicalPartitionKey" | "schemaVersion">;
}): readonly EncodedRepositoryCacheObjectV2[] {
  if (input.entries.length === 0) return Object.freeze([]);
  const result: EncodedRepositoryCacheObjectV2[] = [];
  let chunk: T[] = [];
  let estimatedBytes = 0;
  const targetBytes = input.targetBytes ?? repositoryCacheStoragePolicyV1.targetEncodedObjectBytes;
  const installChunk = (entries: readonly T[]): void => {
    if (entries.length === 0) return;
    const key = `${input.keyPrefix}/${String(result.length).padStart(6, "0")}`;
    const encoded = encodeObject(input.kind, key, input.value(Object.freeze([...entries])));
    if (encoded.bytes.byteLength <= targetBytes || entries.length === 1) {
      result.push(encoded);
      return;
    }
    // The estimate is deliberately conservative but transformations can add
    // bytes. Split an oversized chunk deterministically instead of repeatedly
    // re-encoding every growing prefix (the old O(n^2) path).
    const middle = Math.max(1, Math.floor(entries.length / 2));
    installChunk(entries.slice(0, middle));
    installChunk(entries.slice(middle));
  };
  const flush = () => {
    installChunk(chunk);
    chunk = [];
    estimatedBytes = 0;
  };
  for (const entry of input.entries) {
    const entryBytes = Buffer.byteLength(canonicalJson(entry), "utf8") + 1;
    if (chunk.length > 0 && estimatedBytes + entryBytes > Math.floor(targetBytes * 0.75)) {
      flush();
    }
    chunk.push(entry);
    estimatedBytes += entryBytes;
  }
  flush();
  return Object.freeze(result);
}

function refs(objects: readonly EncodedRepositoryCacheObjectV2[]): readonly RepositoryObjectRefV2[] {
  return Object.freeze(objects.map((entry) => entry.ref).sort((left, right) =>
    ordinal(`${left.kind}\0${left.logicalPartitionKey}\0${left.sha256}`, `${right.kind}\0${right.logicalPartitionKey}\0${right.sha256}`)
  ));
}

function byUnit<T>(
  values: readonly T[],
  path: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = path(value);
    const bucket = result.get(key) ?? [];
    bucket.push(value);
    result.set(key, bucket);
  }
  return new Map([...result].map(([key, entries]) => [key, Object.freeze(entries)]));
}

function buildFactReceipts(input: {
  readonly built: BuiltIndexGeneration;
  readonly dependencyByUnit: ReadonlyMap<string, EncodedRepositoryCacheObjectV2>;
  readonly payloadByUnit: ReadonlyMap<string, EncodedRepositoryCacheObjectV2>;
  readonly queryObjects: readonly EncodedRepositoryCacheObjectV2[];
}): readonly RepositoryFactReceiptV1[] {
  const importsByUnit = byUnit(input.built.records.imports, (entry) => entry.sourcePath);
  const referencesByUnit = byUnit(input.built.records.references, (entry) => entry.sourcePath);
  const symbolsByUnit = byUnit(input.built.records.symbols, (entry) => entry.relativePath);
  const sourceReceipts = new Map<string, RepositoryFactReceiptV1>();
  const syntaxReceipts = new Map<string, RepositoryFactReceiptV1>();
  const surfaceReceipts = new Map<string, RepositoryFactReceiptV1>();
  const dependencyReceipts = new Map<string, RepositoryFactReceiptV1>();
  const semanticReceipts = new Map<string, RepositoryFactReceiptV1>();
  const all: RepositoryFactReceiptV1[] = [];

  const create = (
    factKind: RepositoryFactReceiptV1["factKind"],
    unit: IndexedSourceUnit,
    dependencies: readonly string[],
    authority: unknown,
    outputObjectSha256: string,
  ): RepositoryFactReceiptV1 => createRepositoryFactReceiptV1({
    authorityProjectionSha256: sha256Canonical(authority),
    dependencyFactSha256s: Object.freeze([...new Set(dependencies)].sort(ordinal)),
    engineIdentitySha256: input.built.generation.engineIdentitySha256,
    factKind,
    factSchemaSha256: repositoryFactSchemaIdentitySha256(factKind),
    logicalName: `${unitPartitionKey(unit.relativePath)}/${factKind.replaceAll("_", "-")}`,
    outputObjectSha256,
    schemaVersion: 1,
  });

  for (const unit of input.built.records.units) {
    const output = input.payloadByUnit.get(unit.relativePath);
    if (output === undefined) throw new Error("repository v2 layout has no unit payload object");
    const receipt = create("source_unit", unit, [], {
      path: unit.relativePath,
      sourceSha256: unit.sourceSha256,
    }, output.ref.sha256);
    sourceReceipts.set(unit.relativePath, receipt);
    all.push(receipt);
  }
  for (const unit of input.built.records.units) {
    const source = sourceReceipts.get(unit.relativePath)!;
    const output = input.payloadByUnit.get(unit.relativePath)!;
    const receipt = create("syntax_facts", unit, [source.receiptSha256], {
      sourceSha256: unit.sourceSha256,
      symbols: symbolsByUnit.get(unit.relativePath) ?? [],
    }, output.ref.sha256);
    syntaxReceipts.set(unit.relativePath, receipt);
    all.push(receipt);
  }
  for (const unit of input.built.records.units) {
    const syntax = syntaxReceipts.get(unit.relativePath)!;
    const output = input.payloadByUnit.get(unit.relativePath)!;
    const exported = (symbolsByUnit.get(unit.relativePath) ?? []).filter((entry) => entry.exported);
    const receipt = create("module_surface", unit, [syntax.receiptSha256], { exported }, output.ref.sha256);
    surfaceReceipts.set(unit.relativePath, receipt);
    all.push(receipt);
  }
  for (const unit of input.built.records.units) {
    const imports = importsByUnit.get(unit.relativePath) ?? [];
    const dependencies = [syntaxReceipts.get(unit.relativePath)!.receiptSha256];
    for (const record of imports) {
      if (record.resolvedPath !== null) {
        const surface = surfaceReceipts.get(record.resolvedPath);
        if (surface !== undefined) dependencies.push(surface.receiptSha256);
      }
    }
    const output = input.dependencyByUnit.get(unit.relativePath) ?? input.payloadByUnit.get(unit.relativePath)!;
    const receipt = create("dependency_resolution", unit, dependencies, { imports }, output.ref.sha256);
    dependencyReceipts.set(unit.relativePath, receipt);
    all.push(receipt);
  }
  for (const unit of input.built.records.units) {
    const output = input.payloadByUnit.get(unit.relativePath)!;
    const receipt = create("semantic_unit", unit, [
      dependencyReceipts.get(unit.relativePath)!.receiptSha256,
      surfaceReceipts.get(unit.relativePath)!.receiptSha256,
    ], {
      imports: importsByUnit.get(unit.relativePath) ?? [],
      references: referencesByUnit.get(unit.relativePath) ?? [],
      symbols: symbolsByUnit.get(unit.relativePath) ?? [],
    }, output.ref.sha256);
    semanticReceipts.set(unit.relativePath, receipt);
    all.push(receipt);
  }

  const semanticDependencies = Object.freeze([...semanticReceipts.values()].map((entry) => entry.receiptSha256).sort(ordinal));
  const representative = input.built.records.units[0];
  if (representative !== undefined) {
    for (const object of input.queryObjects) {
      const logicalName = `query/${object.ref.kind.replaceAll("_", "-")}/${object.ref.sha256}`;
      const unsigned = {
        authorityProjectionSha256: sha256Canonical({
          generationSha256: input.built.generation.generationSha256,
          objectSha256: object.ref.sha256,
        }),
        dependencyFactSha256s: semanticDependencies,
        engineIdentitySha256: input.built.generation.engineIdentitySha256,
        factKind: "query_view" as const,
        factSchemaSha256: repositoryFactSchemaIdentitySha256("query_view"),
        logicalName,
        outputObjectSha256: object.ref.sha256,
        schemaVersion: 1 as const,
      };
      all.push(createRepositoryFactReceiptV1(unsigned));
    }
  }
  return Object.freeze(all.sort((left, right) => ordinal(`${left.logicalName}\0${left.receiptSha256}`, `${right.logicalName}\0${right.receiptSha256}`)));
}

export function buildRepositoryStorageLayoutV2(
  built: BuiltIndexGeneration,
  options: { readonly includeFactReceipts?: boolean } = {},
): BuiltRepositoryStorageLayoutV2 {
  const includeFactReceipts = options.includeFactReceipts ?? true;
  const units = [...built.records.units];
  const symbols = [...built.records.symbols];
  const references = [...built.records.references];
  const imports = [...built.records.imports];
  const symbolsByUnit = byUnit(symbols, (entry) => entry.relativePath);
  const importsByUnit = byUnit(imports, (entry) => entry.sourcePath);

  const unitObjects = partition({
    entries: units,
    keyPrefix: "all",
    kind: "unit_directory",
    value: (partitionEntries) => ({ units: partitionEntries } as never),
  });
  const topLevel = symbols.filter((entry) => !entry.qualifiedName.includes("."));
  const outlineObjects = partition({
    entries: topLevel,
    keyPrefix: "all",
    kind: "outline_view",
    value: (entries) => ({
      symbols: entries.map((entry) => [
        entry.relativePath,
        entry.recordId,
        entry.kind,
        entry.name,
        entry.range.startLine,
      ]),
    } as never),
  });

  const payloadObjects = partition({
    entries: units.map((unit) => [
      unit.relativePath,
      importsByUnit.get(unit.relativePath) ?? [],
      symbolsByUnit.get(unit.relativePath) ?? [],
    ] as const),
    keyPrefix: "units",
    kind: "symbol_payload",
    targetBytes: 65_536,
    value: (entries) => ({ units: entries } as never),
  });
  const payloadByUnit = new Map(payloadObjects.flatMap((entry) =>
    entry.value.kind === "symbol_payload"
      ? entry.value.units.map((unit) => [unit[0], entry] as const)
      : []));

  const searchObjects = partition({
    entries: symbols,
    keyPrefix: "all",
    kind: "symbol_search_directory",
    value: (entries) => ({
      entries: entries.map((entry) => [
        entry.name,
        entry.qualifiedName,
        entry.relativePath,
        entry.kind,
        entry.recordId,
        payloadByUnit.get(entry.relativePath)!.ref.logicalPartitionKey,
      ]),
    } as never),
  });

  const dependencyObjects = includeFactReceipts
    ? units.map((unit) => encodeObject("dependency_view", unitPartitionKey(unit.relativePath), {
      imports: importsByUnit.get(unit.relativePath) ?? [],
      unitPath: unit.relativePath,
    } as never))
    : [];
  const dependencyByUnit = new Map(dependencyObjects.map((entry) => [(entry.value as { readonly unitPath: string }).unitPath, entry]));

  const postingGroups = new Map<string, IndexedReference[]>();
  for (const reference of references) {
    const partitionKey = reference.targetSymbolRecordId === null
      ? `unresolved/${reference.sourceSha256.slice(0, 1)}`
      : `bucket/${reference.targetSymbolRecordId.slice(0, 1)}`;
    const group = postingGroups.get(partitionKey) ?? [];
    group.push(reference);
    postingGroups.set(partitionKey, group);
  }
  const postingObjects = [...postingGroups.entries()].sort(([left], [right]) => ordinal(left, right)).flatMap(([partitionKey, entries]) => partition({
    entries,
    keyPrefix: partitionKey,
    kind: "reference_posting",
    value: (partitionEntries) => ({ references: partitionEntries } as never),
  }));

  const queryObjects = Object.freeze([...outlineObjects, ...searchObjects, ...postingObjects]);
  const receipts = includeFactReceipts
    ? buildFactReceipts({ built, dependencyByUnit, payloadByUnit, queryObjects })
    : [];
  const receiptObjects = partition({
    entries: receipts,
    keyPrefix: "all",
    kind: "fact_receipt",
    value: (entries) => ({ receipts: entries } as never),
  });

  const objects = Object.freeze([
    ...dependencyObjects,
    ...receiptObjects,
    ...outlineObjects,
    ...postingObjects,
    ...payloadObjects,
    ...searchObjects,
    ...unitObjects,
  ].sort((left, right) => ordinal(
    `${left.ref.kind}\0${left.ref.logicalPartitionKey}\0${left.ref.sha256}`,
    `${right.ref.kind}\0${right.ref.logicalPartitionKey}\0${right.ref.sha256}`,
  )));
  const root = createRepositoryStorageRootV2({
    dependencyObjects: refs(dependencyObjects),
    factReceiptObjects: refs(receiptObjects),
    generation: built.generation,
    outlineViewObjects: refs(outlineObjects),
    referencePostingObjects: refs(postingObjects),
    schemaVersion: 2,
    storagePolicySha256: repositoryCacheStoragePolicySha256,
    symbolPayloadObjects: refs(payloadObjects),
    symbolSearchDirectoryObjects: refs(searchObjects),
    unitDirectoryObjects: refs(unitObjects),
  });
  return Object.freeze({ objects, root });
}

export function repositoryUnitPartitionKeyV2(path: string): string {
  return unitPartitionKey(path);
}

export type RepositoryV2LayoutImport = IndexedImport;
export type RepositoryV2LayoutReference = IndexedReference;
export type RepositoryV2LayoutSymbol = IndexedSymbol;
