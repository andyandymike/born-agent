import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import {
  repositoryCacheBenchmarkGuardDescriptorV1,
  repositoryCacheBenchmarkGuardIdentitySha256,
} from "./repository-cache-benchmark-guard.js";
import {
  repositoryCacheObjectKindsV2,
  repositoryCacheStoragePolicySha256,
  repositoryCacheStoragePolicyV1,
} from "./repository-cache-storage-policy.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const safeRelativePathSchema = z.string().min(1).max(512).refine((value) => (
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
), "must be a safe repository-relative POSIX path");

export const repositoryCacheCapabilities = Object.freeze([
  "lease_protocol_v2",
  "monolith_storage_v1",
  "persistent_facts_v1",
  "production_selected_v2",
  "rooted_gc_v2",
  "semantic_index_v1",
  "sharded_storage_v2",
] as const);

export const monolithV1CandidateComposition = Object.freeze({
  candidateId: "monolith_v1",
  modules: Object.freeze([
    "DefaultRepositoryNavigationService",
    "RepositoryIndexStore:v1",
    "TypeScriptLanguageServiceAdapter",
  ]),
  packageSchemaVersion: 1,
});
export const monolithV1CandidateCompositionSha256 = sha256Canonical(monolithV1CandidateComposition);

export const shardedCasV2CandidateComposition = Object.freeze({
  candidateId: "sharded_cas_v2",
  modules: Object.freeze([
    "DefaultRepositoryNavigationService",
    "RepositoryIndexV2Store:sharded-cas",
    "TypeScriptLanguageServiceAdapter",
  ]),
  packageSchemaVersion: 1,
});
export const shardedCasV2CandidateCompositionSha256 = sha256Canonical(shardedCasV2CandidateComposition);

export const rootedGcV2CandidateComposition = Object.freeze({
  candidateId: "rooted_gc_v2",
  modules: Object.freeze([
    "DefaultRepositoryNavigationService",
    "RepositoryIndexV2Store:reader-leases-rooted-gc",
    "TypeScriptLanguageServiceAdapter",
  ]),
  packageSchemaVersion: 1,
});
export const rootedGcV2CandidateCompositionSha256 = sha256Canonical(rootedGcV2CandidateComposition);

export const persistentDagV2CandidateComposition = Object.freeze({
  candidateId: "persistent_dag_v2",
  modules: Object.freeze([
    "DefaultRepositoryNavigationService",
    "PersistentRepositoryFactUpdate:v1",
    "RepositoryIndexV2Store:reader-leases-rooted-gc",
    "TypeScriptLanguageServiceAdapter",
  ]),
  packageSchemaVersion: 1,
});
export const persistentDagV2CandidateCompositionSha256 = sha256Canonical(persistentDagV2CandidateComposition);

export const productionV2CandidateComposition = Object.freeze({
  candidateId: "production_v2",
  modules: Object.freeze([
    "DefaultRepositoryNavigationService:production-v2",
    "RepositoryIndexV2Store:reader-leases-rooted-gc",
    "RepositoryInvalidationWatcher:v2",
    "RepositoryNavigationIntegrityKey:migrated-v2",
    "TypeScriptLanguageServiceAdapter",
  ]),
  packageSchemaVersion: 1,
});
export const productionV2CandidateCompositionSha256 = sha256Canonical(productionV2CandidateComposition);

