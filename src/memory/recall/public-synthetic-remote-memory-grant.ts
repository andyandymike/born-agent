import { createHash } from "node:crypto";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { ContextItem } from "../../context/context-item.js";
import type { ProviderId } from "../../model/model-backend.js";
import type { Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import type { Ml3PreparedRecallContextV1 } from "./ml3-recall-contract.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const recordIdSchema = z.string().regex(/^(?:episode|memory)_[a-f0-9]{64}$/u);

const allowedRecordSchema = z.object({
  disclosureClass: z.literal("public_synthetic"),
  excerptContentSha256: sha256Schema,
  recordId: recordIdSchema,
  recordSha256: sha256Schema,
  sourceReferenceSha256: sha256Schema,
}).strict();

const grantWithoutHashSchema = z.object({
  allowedRecords: z.tuple([allowedRecordSchema]),
  authorizationRefSha256: sha256Schema,
  canonicalRootIdentitySha256: sha256Schema,
  maximumSelectedRecords: z.literal(1),
  model: z.string().min(1).max(256),
  ownerPrincipalId: z.string().min(1).max(512),
  policyProfileId: z.string().min(1).max(128),
  provider: z.enum(["anthropic", "deepseek", "ollama", "openai"]),
  purpose: z.literal("fal_mem_e0_public_synthetic_effect_eval"),
  repositoryId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(512),
  taskSha256: sha256Schema,
  transportScope: z.literal("provider_network"),
}).strict();

const grantSchema = grantWithoutHashSchema.extend({
  grantSha256: sha256Schema,
}).strict();

type GrantWithoutHash = z.infer<typeof grantWithoutHashSchema>;

export type PublicSyntheticRemoteMemoryGrantV1 = Readonly<
  z.infer<typeof grantSchema>
>;

export interface PublicSyntheticRemoteMemoryGrantRequestV1 {
  readonly canonicalRootIdentitySha256: string;
  readonly model: string | undefined;
  readonly ownerPrincipalId: string;
  readonly policyProfileId: string | undefined;
  readonly provider: string | undefined;
  readonly repositoryId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly task: string;
}

export class PublicSyntheticRemoteMemoryGrantError extends Error {
  public readonly code = "memory_remote_disclosure_denied" as const;
  public readonly exitCode = 2 as const;

  public constructor(message: string) {
    super(message);
    this.name = "PublicSyntheticRemoteMemoryGrantError";
  }
}

function canonicalGrantValue(input: GrantWithoutHash) {
  return {
    allowed_records: input.allowedRecords.map((record) => ({
      disclosure_class: record.disclosureClass,
      excerpt_content_sha256: record.excerptContentSha256,
      record_id: record.recordId,
      record_sha256: record.recordSha256,
      source_reference_sha256: record.sourceReferenceSha256,
    })),
    authorization_ref_sha256: input.authorizationRefSha256,
    canonical_root_identity_sha256: input.canonicalRootIdentitySha256,
    maximum_selected_records: input.maximumSelectedRecords,
    model: input.model,
    owner_principal_id: input.ownerPrincipalId,
    policy_profile_id: input.policyProfileId,
    provider: input.provider,
    purpose: input.purpose,
    repository_id: input.repositoryId,
    run_id: input.runId,
    schema_version: input.schemaVersion,
    session_id: input.sessionId,
    task_sha256: input.taskSha256,
    transport_scope: input.transportScope,
  } as const;
}

export function publicSyntheticRemoteMemoryTaskSha256(task: string): string {
  return sha256Canonical({ schema_version: 1, task });
}

export function publicSyntheticRemoteMemoryExcerptSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createPublicSyntheticRemoteMemoryGrantV1(
  input: GrantWithoutHash,
): PublicSyntheticRemoteMemoryGrantV1 {
  const parsed = grantWithoutHashSchema.parse(input);
  return Object.freeze(grantSchema.parse({
    ...parsed,
    allowedRecords: Object.freeze(parsed.allowedRecords.map((record) => Object.freeze({ ...record }))) as
      unknown as GrantWithoutHash["allowedRecords"],
    grantSha256: sha256Canonical(canonicalGrantValue(parsed)),
  }));
}

export function verifyPublicSyntheticRemoteMemoryGrantV1(
  value: unknown,
): PublicSyntheticRemoteMemoryGrantV1 {
  const parsed = grantSchema.parse(value);
  const { grantSha256, ...withoutHash } = parsed;
  const canonical = grantWithoutHashSchema.parse(withoutHash);
  if (sha256Canonical(canonicalGrantValue(canonical)) !== grantSha256) {
    throw new PublicSyntheticRemoteMemoryGrantError(
      "public synthetic remote memory grant hash does not match",
    );
  }
  return Object.freeze({
    ...parsed,
    allowedRecords: Object.freeze(parsed.allowedRecords.map((record) => Object.freeze({ ...record }))) as
      unknown as PublicSyntheticRemoteMemoryGrantV1["allowedRecords"],
  });
}

export function assertPublicSyntheticRemoteMemoryGrantIdentity(input: Readonly<{
  readonly grant: PublicSyntheticRemoteMemoryGrantV1;
  readonly model: string;
  readonly policyProfileId: string;
  readonly provider: ProviderId;
  readonly runId: string;
  readonly scope: Ml1MemoryScopeV1;
  readonly sessionId: string;
  readonly task: string;
}>): PublicSyntheticRemoteMemoryGrantV1 {
  const grant = verifyPublicSyntheticRemoteMemoryGrantV1(input.grant);
  if (
    grant.provider !== input.provider ||
    grant.model !== input.model ||
    grant.policyProfileId !== input.policyProfileId ||
    grant.repositoryId !== input.scope.applicationRepositoryId ||
    grant.canonicalRootIdentitySha256 !== input.scope.canonicalRootIdentitySha256 ||
    grant.ownerPrincipalId !== input.scope.ownerPrincipalId ||
    grant.sessionId !== input.sessionId ||
    grant.runId !== input.runId ||
    grant.taskSha256 !== publicSyntheticRemoteMemoryTaskSha256(input.task)
  ) {
    throw new PublicSyntheticRemoteMemoryGrantError(
      "public synthetic remote memory grant identity does not match this run",
    );
  }
  return grant;
}

function metadata(item: ContextItem): Readonly<Record<string, unknown>> {
  return item.metadata !== null &&
      typeof item.metadata === "object" &&
      !Array.isArray(item.metadata)
    ? item.metadata as Readonly<Record<string, unknown>>
    : {};
}

export function assertPublicSyntheticRemoteMemoryGrantAllowsPreparedRecall(input: Readonly<{
  readonly grant: PublicSyntheticRemoteMemoryGrantV1;
  readonly prepared: Ml3PreparedRecallContextV1;
}>): void {
  const grant = verifyPublicSyntheticRemoteMemoryGrantV1(input.grant);
  if (
    input.prepared.selection.status !== "selected" ||
    input.prepared.selection.selectedRecords.length !== grant.maximumSelectedRecords ||
    input.prepared.items.length !== grant.maximumSelectedRecords
  ) {
    throw new PublicSyntheticRemoteMemoryGrantError(
      "public synthetic remote recall did not select the exact authorized record count",
    );
  }
  const selected = input.prepared.selection.selectedRecords[0]!;
  const item = input.prepared.items[0]!;
  const allowed = grant.allowedRecords[0];
  const itemMetadata = metadata(item);
  if (
    selected.recordId !== allowed.recordId ||
    selected.recordSha256 !== allowed.recordSha256 ||
    selected.sourceReferenceSha256 !== allowed.sourceReferenceSha256 ||
    itemMetadata.record_id !== allowed.recordId ||
    itemMetadata.record_sha256 !== allowed.recordSha256 ||
    itemMetadata.source_reference_sha256 !== allowed.sourceReferenceSha256 ||
    item.authority !== "historical_only" ||
    item.priority !== "low" ||
    item.protectedCategory !== null ||
    item.visibility !== "provider_context" ||
    publicSyntheticRemoteMemoryExcerptSha256(item.content) !== allowed.excerptContentSha256
  ) {
    throw new PublicSyntheticRemoteMemoryGrantError(
      "public synthetic remote recall bytes do not match the exact disclosure grant",
    );
  }
}
