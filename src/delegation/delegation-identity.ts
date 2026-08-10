import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import {
  normalizeDelegationRevision,
  type DelegationParentBindingV1,
  type DelegationRevisionContentV1,
} from "./delegation-schema.js";

export interface DelegationRevisionIdentityV1 {
  readonly byteLength: number;
  readonly bytes: Buffer;
  readonly content: DelegationRevisionContentV1;
  readonly delegationSha256: string;
}

export function canonicalDelegationIdentity(value: unknown): DelegationRevisionIdentityV1 {
  const content = normalizeDelegationRevision(value);
  const bytes = Buffer.from(canonicalJson(content), "utf8");
  return Object.freeze({
    byteLength: bytes.byteLength,
    bytes,
    content,
    delegationSha256: sha256Canonical(content),
  });
}

export function delegationApprovalIdentity(input: {
  readonly approvalRequestId: string;
  readonly binding: DelegationParentBindingV1;
  readonly delegationId: string;
  readonly delegationRevision: number;
  readonly delegationSha256: string;
  readonly displaySha256: string;
}): string {
  return sha256Canonical({
    approval_request_id: input.approvalRequestId,
    binding: input.binding,
    delegation_id: input.delegationId,
    delegation_revision: input.delegationRevision,
    delegation_sha256: input.delegationSha256,
    display_sha256: input.displaySha256,
    kind: "delegation_revision_v1",
  });
}

export function delegationAuthorityRequestPreviewIdentity(
  content: DelegationRevisionContentV1,
): string {
  return sha256Canonical({
    authority_request: content.authorityRequest,
    budget: content.budget,
    context_maximum_bytes: content.contextRequest.maximumCapsuleBytes,
    kind: "delegation_requested_authority_preview_v1",
    model: content.model,
    retry: content.retry,
    workspace: content.workspace,
  });
}

export function delegationWorkspaceLineageIdentity(input: {
  readonly parentRunId: string;
  readonly repositoryIdentity: string;
  readonly sourceStateSha256: string | null;
  readonly workspaceFingerprint: string | null;
}): string {
  return sha256Canonical({
    kind: "delegation_parent_workspace_lineage_v1",
    parent_run_id: input.parentRunId,
    repository_identity: input.repositoryIdentity,
    source_state_sha256: input.sourceStateSha256,
    workspace_fingerprint: input.workspaceFingerprint,
  });
}