export const repositoryCacheCandidateDefinitions = Object.freeze({
  monolith_v1: Object.freeze({
    capabilities: Object.freeze(["monolith_storage_v1", "semantic_index_v1"] as const),
    candidateCompositionSha256: monolithV1CandidateCompositionSha256,
    evidenceId: "RIC-E001-V1-BASELINE",
    storageVersion: "v1" as const,
  }),
  persistent_dag_v2: Object.freeze({
    capabilities: Object.freeze([
      "lease_protocol_v2",
      "persistent_facts_v1",
      "rooted_gc_v2",
      "semantic_index_v1",
      "sharded_storage_v2",
    ] as const),
    candidateCompositionSha256: persistentDagV2CandidateCompositionSha256,
    evidenceId: "RIC-E004-PERSISTENT-FACTS",
    storageVersion: "v2" as const,
  }),
  production_v2: Object.freeze({
    capabilities: Object.freeze([
      "lease_protocol_v2",
      "production_selected_v2",
      "rooted_gc_v2",
      "semantic_index_v1",
      "sharded_storage_v2",
    ] as const),
    candidateCompositionSha256: productionV2CandidateCompositionSha256,
    evidenceId: "RIC-E005-PRODUCTION-CLOSURE",
    storageVersion: "v2" as const,
  }),
  rooted_gc_v2: Object.freeze({
    capabilities: Object.freeze([
      "lease_protocol_v2",
      "rooted_gc_v2",
      "semantic_index_v1",
      "sharded_storage_v2",
    ] as const),
    candidateCompositionSha256: rootedGcV2CandidateCompositionSha256,
    evidenceId: "RIC-E003B-ROOTED-GC",
    storageVersion: "v2" as const,
  }),
  sharded_cas_v2: Object.freeze({
    capabilities: Object.freeze(["semantic_index_v1", "sharded_storage_v2"] as const),
    candidateCompositionSha256: shardedCasV2CandidateCompositionSha256,
    evidenceId: "RIC-E002-SHARDED-CAS",
    storageVersion: "v2" as const,
  }),
});
export type RepositoryCacheCandidateId = keyof typeof repositoryCacheCandidateDefinitions;

const capabilitySchema = z.enum(repositoryCacheCapabilities);
export type RepositoryCacheCapability = z.infer<typeof capabilitySchema>;

export const repositoryCacheTraceCaseIds = Object.freeze([
  "C0", "C1A", "C1B", "C1C", "C2", "C3", "C4", "C5", "C6", "C7",
  "C8A", "C8B", "C8C", "C9", "C10", "C11", "C12",
] as const);
const traceCaseIdSchema = z.enum(repositoryCacheTraceCaseIds);
export type RepositoryCacheTraceCaseId = z.infer<typeof traceCaseIdSchema>;

const sortedUniqueCapabilitiesSchema = z.array(capabilitySchema).superRefine((value, context) => {
  if (new Set(value).size !== value.length || [...value].sort().some((item, index) => item !== value[index])) {
    context.addIssue({ code: "custom", message: "capabilities must be unique and sorted" });
  }
  if (value.includes("rooted_gc_v2") && !value.includes("lease_protocol_v2")) {
    context.addIssue({ code: "custom", message: "rooted_gc_v2 requires lease_protocol_v2" });
  }
  if (value.includes("production_selected_v2") && !value.includes("sharded_storage_v2")) {
    context.addIssue({ code: "custom", message: "production_selected_v2 requires sharded_storage_v2" });
  }
});

const objectBoundSchema = z.object({
  kind: z.enum(repositoryCacheObjectKindsV2),
  maxDecodedBytes: z.literal(33_554_432),
  maxEncodedBytes: z.literal(8_388_608),
  maxRecords: z.literal(65_536),
  objectSchemaVersion: z.literal(1),
  schemaIdentitySha256: sha256Schema,
}).strict();

