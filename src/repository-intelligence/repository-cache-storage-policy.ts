import { sha256Canonical } from "../completion/canonical-json.js";

export const repositoryCacheObjectKindsV2 = Object.freeze([
  "dependency_view",
  "fact_receipt",
  "outline_view",
  "reference_posting",
  "symbol_payload",
  "symbol_search_directory",
  "unit_directory",
] as const);

export type RepositoryCacheObjectKindV2 = (typeof repositoryCacheObjectKindsV2)[number];

export interface RepositoryCacheObjectKindBoundV1 {
  readonly kind: RepositoryCacheObjectKindV2;
  readonly maxDecodedBytes: 33_554_432;
  readonly maxEncodedBytes: 8_388_608;
  readonly maxRecords: 65_536;
  readonly objectSchemaVersion: 1;
  readonly schemaIdentitySha256: string;
}

export interface RepositoryCacheStoragePolicyV1 {
  readonly decoderIdentitySha256: string;
  readonly leaseGcLockWaitMs: 5_000;
  readonly maxActiveLeases: 4_096;
  readonly maxGcBytesPerPass: 134_217_728;
  readonly maxGcEntriesPerPass: 4_096;
  readonly maxGcPassesPerRun: 67;
  readonly maxGcRootMetadataBytesPerSnapshot: 67_108_864;
  readonly maxKnownRoots: 4_096;
  readonly maxLeaseBytes: 16_384;
  readonly maxManagedObjects: 262_144;
  readonly maxObjectBytes: 8_388_608;
  readonly maxObjectsPerRoot: 65_536;
  readonly maxQuarantineBytes: 67_108_864;
  readonly maxQuarantineEntries: 128;
  readonly maxRootBytes: 8_388_608;
  readonly normalizationIdentitySha256: string;
  readonly objectKindBounds: readonly RepositoryCacheObjectKindBoundV1[];
  readonly partitionAlgorithm: "kind-logical-range-v1";
  readonly partitionAlgorithmVersion: 1;
  readonly publishHeadroomBytes: 67_108_864;
  readonly schemaVersion: 1;
  readonly softTotalBudgetBytes: 536_870_912;
  readonly targetEncodedObjectBytes: 1_048_576;
}

const normalizationIdentity = Object.freeze({
  algorithm: "canonical-json-sorted-fields-v1",
  logicalPathEncoding: "repository-relative-posix-v1",
  textEncoding: "utf8-v1",
});

const decoderIdentity = Object.freeze({
  boundsAuthority: "repository-cache-storage-policy-v1",
  jsonDecoder: "strict-json-no-duplicate-keys-v1",
  schemaDecoder: "zod-strict-object-v1",
});

const objectRepresentationV1: Readonly<Record<RepositoryCacheObjectKindV2, string>> = Object.freeze({
  dependency_view: "strict-object-unit-imports-v1",
  fact_receipt: "strict-object-receipt-array-v1",
  outline_view: "tuple-path-record-kind-name-start-line-v1",
  reference_posting: "strict-object-reference-array-one-nybble-bucket-v1",
  symbol_payload: "tuple-unit-imports-symbols-64k-shards-v1",
  symbol_search_directory: "tuple-name-qualified-path-kind-record-payload-v1",
  unit_directory: "strict-object-unit-array-v1",
});

function schemaIdentity(kind: RepositoryCacheObjectKindV2): string {
  return sha256Canonical({
    encoding: "canonical-json-v1",
    kind,
    objectSchemaVersion: 1,
    recordOrdering: "kind-logical-range-v1",
    representation: objectRepresentationV1[kind],
  });
}

export const repositoryCacheStoragePolicyV1: RepositoryCacheStoragePolicyV1 = Object.freeze({
  decoderIdentitySha256: sha256Canonical(decoderIdentity),
  leaseGcLockWaitMs: 5_000,
  maxActiveLeases: 4_096,
  maxGcBytesPerPass: 134_217_728,
  maxGcEntriesPerPass: 4_096,
  maxGcPassesPerRun: 67,
  maxGcRootMetadataBytesPerSnapshot: 67_108_864,
  maxKnownRoots: 4_096,
  maxLeaseBytes: 16_384,
  maxManagedObjects: 262_144,
  maxObjectBytes: 8_388_608,
  maxObjectsPerRoot: 65_536,
  maxQuarantineBytes: 67_108_864,
  maxQuarantineEntries: 128,
  maxRootBytes: 8_388_608,
  normalizationIdentitySha256: sha256Canonical(normalizationIdentity),
  objectKindBounds: Object.freeze(repositoryCacheObjectKindsV2.map((kind) => Object.freeze({
    kind,
    maxDecodedBytes: 33_554_432 as const,
    maxEncodedBytes: 8_388_608 as const,
    maxRecords: 65_536 as const,
    objectSchemaVersion: 1 as const,
    schemaIdentitySha256: schemaIdentity(kind),
  }))),
  partitionAlgorithm: "kind-logical-range-v1",
  partitionAlgorithmVersion: 1,
  publishHeadroomBytes: 67_108_864,
  schemaVersion: 1,
  softTotalBudgetBytes: 536_870_912,
  targetEncodedObjectBytes: 1_048_576,
});

export const repositoryCacheStoragePolicySha256 = sha256Canonical(repositoryCacheStoragePolicyV1);
