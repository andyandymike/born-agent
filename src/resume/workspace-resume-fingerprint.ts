import type { BackendIdentity } from "../model/model-backend.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { SourceStateDigest } from "../verification/source-state-digest.js";

export interface WorkspaceResumeFingerprint {
  readonly backend: BackendIdentity;
  readonly capabilitySnapshotSha256?: string;
  readonly canonicalRootIdentity: string;
  readonly checkpointCodecVersion: string | null;
  readonly completionSchemaSha256: string;
  readonly policySha256: string;
  readonly sourceState: Pick<
    SourceStateDigest,
    "gitHeadSha256" | "gitIndexSha256" | "sourceStateSha256"
  >;
  readonly systemInstructionsSha256: string;
  readonly taskProfile: "coding" | "read-only";
  readonly toolSchemaSha256: string;
}

export interface PersistedWorkspaceResumeFingerprint {
  readonly backend: {
    readonly adapter: string;
    readonly adapter_version: string;
    readonly config_fingerprint: string;
    readonly model: string;
    readonly provider: string;
  };
  readonly canonical_root_identity: string;
  readonly capability_snapshot_sha256?: string | undefined;
  readonly checkpoint_codec_version: string | null;
  readonly completion_schema_sha256: string;
  readonly policy_sha256: string;
  readonly source_state: {
    readonly git_head_sha256: string;
    readonly git_index_sha256: string;
    readonly source_state_sha256: string;
  };
  readonly system_instructions_sha256: string;
  readonly task_profile: "coding" | "read-only";
  readonly tool_schema_sha256: string;
}

export type ResumeFingerprintMismatchKind = "exact_only" | "hard";

export interface ResumeFingerprintMismatch {
  readonly field: string;
  readonly kind: ResumeFingerprintMismatchKind;
}

export function createWorkspaceResumeFingerprint(
  input: WorkspaceResumeFingerprint,
): WorkspaceResumeFingerprint {
  return Object.freeze({
    ...input,
    backend: Object.freeze({ ...input.backend }),
    sourceState: Object.freeze({ ...input.sourceState }),
  });
}

export function persistWorkspaceResumeFingerprint(
  fingerprint: WorkspaceResumeFingerprint,
): PersistedWorkspaceResumeFingerprint {
  return Object.freeze({
    backend: Object.freeze({
      adapter: fingerprint.backend.adapter,
      adapter_version: fingerprint.backend.adapterVersion,
      config_fingerprint: fingerprint.backend.configFingerprint,
      model: fingerprint.backend.model,
      provider: fingerprint.backend.provider,
    }),
    canonical_root_identity: fingerprint.canonicalRootIdentity,
    ...(fingerprint.capabilitySnapshotSha256 === undefined
      ? {}
      : { capability_snapshot_sha256: fingerprint.capabilitySnapshotSha256 }),
    checkpoint_codec_version: fingerprint.checkpointCodecVersion,
    completion_schema_sha256: fingerprint.completionSchemaSha256,
    policy_sha256: fingerprint.policySha256,
    source_state: Object.freeze({
      git_head_sha256: fingerprint.sourceState.gitHeadSha256,
      git_index_sha256: fingerprint.sourceState.gitIndexSha256,
      source_state_sha256: fingerprint.sourceState.sourceStateSha256,
    }),
    system_instructions_sha256: fingerprint.systemInstructionsSha256,
    task_profile: fingerprint.taskProfile,
    tool_schema_sha256: fingerprint.toolSchemaSha256,
  });
}