const storagePolicySchema = z.object({
  decoderIdentitySha256: sha256Schema,
  leaseGcLockWaitMs: z.literal(5_000),
  maxActiveLeases: z.literal(4_096),
  maxGcBytesPerPass: z.literal(134_217_728),
  maxGcEntriesPerPass: z.literal(4_096),
  maxGcPassesPerRun: z.literal(67),
  maxGcRootMetadataBytesPerSnapshot: z.literal(67_108_864),
  maxKnownRoots: z.literal(4_096),
  maxLeaseBytes: z.literal(16_384),
  maxManagedObjects: z.literal(262_144),
  maxObjectBytes: z.literal(8_388_608),
  maxObjectsPerRoot: z.literal(65_536),
  maxQuarantineBytes: z.literal(67_108_864),
  maxQuarantineEntries: z.literal(128),
  maxRootBytes: z.literal(8_388_608),
  normalizationIdentitySha256: sha256Schema,
  objectKindBounds: z.array(objectBoundSchema).length(repositoryCacheObjectKindsV2.length),
  partitionAlgorithm: z.literal("kind-logical-range-v1"),
  partitionAlgorithmVersion: z.literal(1),
  publishHeadroomBytes: z.literal(67_108_864),
  schemaVersion: z.literal(1),
  softTotalBudgetBytes: z.literal(536_870_912),
  targetEncodedObjectBytes: z.literal(1_048_576),
}).strict();

const bootstrapCaseSchema = z.object({
  file: safeRelativePathSchema,
  fullName: z.string().min(1).max(2_048),
  id: identifierSchema,
}).strict();

const corpusSchema = z.object({
  corpusId: identifierSchema,
  definitionSha256: sha256Schema,
  fileCount: z.number().int().min(12).max(4_096),
  generatorVersion: z.literal(1),
  seed: z.number().int().nonnegative(),
  workspaceSha256: sha256Schema,
}).strict();

const candidateProfileSchema = z.object({
  candidateCapabilitySha256: sha256Schema,
  candidateCompositionSha256: sha256Schema,
  candidateId: identifierSchema,
  capabilities: sortedUniqueCapabilitiesSchema,
}).strict();

const traceCaseSchema = z.object({
  caseId: traceCaseIdSchema,
  minimumSamples: z.number().int().min(1).max(32),
  queryIds: z.array(identifierSchema),
  requiredCapabilities: sortedUniqueCapabilitiesSchema,
}).strict();

const querySchema = z.object({ inputSha256: sha256Schema, queryId: identifierSchema }).strict();

const evidenceSchema = z.object({
  candidateId: identifierSchema,
  corpusId: identifierSchema,
  evidenceId: identifierSchema,
  requiredTraceCases: z.array(traceCaseIdSchema).nonempty(),
  workPackage: z.enum(["RIC0", "RIC1", "RIC2", "RIC3", "RIC4"]),
}).strict();

const guardSchema = z.object({
  descriptor: z.object({
    credentialPolicy: z.literal("deny-known-provider-env-read-v1"),
    guardedCredentialNames: z.array(z.string()).nonempty(),
    networkPolicy: z.literal("deny-fetch-dns-tcp-udp-v1"),
    schemaVersion: z.literal(1),
  }).strict(),
  identitySha256: sha256Schema,
}).strict();

const repositoryCacheEvidenceManifestSchema = z.object({
  bootstrapCases: z.array(bootstrapCaseSchema).nonempty(),
  candidateProfiles: z.array(candidateProfileSchema).nonempty(),
  corpora: z.array(corpusSchema).nonempty(),
  evidence: z.array(evidenceSchema).nonempty(),
  guard: guardSchema,
  manifestId: z.literal("repository-intelligence-cache-optimization-v1"),
  queries: z.array(querySchema).nonempty(),
  schemaVersion: z.literal(1),
  storagePolicy: storagePolicySchema,
  storagePolicySha256: sha256Schema,
  traceCases: z.array(traceCaseSchema).length(repositoryCacheTraceCaseIds.length),
}).strict();

export type RepositoryCacheEvidenceManifestV1 = Readonly<z.infer<typeof repositoryCacheEvidenceManifestSchema>>;

