import { createHash } from "node:crypto";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { indexGenerationSchema, type IndexGenerationV1 } from "./index-generation-schema.js";
import {
  indexedImportSchema,
  indexedReferenceSchema,
  indexedSourceUnitSchema,
  indexedSymbolSchema,
  repositoryRelativePathSchema,
  repositorySymbolKindSchema,
  sha256Schema,
  type RepositorySymbolKind,
} from "./navigation-types.js";
import {
  repositoryCacheObjectKindsV2,
  repositoryCacheStoragePolicyV1,
  type RepositoryCacheObjectKindV2,
} from "./repository-cache-storage-policy.js";

export const repositoryCacheLogicalPartitionKeySchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 512, "partition key exceeds its byte bound")
  .refine((value) => (
    /^[a-z0-9][a-z0-9._/-]*$/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  ), "partition key is not package-canonical");

export const repositoryObjectRefV2Schema = z.object({
  bytes: z.number().int().positive().max(repositoryCacheStoragePolicyV1.maxObjectBytes),
  encoding: z.literal("canonical-json-v1"),
  kind: z.enum(repositoryCacheObjectKindsV2),
  logicalPartitionKey: repositoryCacheLogicalPartitionKeySchema,
  objectSchemaVersion: z.literal(1),
  sha256: sha256Schema,
}).strict();

export type RepositoryObjectRefV2 = Readonly<z.infer<typeof repositoryObjectRefV2Schema>>;

const objectRefArraySchema = z.array(repositoryObjectRefV2Schema)
  .max(repositoryCacheStoragePolicyV1.maxObjectsPerRoot);

const rootUnsignedSchema = z.object({
  dependencyObjects: objectRefArraySchema,
  factReceiptObjects: objectRefArraySchema,
  generation: indexGenerationSchema,
  outlineViewObjects: objectRefArraySchema,
  referencePostingObjects: objectRefArraySchema,
  schemaVersion: z.literal(2),
  storagePolicySha256: sha256Schema,
  symbolPayloadObjects: objectRefArraySchema,
  symbolSearchDirectoryObjects: objectRefArraySchema,
  unitDirectoryObjects: objectRefArraySchema,
}).strict();

const rootRefFields = Object.freeze([
  ["dependencyObjects", "dependency_view"],
  ["factReceiptObjects", "fact_receipt"],
  ["outlineViewObjects", "outline_view"],
  ["referencePostingObjects", "reference_posting"],
  ["symbolPayloadObjects", "symbol_payload"],
  ["symbolSearchDirectoryObjects", "symbol_search_directory"],
  ["unitDirectoryObjects", "unit_directory"],
] as const);

function objectRefOrder(ref: RepositoryObjectRefV2): string {
  return `${ref.kind}\0${ref.logicalPartitionKey}\0${ref.sha256}`;
}

export const repositoryStorageRootV2Schema = rootUnsignedSchema.extend({
  storageManifestSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const unsigned = {
    dependencyObjects: value.dependencyObjects,
    factReceiptObjects: value.factReceiptObjects,
    generation: value.generation,
    outlineViewObjects: value.outlineViewObjects,
    referencePostingObjects: value.referencePostingObjects,
    schemaVersion: value.schemaVersion,
    storagePolicySha256: value.storagePolicySha256,
    symbolPayloadObjects: value.symbolPayloadObjects,
    symbolSearchDirectoryObjects: value.symbolSearchDirectoryObjects,
    unitDirectoryObjects: value.unitDirectoryObjects,
  };
  if (sha256Canonical(unsigned) !== value.storageManifestSha256) {
    context.addIssue({ code: "custom", message: "repository storage root hash mismatch" });
  }
  let total = 0;
  const identities = new Set<string>();
  for (const [field, kind] of rootRefFields) {
    const refs = value[field];
    total += refs.length;
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index]!;
      if (ref.kind !== kind) context.addIssue({ code: "custom", message: `${field} contains the wrong object kind` });
      if (index > 0 && objectRefOrder(refs[index - 1]!) >= objectRefOrder(ref)) {
        context.addIssue({ code: "custom", message: `${field} must be sorted and unique` });
      }
      const identity = objectRefOrder(ref);
      if (identities.has(identity)) context.addIssue({ code: "custom", message: "repository root repeats an object ref" });
      identities.add(identity);
    }
  }
  if (total > repositoryCacheStoragePolicyV1.maxObjectsPerRoot) {
    context.addIssue({ code: "custom", message: "repository root exceeds its total object bound" });
  }
});

