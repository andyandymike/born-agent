import { createHash } from "node:crypto";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { TokenEstimator } from "./token-estimator.js";

export type ContextItemKind =
  | "approval_history"
  | "archived_tool_observation"
  | "assistant_message"
  | "completion_candidate"
  | "completion_decision"
  | "historical_memory"
  | "mutation_fact"
  | "repository_rules"
  | "state_fact"
  | "skill_arguments"
  | "skill_entry"
  | "skill_resource"
  | "mcp_prompt"
  | "mcp_resource"
  | "system_instruction"
  | "tool_call"
  | "tool_observation"
  | "user_message";

export type ContextItemPriority = "critical" | "high" | "normal" | "low";
export type ContextItemRole = "assistant" | "system" | "tool" | "user";
export type ContextItemVisibility =
  | "internal_candidate"
  | "provider_context"
  | "user_visible";

export type ContextAuthority =
  | "authoritative"
  | "historical_only"
  | "narrative"
  | "untrusted_content";

export type ProtectedFactCategory =
  | "approval_history"
  | "backend_budget_epoch"
  | "change_journal"
  | "dirty_baseline"
  | "pending_effects"
  | "repository_rules"
  | "repository_state"
  | "system_policy"
  | "unresolved_errors"
  | "user_instruction"
  | "verification_state";

export type ContextPairingKind = "completion" | "mutation" | "tool";

export interface ContextPairing {
  readonly id: string;
  readonly kind: ContextPairingKind;
  readonly role: string;
}

export interface ContextArtifactReference {
  readonly artifactId: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly relativeRef: string;
  readonly sha256: string;
}

export type ContextJson =
  | boolean
  | null
  | number
  | string
  | readonly ContextJson[]
  | { readonly [key: string]: ContextJson };

export interface ContextItem {
  readonly artifactRefs: readonly ContextArtifactReference[];
  readonly authority: ContextAuthority;
  readonly content: string;
  readonly contentSha256: string;
  readonly estimatedTokens: number;
  readonly estimatorId: string;
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly metadata: ContextJson;
  readonly pairing: ContextPairing | null;
  readonly priority: ContextItemPriority;
  readonly protectedCategory: ProtectedFactCategory | null;
  readonly recency: number;
  readonly role: ContextItemRole;
  readonly sourceEventIds: readonly string[];
  readonly turnId: string | null;
  readonly visibility: ContextItemVisibility;
}

export interface ContextItemInput {
  readonly artifactRefs?: readonly ContextArtifactReference[];
  readonly authority: ContextAuthority;
  readonly content: string;
  readonly kind: ContextItemKind;
  readonly metadata?: ContextJson;
  readonly pairing?: ContextPairing | null;
  readonly priority: ContextItemPriority;
  readonly protectedCategory?: ProtectedFactCategory | null;
  readonly recency: number;
  readonly role: ContextItemRole;
  readonly sourceEventIds: readonly string[];
  readonly turnId?: string | null;
  readonly visibility: ContextItemVisibility;
}

const SHA256 = /^[0-9a-f]{64}$/u;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneJson(value: ContextJson): ContextJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("context metadata cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneJson(entry)));
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return Object.freeze(
    Object.fromEntries(entries.map(([key, entry]) => [key, cloneJson(entry)])),
  );
}

function normalizeArtifactRef(
  reference: ContextArtifactReference,
): ContextArtifactReference {
  if (
    reference.artifactId !== `sha256:${reference.sha256}` ||
    !SHA256.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.mediaType.length === 0 ||
    reference.relativeRef.length === 0
  ) {
    throw new TypeError("context artifact reference is invalid");
  }
  return Object.freeze({ ...reference });
}

export function contextPriorityRank(priority: ContextItemPriority): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
  }
}

export function contextItemCanonicalValue(item: ContextItem): ContextJson {
  return {
    artifact_refs: item.artifactRefs.map((reference) => ({
      artifact_id: reference.artifactId,
      bytes: reference.bytes,
      media_type: reference.mediaType,
      relative_ref: reference.relativeRef,
      sha256: reference.sha256,
    })),
    authority: item.authority,
    content: item.content,
    content_sha256: item.contentSha256,
    id: item.id,
    kind: item.kind,
    metadata: item.metadata,
    pairing:
      item.pairing === null
        ? null
        : {
            id: item.pairing.id,
            kind: item.pairing.kind,
            role: item.pairing.role,
          },
    role: item.role,
    source_event_ids: item.sourceEventIds,
    turn_id: item.turnId,
    visibility: item.visibility,
  };
}

export function createContextItem(
  input: ContextItemInput,
  estimator: TokenEstimator,
): ContextItem {
  if (
    input.content.includes("\0") ||
    !Number.isSafeInteger(input.recency) ||
    input.recency < 0 ||
    input.sourceEventIds.length === 0 ||
    input.sourceEventIds.some((id) => id.length === 0)
  ) {
    throw new TypeError("context item input is invalid");
  }
  const sourceEventIds = Object.freeze(
    [...new Set(input.sourceEventIds)].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  const artifactRefs = Object.freeze(
    (input.artifactRefs ?? [])
      .map(normalizeArtifactRef)
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  );
  const metadata = cloneJson(input.metadata ?? null);
  const pairing =
    input.pairing === undefined || input.pairing === null
      ? null
      : Object.freeze({ ...input.pairing });
  if (pairing !== null && (pairing.id.length === 0 || pairing.role.length === 0)) {
    throw new TypeError("context item pairing identity is invalid");
  }
  const semantic = {
    artifact_refs: artifactRefs,
    authority: input.authority,
    content: input.content,
    content_sha256: sha256Text(input.content),
    kind: input.kind,
    metadata,
    pairing,
    role: input.role,
    source_event_ids: sourceEventIds,
    turn_id: input.turnId ?? null,
    visibility: input.visibility,
  };
  const id = `ctx:${sha256Canonical({ schema_version: 1, ...semantic })}`;
  const estimate = estimator.estimateText(canonicalJson({ id, ...semantic }));
  return Object.freeze({
    artifactRefs,
    authority: input.authority,
    content: input.content,
    contentSha256: semantic.content_sha256,
    estimatedTokens: estimate.estimatedTokens,
    estimatorId: estimator.estimatorId,
    id,
    kind: input.kind,
    metadata,
    pairing,
    priority: input.priority,
    protectedCategory: input.protectedCategory ?? null,
    recency: input.recency,
    role: input.role,
    sourceEventIds,
    turnId: input.turnId ?? null,
    visibility: input.visibility,
  });
}