const nullableCounter = z.number().int().nonnegative().nullable();
export const repositoryCacheWorkCountersSchema = z.object({
  activeLeaseBytes: nullableCounter,
  activeLeaseCount: nullableCounter,
  activeManagedBytes: nullableCounter,
  cacheBytesDecoded: nullableCounter,
  cacheBytesRead: nullableCounter,
  cacheBytesWritten: nullableCounter,
  canonicalMismatchCount: nullableCounter,
  cleanFullFallbackCount: nullableCounter,
  corruptFalseResultCount: nullableCounter,
  dataObjectBytesDecodedByKind: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  dataObjectBytesReadByKind: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  dependencyEdgesVisited: nullableCounter,
  factsRecomputed: nullableCounter,
  factsReused: nullableCounter,
  factsValidated: nullableCounter,
  gcPendingBytes: nullableCounter,
  gcReclaimedBytes: nullableCounter,
  liveReachableBytes: nullableCounter,
  logicalReachableBytes: nullableCounter,
  managedPhysicalBytes: nullableCounter,
  objectsCreated: nullableCounter,
  objectsOpened: nullableCounter,
  objectsReused: nullableCounter,
  observedCacheRegularFileCount: z.number().int().nonnegative(),
  observedCacheRootBytes: z.number().int().nonnegative(),
  pointerBytesRead: nullableCounter,
  protectedV1Bytes: nullableCounter,
  quarantineBytes: nullableCounter,
  queryDataObjectBytesDecoded: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  queryRecordsExamined: nullableCounter,
  rootMetadataBytesRead: nullableCounter,
  ruleFilesRead: nullableCounter,
  sourceBytesHashed: nullableCounter,
  sourceFilesStableRead: nullableCounter,
  staleResultCount: nullableCounter,
  tmpBytes: nullableCounter,
  unitsParsed: nullableCounter,
  unitsRebound: nullableCounter,
  unitsReparsed: nullableCounter,
  unmanagedV2Bytes: nullableCounter,
  unreachableKnownBytes: nullableCounter,
}).strict();
export type RepositoryCacheWorkCountersV1 = Readonly<z.infer<typeof repositoryCacheWorkCountersSchema>>;

const sampleSchema = z.object({
  buildMode: z.enum(["cold", "incremental", "reused", "rejected"]).nullable(),
  counters: repositoryCacheWorkCountersSchema,
  diagnosticDurationMs: z.number().nonnegative().nullable(),
  errorCode: z.string().min(1).max(128).nullable(),
  generationSha256: sha256Schema.nullable(),
  outcomeSha256: sha256Schema,
}).strict();

const reportCaseSchema = z.object({
  caseId: traceCaseIdSchema,
  reason: z.string().min(1).max(256).nullable(),
  samples: z.array(sampleSchema),
  status: z.enum(["pass", "fail", "not_applicable", "skipped"]),
}).strict();

const checkoutSchema = z.object({
  fingerprintSha256: sha256Schema,
  headSha256: z.string().regex(/^[a-f0-9]{40,64}$/u),
}).strict();

const reportUnsignedSchema = z.object({
  arch: z.string().min(1).max(64),
  candidateCapabilitySha256: sha256Schema,
  candidateCompositionSha256: sha256Schema,
  candidateId: identifierSchema,
  capabilities: sortedUniqueCapabilitiesSchema,
  cases: z.array(reportCaseSchema),
  checkout: checkoutSchema,
  command: z.array(z.string().max(4_096)).nonempty(),
  corpus: corpusSchema,
  evidenceId: identifierSchema,
  guard: z.object({
    credentialReadAttemptCount: z.number().int().nonnegative(),
    identitySha256: sha256Schema,
    networkAttemptCount: z.number().int().nonnegative(),
  }).strict(),
  manifestSha256: sha256Schema,
  nodeVersion: z.string().min(1).max(64),
  platform: z.enum(["linux", "win32"]),
  reportId: z.literal("repository-cache-benchmark-report-v1"),
  schemaVersion: z.literal(1),
  storagePolicySha256: sha256Schema,
}).strict();

const reportSchema = reportUnsignedSchema.extend({ reportSha256: sha256Schema }).strict();
export type RepositoryCacheBenchmarkReportV1 = Readonly<z.infer<typeof reportSchema>>;
export type RepositoryCacheBenchmarkReportInputV1 = Readonly<z.infer<typeof reportUnsignedSchema>>;