export type RepositoryStorageRootV2 = Readonly<z.infer<typeof repositoryStorageRootV2Schema>>;

const currentPointerUnsignedSchema = z.object({
  engineIdentitySha256: sha256Schema,
  generationSha256: sha256Schema,
  ruleManifestSha256: sha256Schema,
  schemaVersion: z.literal(2),
  sourceStateSha256: sha256Schema,
  storageManifestSha256: sha256Schema,
  storagePolicySha256: sha256Schema,
}).strict();

export const repositoryCurrentPointerV2Schema = currentPointerUnsignedSchema.extend({
  pointerSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const unsigned = {
    engineIdentitySha256: value.engineIdentitySha256,
    generationSha256: value.generationSha256,
    ruleManifestSha256: value.ruleManifestSha256,
    schemaVersion: value.schemaVersion,
    sourceStateSha256: value.sourceStateSha256,
    storageManifestSha256: value.storageManifestSha256,
    storagePolicySha256: value.storagePolicySha256,
  };
  if (sha256Canonical(unsigned) !== value.pointerSha256) {
    context.addIssue({ code: "custom", message: "repository v2 current pointer hash mismatch" });
  }
});

export type RepositoryCurrentPointerV2 = Readonly<z.infer<typeof repositoryCurrentPointerV2Schema>>;

export const repositoryFactKindsV1 = Object.freeze([
  "dependency_resolution",
  "module_surface",
  "query_view",
  "semantic_unit",
  "source_unit",
  "syntax_facts",
] as const);

const factReceiptUnsignedSchema = z.object({
  authorityProjectionSha256: sha256Schema,
  dependencyFactSha256s: z.array(sha256Schema).max(65_536),
  engineIdentitySha256: sha256Schema,
  factKind: z.enum(repositoryFactKindsV1),
  factSchemaSha256: sha256Schema,
  logicalName: repositoryCacheLogicalPartitionKeySchema,
  outputObjectSha256: sha256Schema,
  schemaVersion: z.literal(1),
}).strict();

export const repositoryFactReceiptV1Schema = factReceiptUnsignedSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const unsigned = {
    authorityProjectionSha256: value.authorityProjectionSha256,
    dependencyFactSha256s: value.dependencyFactSha256s,
    engineIdentitySha256: value.engineIdentitySha256,
    factKind: value.factKind,
    factSchemaSha256: value.factSchemaSha256,
    logicalName: value.logicalName,
    outputObjectSha256: value.outputObjectSha256,
    schemaVersion: value.schemaVersion,
  };
  if (sha256Canonical(unsigned) !== value.receiptSha256) {
    context.addIssue({ code: "custom", message: "repository fact receipt hash mismatch" });
  }
  if (new Set(value.dependencyFactSha256s).size !== value.dependencyFactSha256s.length ||
      [...value.dependencyFactSha256s].sort().some((entry, index) => entry !== value.dependencyFactSha256s[index])) {
    context.addIssue({ code: "custom", message: "fact dependencies must be sorted and unique" });
  }
});

export type RepositoryFactReceiptV1 = Readonly<z.infer<typeof repositoryFactReceiptV1Schema>>;

const objectBase = {
  logicalPartitionKey: repositoryCacheLogicalPartitionKeySchema,
  schemaVersion: z.literal(1),
} as const;

const outlineSymbolSchema = z.tuple([
  repositoryRelativePathSchema,
  sha256Schema,
  repositorySymbolKindSchema,
  z.string().min(1).max(1_024),
  z.number().int().nonnegative(),
]);

const symbolSearchEntrySchema = z.tuple([
  z.string().min(1).max(1_024),
  z.string().min(1).max(2_048),
  repositoryRelativePathSchema,
  repositorySymbolKindSchema,
  sha256Schema,
  repositoryCacheLogicalPartitionKeySchema,
]);

const symbolPayloadUnitSchema = z.tuple([
  repositoryRelativePathSchema,
  z.array(indexedImportSchema).max(65_536),
  z.array(indexedSymbolSchema).max(65_536),
]);