export function restoreWorkspaceResumeFingerprint(
  persisted: PersistedWorkspaceResumeFingerprint,
): WorkspaceResumeFingerprint {
  if (!(["anthropic", "deepseek", "ollama", "openai"] as const).includes(
    persisted.backend.provider as BackendIdentity["provider"],
  )) {
    throw new TypeError("persisted resume fingerprint has an unknown provider");
  }
  return createWorkspaceResumeFingerprint({
    backend: {
      adapter: persisted.backend.adapter,
      adapterVersion: persisted.backend.adapter_version,
      configFingerprint: persisted.backend.config_fingerprint,
      model: persisted.backend.model,
      provider: persisted.backend.provider as BackendIdentity["provider"],
    },
    canonicalRootIdentity: persisted.canonical_root_identity,
    ...(persisted.capability_snapshot_sha256 === undefined
      ? {}
      : { capabilitySnapshotSha256: persisted.capability_snapshot_sha256 }),
    checkpointCodecVersion: persisted.checkpoint_codec_version,
    completionSchemaSha256: persisted.completion_schema_sha256,
    policySha256: persisted.policy_sha256,
    sourceState: {
      gitHeadSha256: persisted.source_state.git_head_sha256,
      gitIndexSha256: persisted.source_state.git_index_sha256,
      sourceStateSha256: persisted.source_state.source_state_sha256,
    },
    systemInstructionsSha256: persisted.system_instructions_sha256,
    taskProfile: persisted.task_profile,
    toolSchemaSha256: persisted.tool_schema_sha256,
  });
}

export function workspaceResumeFingerprintSha256(
  fingerprint: WorkspaceResumeFingerprint,
): string {
  return sha256Canonical(persistWorkspaceResumeFingerprint(fingerprint));
}

function compareField(
  mismatches: ResumeFingerprintMismatch[],
  field: string,
  expected: unknown,
  current: unknown,
  kind: ResumeFingerprintMismatchKind,
): void {
  if (expected !== current) mismatches.push({ field, kind });
}

export function compareWorkspaceResumeFingerprints(
  expected: WorkspaceResumeFingerprint,
  current: WorkspaceResumeFingerprint,
): readonly ResumeFingerprintMismatch[] {
  const mismatches: ResumeFingerprintMismatch[] = [];
  compareField(
    mismatches,
    "canonical_root_identity",
    expected.canonicalRootIdentity,
    current.canonicalRootIdentity,
    "hard",
  );
  compareField(
    mismatches,
    "backend.provider",
    expected.backend.provider,
    current.backend.provider,
    "hard",
  );
  compareField(
    mismatches,
    "backend.model",
    expected.backend.model,
    current.backend.model,
    "hard",
  );
  compareField(
    mismatches,
    "backend.adapter",
    expected.backend.adapter,
    current.backend.adapter,
    "hard",
  );

  const exactOnlyFields = [
    ["backend.adapter_version", expected.backend.adapterVersion, current.backend.adapterVersion],
    ["backend.config_fingerprint", expected.backend.configFingerprint, current.backend.configFingerprint],
    ["checkpoint_codec_version", expected.checkpointCodecVersion, current.checkpointCodecVersion],
    ["source_state", expected.sourceState.sourceStateSha256, current.sourceState.sourceStateSha256],
    ["git_head", expected.sourceState.gitHeadSha256, current.sourceState.gitHeadSha256],
    ["git_index", expected.sourceState.gitIndexSha256, current.sourceState.gitIndexSha256],
    ["task_profile", expected.taskProfile, current.taskProfile],
    ["system_instructions", expected.systemInstructionsSha256, current.systemInstructionsSha256],
    ["policy", expected.policySha256, current.policySha256],
    ["completion_schema", expected.completionSchemaSha256, current.completionSchemaSha256],
    ["tool_schema", expected.toolSchemaSha256, current.toolSchemaSha256],
    [
      "capability_snapshot",
      expected.capabilitySnapshotSha256,
      current.capabilitySnapshotSha256,
    ],
  ] as const;
  for (const [field, expectedValue, currentValue] of exactOnlyFields) {
    compareField(
      mismatches,
      field,
      expectedValue,
      currentValue,
      "exact_only",
    );
  }
  return Object.freeze(
    mismatches.map((mismatch) => Object.freeze(mismatch)),
  );
}