const receiptCaseSchema = z.object({
  caseId: traceCaseIdSchema,
  status: z.enum(["pass", "fail", "not_applicable", "missing", "unexpected_skip"]),
}).strict();

const receiptUnsignedSchema = z.object({
  candidateCapabilitySha256: sha256Schema,
  cases: z.array(receiptCaseSchema),
  checkoutFingerprintSha256: sha256Schema,
  createdAt: z.string().datetime({ offset: true }),
  evidenceId: identifierSchema,
  manifestSha256: sha256Schema,
  nodeVersion: z.string().min(1).max(64),
  platform: z.enum(["linux", "win32"]),
  receiptId: z.literal("repository-cache-evidence-receipt-v1"),
  reportSha256: sha256Schema,
  schemaVersion: z.literal(1),
  status: z.enum(["pass", "fail"]),
}).strict();
const receiptSchema = receiptUnsignedSchema.extend({ receiptSha256: sha256Schema }).strict();
export type RepositoryCacheEvidenceReceiptV1 = Readonly<z.infer<typeof receiptSchema>>;

export class RepositoryCacheEvidenceError extends Error {
  override readonly name = "RepositoryCacheEvidenceError";

  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new RepositoryCacheEvidenceError(code, message, cause === undefined ? undefined : { cause });
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, code: string, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code, `${label} failed strict schema validation`, parsed.error);
  return parsed.data;
}

function assertUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail("repository_cache_manifest_duplicate_id", `${label} repeats ${identity}`);
    seen.add(identity);
  }
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function candidateCapabilitySha256(input: {
  readonly candidateCompositionSha256: string;
  readonly candidateId: string;
  readonly capabilities: readonly RepositoryCacheCapability[];
}): string {
  return sha256Canonical({
    candidateCompositionSha256: input.candidateCompositionSha256,
    candidateId: input.candidateId,
    capabilities: input.capabilities,
  });
}

export function parseRepositoryCacheEvidenceManifest(source: string): RepositoryCacheEvidenceManifestV1 {
  const manifest = parseSchema(
    repositoryCacheEvidenceManifestSchema,
    parseStrictJson(source),
    "repository_cache_manifest_invalid",
    "repository cache evidence manifest",
  );
  assertUnique(manifest.bootstrapCases, (value) => value.id, "bootstrap case id");
  assertUnique(manifest.bootstrapCases, (value) => `${value.file}\0${value.fullName}`, "bootstrap selector");
  assertUnique(manifest.candidateProfiles, (value) => value.candidateId, "candidate profile");
  assertUnique(manifest.corpora, (value) => value.corpusId, "corpus");
  assertUnique(manifest.evidence, (value) => value.evidenceId, "evidence id");
  assertUnique(manifest.queries, (value) => value.queryId, "query id");
  assertUnique(manifest.traceCases, (value) => value.caseId, "trace case");
  if (!exactJson(manifest.storagePolicy, repositoryCacheStoragePolicyV1) ||
      manifest.storagePolicySha256 !== repositoryCacheStoragePolicySha256) {
    fail("repository_cache_manifest_policy_mismatch", "manifest storage policy is not the canonical V1 policy");
  }
  if (!exactJson(manifest.guard.descriptor, repositoryCacheBenchmarkGuardDescriptorV1) ||
      manifest.guard.identitySha256 !== repositoryCacheBenchmarkGuardIdentitySha256) {
    fail("repository_cache_manifest_guard_mismatch", "manifest guard identity is not the protected runner guard");
  }
  for (const profile of manifest.candidateProfiles) {
    if (candidateCapabilitySha256(profile) !== profile.candidateCapabilitySha256) {
      fail("repository_cache_manifest_capability_mismatch", `candidate ${profile.candidateId} capability hash is invalid`);
    }
    const definition = repositoryCacheCandidateDefinitions[profile.candidateId as RepositoryCacheCandidateId];
    if (definition === undefined ||
        profile.candidateCompositionSha256 !== definition.candidateCompositionSha256 ||
        !exactJson(profile.capabilities, definition.capabilities)) {
      fail("repository_cache_manifest_capability_mismatch", `${profile.candidateId} composition or capability set is invalid`);
    }
  }
  const caseIds = manifest.traceCases.map((value) => value.caseId);
  if (!exactJson(caseIds, repositoryCacheTraceCaseIds)) {
    fail("repository_cache_manifest_case_set_mismatch", "trace cases must be the canonical ordered C0-C12 set");
  }
  for (const evidence of manifest.evidence) {
    if (!manifest.candidateProfiles.some((profile) => profile.candidateId === evidence.candidateId)) {
      fail("repository_cache_manifest_invalid", `evidence ${evidence.evidenceId} references an unknown candidate`);
    }
    if (!manifest.corpora.some((corpus) => corpus.corpusId === evidence.corpusId)) {
      fail("repository_cache_manifest_invalid", `evidence ${evidence.evidenceId} references an unknown corpus`);
    }
    if (new Set(evidence.requiredTraceCases).size !== evidence.requiredTraceCases.length) {
      fail("repository_cache_manifest_duplicate_id", `evidence ${evidence.evidenceId} repeats a trace case`);
    }
  }
  return Object.freeze(manifest);
}