export const repositoryCacheObjectSchemasV2 = Object.freeze({
  dependency_view: z.object({
    ...objectBase,
    imports: z.array(indexedImportSchema).max(65_536),
    kind: z.literal("dependency_view"),
    unitPath: repositoryRelativePathSchema,
  }).strict(),
  fact_receipt: z.object({
    ...objectBase,
    kind: z.literal("fact_receipt"),
    receipts: z.array(repositoryFactReceiptV1Schema).max(65_536),
  }).strict(),
  outline_view: z.object({
    ...objectBase,
    kind: z.literal("outline_view"),
    symbols: z.array(outlineSymbolSchema).max(65_536),
  }).strict(),
  reference_posting: z.object({
    ...objectBase,
    kind: z.literal("reference_posting"),
    references: z.array(indexedReferenceSchema).max(65_536),
  }).strict(),
  symbol_payload: z.object({
    ...objectBase,
    kind: z.literal("symbol_payload"),
    units: z.array(symbolPayloadUnitSchema).max(65_536),
  }).strict(),
  symbol_search_directory: z.object({
    ...objectBase,
    entries: z.array(symbolSearchEntrySchema).max(65_536),
    kind: z.literal("symbol_search_directory"),
  }).strict(),
  unit_directory: z.object({
    ...objectBase,
    kind: z.literal("unit_directory"),
    units: z.array(indexedSourceUnitSchema).max(65_536),
  }).strict(),
});

