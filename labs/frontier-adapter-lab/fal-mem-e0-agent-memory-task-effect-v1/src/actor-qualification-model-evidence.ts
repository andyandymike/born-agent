import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { RemoteLiveQualifiedModelEvidence } from "../../../../src/completion/completion-types.js";
import {
  modelQualificationRecordSchema,
  type ModelQualificationRecordV1,
} from "../../../../src/model/model-qualification-schema.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  developmentPilotQualificationDescriptorSchema,
  loadDevelopmentPilotFixture,
  loadHistoricalDs0ModelQualificationForActorPreflight,
} from "../../fal-vp0-verified-procedure-utilization-v1/src/development-pilot-fixture.js";
import {
  loadMemE0ActorQualificationFixture,
  parseMemE0ActorQualificationConfig,
  type MemE0ActorQualificationConfig,
  type MemE0LoadedActorQualificationFixture,
} from "./actor-qualification-fixture.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

// Frozen historical DS0 actor prompt, also retained by the fd34750 qualification
// config. This is NOT the current actor prompt and does not qualify that actor.
// All DS0 observation/record/configuration/usage/identity checks remain required.
export const MEM_E0_REUSED_DS0_CODING_SYSTEM_INSTRUCTION_SHA256 =
  "65be1cd030cb0e447ff634080d652e89ceb0978619eabff70cca38c12ceca04a";

const developmentQualificationEvidenceSchema = z.object({
  descriptor: developmentPilotQualificationDescriptorSchema,
  ds0ActorReportSha256: sha256Schema.nullable(),
  ds0EntryEvidenceClass: z.enum([
    "ds0_product_completion_passed",
    "functional_entry_only",
  ]),
  ds0ObservationSha256: sha256Schema,
  ds0PricingSha256: sha256Schema,
  ds0ProtocolSha256: sha256Schema,
  ds0QualificationRecordSha256: sha256Schema,
}).strict();

type DevelopmentQualificationEvidence = Readonly<
  z.infer<typeof developmentQualificationEvidenceSchema>
>;

export interface MemE0ActorQualificationModelEvidenceInput {
  readonly actorConfig: MemE0ActorQualificationConfig;
  readonly developmentEvidence: DevelopmentQualificationEvidence;
  readonly record: unknown;
}

/**
 * Receipt-safe binding for a previously paid DS0 model qualification.
 *
 * This deliberately retains no parsed record, observation, provider payload,
 * raw output, or absolute filesystem path. The relative evidence reference is
 * the one field required by the product RemoteLiveQualifiedModelEvidence
 * contract.
 */
export interface MemE0ActorQualificationModelEvidence {
  readonly descriptor: RemoteLiveQualifiedModelEvidence;
  readonly modelQualificationEvidenceSha256: string;
  readonly modelQualificationIdentitySha256: string;
  readonly modelQualificationObservationSha256: string;
  readonly modelQualificationPricingSha256: string;
  readonly modelQualificationProtocolSha256: string;
  readonly modelQualificationRecordSha256: string;
}

export interface LoadMemE0ActorQualificationModelEvidenceInput {
  readonly actorFixture?: MemE0LoadedActorQualificationFixture | undefined;
  readonly ds0ObservationPath: string;
  readonly repositoryRoot: string;
}

function frozenRemoteDescriptor(
  evidence: DevelopmentQualificationEvidence,
): RemoteLiveQualifiedModelEvidence {
  const descriptor = evidence.descriptor;
  return Object.freeze({
    backend: "deepseek",
    baseUrl: descriptor.baseUrl,
    endpointScope: "remote_https",
    kind: "remote_live_qualified",
    model: descriptor.model,
    provider: descriptor.provider,
    qualificationCompletedRequestCount:
      descriptor.qualificationCompletedRequestCount,
    qualificationEvidenceKind: descriptor.qualificationEvidenceKind,
    qualificationEvidenceRef: descriptor.qualificationEvidenceRef,
    qualificationEvidenceSha256: descriptor.qualificationEvidenceSha256,
    qualificationRequestCount: descriptor.qualificationRequestCount,
    qualificationStatus: descriptor.qualificationStatus,
    qualificationUsageCapability: descriptor.qualificationUsageCapability,
    remoteBillableRequests: descriptor.qualificationRequestCount,
    remoteQualificationRequests: descriptor.qualificationRequestCount,
    requestCountScope: "qualification_only",
  });
}