export function createRepositoryCacheBenchmarkReport(
  input: RepositoryCacheBenchmarkReportInputV1,
): RepositoryCacheBenchmarkReportV1 {
  const unsigned = parseSchema(reportUnsignedSchema, input, "repository_cache_report_invalid", "benchmark report");
  return Object.freeze(parseSchema(reportSchema, {
    ...unsigned,
    reportSha256: sha256Canonical(unsigned),
  }, "repository_cache_report_invalid", "benchmark report"));
}

export function parseRepositoryCacheBenchmarkReport(source: string): RepositoryCacheBenchmarkReportV1 {
  const report = parseSchema(
    reportSchema,
    parseStrictJson(source),
    "repository_cache_report_invalid",
    "benchmark report",
  );
  const { reportSha256, ...unsigned } = report;
  if (sha256Canonical(unsigned) !== reportSha256) {
    fail("repository_cache_report_hash_mismatch", "benchmark report self hash is invalid");
  }
  if (`${canonicalJson(report)}\n` !== source) {
    fail("repository_cache_report_invalid", "benchmark report bytes are not canonical JSON with one trailing newline");
  }
  return Object.freeze(report);
}

export interface RepositoryCacheValidationContext {
  readonly checkoutFingerprintSha256: string;
  readonly nodeVersion: string;
  readonly platform: "linux" | "win32";
}