export type RepositoryCacheObjectV2 =
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["dependency_view"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["fact_receipt"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["outline_view"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["reference_posting"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["symbol_payload"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["symbol_search_directory"]>>
  | Readonly<z.infer<(typeof repositoryCacheObjectSchemasV2)["unit_directory"]>>;

const leaseUnsignedSchema = z.object({
  createdAt: z.string().datetime({ offset: false }),
  hostFingerprint: sha256Schema,
  leaseId: z.uuid(),
  pid: z.number().int().positive(),
  processStartIdentity: sha256Schema,
  schemaVersion: z.literal(1),
  storageManifestSha256: sha256Schema,
}).strict();

export const repositoryReaderLeaseV1Schema = leaseUnsignedSchema.extend({
  leaseSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const unsigned = {
    createdAt: value.createdAt,
    hostFingerprint: value.hostFingerprint,
    leaseId: value.leaseId,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
    schemaVersion: value.schemaVersion,
    storageManifestSha256: value.storageManifestSha256,
  };
  if (sha256Canonical(unsigned) !== value.leaseSha256) {
    context.addIssue({ code: "custom", message: "repository reader lease hash mismatch" });
  }
});

export type RepositoryReaderLeaseV1 = Readonly<z.infer<typeof repositoryReaderLeaseV1Schema>>;

export interface RepositoryStorageRootV2Input {
  readonly dependencyObjects: readonly RepositoryObjectRefV2[];
  readonly factReceiptObjects: readonly RepositoryObjectRefV2[];
  readonly generation: IndexGenerationV1;
  readonly outlineViewObjects: readonly RepositoryObjectRefV2[];
  readonly referencePostingObjects: readonly RepositoryObjectRefV2[];
  readonly schemaVersion: 2;
  readonly storagePolicySha256: string;
  readonly symbolPayloadObjects: readonly RepositoryObjectRefV2[];
  readonly symbolSearchDirectoryObjects: readonly RepositoryObjectRefV2[];
  readonly unitDirectoryObjects: readonly RepositoryObjectRefV2[];
}

export function createRepositoryStorageRootV2(input: RepositoryStorageRootV2Input): RepositoryStorageRootV2 {
  const unsigned = rootUnsignedSchema.parse({
    ...input,
    dependencyObjects: [...input.dependencyObjects],
    factReceiptObjects: [...input.factReceiptObjects],
    outlineViewObjects: [...input.outlineViewObjects],
    referencePostingObjects: [...input.referencePostingObjects],
    symbolPayloadObjects: [...input.symbolPayloadObjects],
    symbolSearchDirectoryObjects: [...input.symbolSearchDirectoryObjects],
    unitDirectoryObjects: [...input.unitDirectoryObjects],
  });
  return repositoryStorageRootV2Schema.parse({ ...unsigned, storageManifestSha256: sha256Canonical(unsigned) });
}

export function createRepositoryCurrentPointerV2(
  root: RepositoryStorageRootV2,
): RepositoryCurrentPointerV2 {
  const unsigned = currentPointerUnsignedSchema.parse({
    engineIdentitySha256: root.generation.engineIdentitySha256,
    generationSha256: root.generation.generationSha256,
    ruleManifestSha256: root.generation.ruleManifestSha256,
    schemaVersion: 2,
    sourceStateSha256: root.generation.sourceStateSha256,
    storageManifestSha256: root.storageManifestSha256,
    storagePolicySha256: root.storagePolicySha256,
  });
  return repositoryCurrentPointerV2Schema.parse({ ...unsigned, pointerSha256: sha256Canonical(unsigned) });
}

export interface RepositoryFactReceiptV1Input {
  readonly authorityProjectionSha256: string;
  readonly dependencyFactSha256s: readonly string[];
  readonly engineIdentitySha256: string;
  readonly factKind: RepositoryFactReceiptV1["factKind"];
  readonly factSchemaSha256: string;
  readonly logicalName: string;
  readonly outputObjectSha256: string;
  readonly schemaVersion: 1;
}

export function createRepositoryFactReceiptV1(
  input: RepositoryFactReceiptV1Input,
): RepositoryFactReceiptV1 {
  const unsigned = factReceiptUnsignedSchema.parse({ ...input, dependencyFactSha256s: [...input.dependencyFactSha256s] });
  return repositoryFactReceiptV1Schema.parse({ ...unsigned, receiptSha256: sha256Canonical(unsigned) });
}

export function createRepositoryReaderLeaseV1(
  input: z.infer<typeof leaseUnsignedSchema>,
): RepositoryReaderLeaseV1 {
  const unsigned = leaseUnsignedSchema.parse(input);
  return repositoryReaderLeaseV1Schema.parse({ ...unsigned, leaseSha256: sha256Canonical(unsigned) });
}

export function parseRepositoryCacheObjectV2(
  kind: RepositoryCacheObjectKindV2,
  value: unknown,
): RepositoryCacheObjectV2 {
  return repositoryCacheObjectSchemasV2[kind].parse(value) as RepositoryCacheObjectV2;
}

export function repositoryCacheObjectSha256(
  input: Pick<RepositoryObjectRefV2, "bytes" | "encoding" | "kind" | "logicalPartitionKey" | "objectSchemaVersion">,
  payload: Uint8Array,
): string {
  const domain = `bornagent:repository-cache-object:v2\0${input.kind}\0${input.logicalPartitionKey}\0${String(input.objectSchemaVersion)}\0${input.encoding}\0${String(input.bytes)}\0`;
  return createHash("sha256").update(domain, "utf8").update(payload).digest("hex");
}

export function allRepositoryObjectRefsV2(root: RepositoryStorageRootV2): readonly RepositoryObjectRefV2[] {
  return Object.freeze(rootRefFields.flatMap(([field]) => root[field]));
}

export function rootObjectRefsForKindV2(
  root: RepositoryStorageRootV2,
  kind: RepositoryCacheObjectKindV2,
): readonly RepositoryObjectRefV2[] {
  const field = rootRefFields.find(([, candidate]) => candidate === kind)?.[0];
  if (field === undefined) return Object.freeze([]);
  return root[field];
}

export function repositoryFactSchemaIdentitySha256(kind: RepositoryFactReceiptV1["factKind"]): string {
  return sha256Canonical({ factKind: kind, schemaVersion: 1, storageSchemaVersion: 2 });
}

export type RepositoryStorageRootGenerationV2 = IndexGenerationV1;
export interface RepositorySymbolSearchEntryV2 {
  readonly kind: RepositorySymbolKind;
  readonly name: string;
  readonly payloadPartitionKey: string;
  readonly qualifiedName: string;
  readonly recordId: string;
  readonly relativePath: string;
}
export interface RepositoryOutlineSymbolV2 {
  readonly kind: RepositorySymbolKind;
  readonly name: string;
  readonly recordId: string;
  readonly relativePath: string;
  readonly startLine: number;
}
export type RepositorySymbolKindV2 = RepositorySymbolKind;