function assertRecordMeetsMemE0Contract(
  record: ModelQualificationRecordV1,
  evidence: DevelopmentQualificationEvidence,
  config: MemE0ActorQualificationConfig,
): void {
  const contract = config.genericModelQualification;
  const expectedIdentitySha256 = sha256Canonical(contract.expectedIdentity);
  const recordIdentitySha256 = sha256Canonical(record.identity);
  const recordSha256 = sha256Canonical(record);
  const usageResult = record.probeResults.find(
    (result) => result.probeId === contract.usageRequirement.probeId,
  );
  const descriptor = evidence.descriptor;

  if (
    recordIdentitySha256 !== expectedIdentitySha256 ||
    record.identitySha256 !== expectedIdentitySha256
  ) {
    throw new Error(
      "DS0 model qualification identity does not match the frozen MEM-E0 actor",
    );
  }
  if (
    !contract.requiredQualifiedModes.every((mode) =>
      record.qualifiedModes.includes(mode)
    )
  ) {
    throw new Error("DS0 model qualification does not include build mode");
  }
  if (
    usageResult?.status !== contract.usageRequirement.status ||
    usageResult.observed.availability !==
      contract.usageRequirement.availability ||
    descriptor.qualificationUsageCapability !== "complete"
  ) {
    throw new Error("DS0 model qualification usage evidence is incomplete");
  }
  if (
    record.totalRequestCount < contract.minimumRecordRequestCount ||
    record.totalRequestCount > contract.maximumRecordRequestCount ||
    descriptor.qualificationRequestCount !== record.totalRequestCount ||
    descriptor.qualificationCompletedRequestCount !== record.totalRequestCount
  ) {
    throw new Error("DS0 model qualification request count violates the frozen caps");
  }
  if (
    descriptor.provider !== config.provider.provider ||
    descriptor.model !== config.provider.model ||
    descriptor.baseUrl !== config.provider.endpoint ||
    descriptor.qualificationEvidenceKind !== contract.evidenceKind ||
    descriptor.qualificationEvidenceSha256 !== record.evidenceSha256 ||
    evidence.ds0QualificationRecordSha256 !== recordSha256
  ) {
    throw new Error("DS0 model qualification descriptor or record binding drifted");
  }
}

export function validateMemE0ActorQualificationModelEvidence(
  input: MemE0ActorQualificationModelEvidenceInput,
): MemE0ActorQualificationModelEvidence {
  const actorConfig = parseMemE0ActorQualificationConfig(input.actorConfig);
  const evidence = developmentQualificationEvidenceSchema.parse(
    input.developmentEvidence,
  );
  const record = modelQualificationRecordSchema.parse(input.record);
  assertRecordMeetsMemE0Contract(record, evidence, actorConfig);

  return Object.freeze({
    descriptor: frozenRemoteDescriptor(evidence),
    modelQualificationEvidenceSha256: record.evidenceSha256,
    modelQualificationIdentitySha256: record.identitySha256,
    modelQualificationObservationSha256: evidence.ds0ObservationSha256,
    modelQualificationPricingSha256: evidence.ds0PricingSha256,
    modelQualificationProtocolSha256: evidence.ds0ProtocolSha256,
    modelQualificationRecordSha256:
      evidence.ds0QualificationRecordSha256,
  });
}

function resolveQualificationRecordPath(
  repositoryRoot: string,
  reference: string,
): string {
  const absoluteRoot = resolve(repositoryRoot);
  const absoluteRecord = resolve(absoluteRoot, ...reference.split("/"));
  const relativeRecord = relative(absoluteRoot, absoluteRecord);
  if (
    relativeRecord === ".." ||
    relativeRecord.startsWith(`..${sep}`) ||
    isAbsolute(relativeRecord)
  ) {
    throw new Error("DS0 qualification record reference escapes the repository");
  }
  return absoluteRecord;
}

/**
 * Loads only already-present, run-local DS0 evidence. It does not inspect the
 * environment, resolve credentials, or perform provider/network requests.
 */
export async function loadMemE0ActorQualificationModelEvidence(
  input: LoadMemE0ActorQualificationModelEvidenceInput,
): Promise<MemE0ActorQualificationModelEvidence> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const [actorFixture, developmentFixture] = await Promise.all([
    input.actorFixture === undefined
      ? loadMemE0ActorQualificationFixture(repositoryRoot)
      : Promise.resolve(input.actorFixture),
    loadDevelopmentPilotFixture(repositoryRoot),
  ]);
  const developmentEvidence =
    await loadHistoricalDs0ModelQualificationForActorPreflight(
      input.ds0ObservationPath,
      developmentFixture,
      MEM_E0_REUSED_DS0_CODING_SYSTEM_INSTRUCTION_SHA256,
    );
  const recordPath = resolveQualificationRecordPath(
    repositoryRoot,
    developmentEvidence.descriptor.qualificationEvidenceRef,
  );
  let recordInput: unknown;
  try {
    recordInput = parseStrictJson(await readFile(recordPath, "utf8"));
  } catch {
    throw new Error("DS0 qualification record is unavailable or invalid JSON");
  }

  return validateMemE0ActorQualificationModelEvidence({
    actorConfig: actorFixture.config,
    developmentEvidence,
    record: recordInput,
  });
}