export function evaluateRepositoryCacheEvidence(input: {
  readonly context?: RepositoryCacheValidationContext;
  readonly evidenceId: string;
  readonly manifest: RepositoryCacheEvidenceManifestV1;
  readonly manifestSource: string;
  readonly report: RepositoryCacheBenchmarkReportV1;
  readonly now?: Date;
}): RepositoryCacheEvidenceReceiptV1 {
  const evidence = input.manifest.evidence.find((value) => value.evidenceId === input.evidenceId);
  if (evidence === undefined) fail("repository_cache_evidence_unknown", `manifest has no evidence ${input.evidenceId}`);
  const profile = input.manifest.candidateProfiles.find((value) => value.candidateId === evidence.candidateId)!;
  const corpus = input.manifest.corpora.find((value) => value.corpusId === evidence.corpusId)!;
  const report = input.report;
  const reportEvidence = input.manifest.evidence.find((value) => value.evidenceId === report.evidenceId);
  if (report.candidateId !== evidence.candidateId || reportEvidence?.candidateId !== evidence.candidateId ||
      reportEvidence.corpusId !== evidence.corpusId) {
    fail("repository_cache_report_candidate_mismatch", "report evidence or candidate does not match the manifest selection");
  }
  if (!exactJson(report.capabilities, profile.capabilities) ||
      report.candidateCapabilitySha256 !== profile.candidateCapabilitySha256 ||
      report.candidateCompositionSha256 !== profile.candidateCompositionSha256) {
    fail("repository_cache_report_capability_mismatch", "report candidate capability identity is invalid");
  }
  if (!exactJson(report.corpus, corpus)) {
    fail("repository_cache_report_corpus_mismatch", "report corpus is not the manifest corpus");
  }
  if (report.storagePolicySha256 !== input.manifest.storagePolicySha256) {
    fail("repository_cache_report_policy_mismatch", "report storage policy is not the manifest policy");
  }
  if (report.manifestSha256 !== sha256Bytes(input.manifestSource)) {
    fail("repository_cache_manifest_hash_mismatch", "report is not bound to the exact manifest bytes");
  }
  if (report.guard.identitySha256 !== input.manifest.guard.identitySha256 ||
      report.guard.networkAttemptCount !== 0 || report.guard.credentialReadAttemptCount !== 0) {
    fail("repository_cache_report_guard_mismatch", "report guard identity or attempt counts are invalid");
  }
  if (input.context !== undefined && (
    report.checkout.fingerprintSha256 !== input.context.checkoutFingerprintSha256 ||
    report.nodeVersion !== input.context.nodeVersion ||
    report.platform !== input.context.platform
  )) {
    fail("repository_cache_report_execution_context_mismatch", "report does not belong to the exact checkout, platform, and Node runtime");
  }
  assertUnique(report.cases, (value) => value.caseId, "report trace case");
  const reportByCase = new Map(report.cases.map((value) => [value.caseId, value]));
  const cases = evidence.requiredTraceCases.map((caseId) => {
    const definition = input.manifest.traceCases.find((value) => value.caseId === caseId)!;
    const observed = reportByCase.get(caseId);
    if (observed === undefined) return Object.freeze({ caseId, status: "missing" as const });
    if (observed.status === "skipped") return Object.freeze({ caseId, status: "unexpected_skip" as const });
    const missingCapabilities = definition.requiredCapabilities.filter((value) => !profile.capabilities.includes(value));
    if (missingCapabilities.length > 0) {
      const expectedReason = `missing_capability:${missingCapabilities.join(",")}`;
      return Object.freeze({
        caseId,
        status: observed.status === "not_applicable" && observed.reason === expectedReason && observed.samples.length === 0
          ? "not_applicable" as const
          : "fail" as const,
      });
    }
    if (observed.status !== "pass" || observed.reason !== null || observed.samples.length < definition.minimumSamples) {
      return Object.freeze({ caseId, status: "fail" as const });
    }
    const deterministic = observed.samples.map((sample) => canonicalJson({
      buildMode: sample.buildMode,
      counters: sample.counters,
      errorCode: sample.errorCode,
      generationSha256: sample.generationSha256,
      outcomeSha256: sample.outcomeSha256,
    }));
    return Object.freeze({
      caseId,
      status: deterministic.every((value) => value === deterministic[0]) ? "pass" as const : "fail" as const,
    });
  });
  const status = cases.every((value) => value.status === "pass" || value.status === "not_applicable") ? "pass" as const : "fail" as const;
  const unsigned = parseSchema(receiptUnsignedSchema, {
    candidateCapabilitySha256: report.candidateCapabilitySha256,
    cases,
    checkoutFingerprintSha256: report.checkout.fingerprintSha256,
    createdAt: (input.now ?? new Date()).toISOString(),
    evidenceId: evidence.evidenceId,
    manifestSha256: report.manifestSha256,
    nodeVersion: report.nodeVersion,
    platform: report.platform,
    receiptId: "repository-cache-evidence-receipt-v1",
    reportSha256: report.reportSha256,
    schemaVersion: 1,
    status,
  }, "repository_cache_receipt_invalid", "evidence receipt");
  return Object.freeze(parseSchema(receiptSchema, {
    ...unsigned,
    receiptSha256: sha256Canonical(unsigned),
  }, "repository_cache_receipt_invalid", "evidence receipt"));
}

export function parseRepositoryCacheEvidenceReceipt(source: string): RepositoryCacheEvidenceReceiptV1 {
  const receipt = parseSchema(
    receiptSchema,
    parseStrictJson(source),
    "repository_cache_receipt_invalid",
    "evidence receipt",
  );
  const { receiptSha256, ...unsigned } = receipt;
  if (sha256Canonical(unsigned) !== receiptSha256) {
    fail("repository_cache_receipt_hash_mismatch", "receipt self hash is invalid");
  }
  return Object.freeze(receipt);
}

export async function verifyRepositoryCacheEvidenceReceipt(input: {
  readonly context?: RepositoryCacheValidationContext;
  readonly manifest: RepositoryCacheEvidenceManifestV1;
  readonly manifestSource: string;
  readonly receipt: RepositoryCacheEvidenceReceiptV1;
  readonly reportPath: string;
}): Promise<RepositoryCacheEvidenceReceiptV1> {
  const source = await readFile(input.reportPath, "utf8").catch((error: unknown) =>
    fail("repository_cache_report_missing", "receipt report is unavailable", error));
  const report = parseRepositoryCacheBenchmarkReport(source);
  if (report.reportSha256 !== input.receipt.reportSha256) {
    fail("repository_cache_report_hash_mismatch", "receipt report hash does not match report bytes");
  }
  const expected = evaluateRepositoryCacheEvidence({
    ...(input.context === undefined ? {} : { context: input.context }),
    evidenceId: input.receipt.evidenceId,
    manifest: input.manifest,
    manifestSource: input.manifestSource,
    now: new Date(input.receipt.createdAt),
    report,
  });
  if (!exactJson(expected, input.receipt)) {
    fail("repository_cache_receipt_mismatch", "receipt does not match its exact report and manifest");
  }
  return input.receipt;
}

export async function writeRepositoryCacheEvidenceReceiptNoReplace(
  receiptDirectory: string,
  receipt: RepositoryCacheEvidenceReceiptV1,
): Promise<{ readonly path: string; readonly receipt: RepositoryCacheEvidenceReceiptV1 }> {
  const directory = resolve(receiptDirectory, receipt.evidenceId);
  const target = resolve(directory, `${receipt.reportSha256}.json`);
  await mkdir(directory, { recursive: true });
  const source = `${canonicalJson(receipt)}\n`;
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const existing = await readFile(target, "utf8");
      const existingReceipt = parseRepositoryCacheEvidenceReceipt(existing);
      const comparable = (value: RepositoryCacheEvidenceReceiptV1) => ({
        candidateCapabilitySha256: value.candidateCapabilitySha256,
        cases: value.cases,
        checkoutFingerprintSha256: value.checkoutFingerprintSha256,
        evidenceId: value.evidenceId,
        manifestSha256: value.manifestSha256,
        nodeVersion: value.nodeVersion,
        platform: value.platform,
        receiptId: value.receiptId,
        reportSha256: value.reportSha256,
        schemaVersion: value.schemaVersion,
        status: value.status,
      });
      if (!exactJson(comparable(existingReceipt), comparable(receipt))) {
        fail("repository_cache_receipt_exists", "existing no-replace receipt belongs to different evidence", error);
      }
      return Object.freeze({ path: target, receipt: existingReceipt });
    }
    throw error;
  }
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({ path: target, receipt });
}

export async function readRepositoryCacheEvidenceManifest(path: string): Promise<{
  readonly manifest: RepositoryCacheEvidenceManifestV1;
  readonly source: string;
}> {
  const source = await readFile(path, "utf8");
  return Object.freeze({ manifest: parseRepositoryCacheEvidenceManifest(source), source });
}

export function repositoryCacheReportDirectory(reportPath: string): string {
  return dirname(resolve(reportPath));
}
