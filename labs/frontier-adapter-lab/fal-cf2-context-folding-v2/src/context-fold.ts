import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  canonicalJson,
  sha256Canonical,
} from "../../../../src/completion/canonical-json.js";
import { DeterministicTokenEstimator } from "../../../../src/context/token-estimator.js";
import type { AcceptedChildReceiptContextItemV1 } from
  "../../../../src/delegation/receipts/parent-receipt-projector.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedString = z.string().max(64 * 1024);
const boundedRef = z.string().min(1).max(4 * 1024);
const boundedId = z.string().min(1).max(256);

const acceptedClaimSchema = z.object({
  claimId: boundedId,
  kind: boundedId,
  narrative: boundedString,
  evidenceRefs: z.array(boundedRef).max(64),
}).strict();

export const acceptedChildReceiptContextItemSchema = z.object({
  kind: z.literal("accepted_child_receipt"),
  delegationId: boundedId,
  childAttemptId: boundedId,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  objective: boundedString,
  verifiedClaims: z.array(acceptedClaimSchema).max(64),
  changeBundleRef: boundedRef.nullable(),
  verificationGenerationIds: z.array(boundedId).max(64),
  receiptSha256: sha256,
}).strict();

export const acceptedChildReceiptContextSchema = z
  .array(acceptedChildReceiptContextItemSchema)
  .max(32)
  .superRefine((value, context) => {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > 64 * 1024) {
      context.addIssue({
        code: "custom",
        message: "accepted child receipt context exceeds 64 KiB",
      });
    }
  });

const foldEvidenceSchema = z.object({
  evidenceKey: sha256,
  artifactRef: boundedRef,
}).strict();

const foldClaimSchema = z.object({
  claimKey: sha256,
  kind: boundedId,
  narrative: boundedString,
  evidenceKeys: z.array(sha256).max(64),
}).strict();

const foldSourceSchema = z.object({
  sourceOrdinal: z.number().int().nonnegative().max(31),
  delegationId: boundedId,
  childAttemptId: boundedId,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  objective: boundedString,
  claims: z.array(z.object({
    claimId: boundedId,
    claimKey: sha256,
  }).strict()).max(64),
  changeBundleRef: boundedRef.nullable(),
  verificationGenerationIds: z.array(boundedId).max(64),
  receiptSha256: sha256,
}).strict();

const foldContentSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("accepted_child_receipt_fold"),
  sources: z.array(foldSourceSchema).max(32),
  claims: z.array(foldClaimSchema).max(2_048),
  evidence: z.array(foldEvidenceSchema).max(4_096),
  sourceSetSha256: sha256,
}).strict();

export const acceptedChildReceiptFoldSchema = foldContentSchema.extend({
  foldSha256: sha256,
}).strict().superRefine((value, context) => {
  const claimKeys = new Set<string>();
  const evidenceKeys = new Set<string>();

  value.evidence.forEach((entry, index) => {
    const expected = evidenceKey(entry.artifactRef);
    if (entry.evidenceKey !== expected) {
      context.addIssue({
        code: "custom",
        message: "evidence key does not match artifact ref",
        path: ["evidence", index, "evidenceKey"],
      });
    }
    if (evidenceKeys.has(entry.evidenceKey)) {
      context.addIssue({
        code: "custom",
        message: "evidence dictionary keys must be unique",
        path: ["evidence", index, "evidenceKey"],
      });
    }
    evidenceKeys.add(entry.evidenceKey);
  });

  value.claims.forEach((entry, index) => {
    const refs = entry.evidenceKeys.map((key) =>
      value.evidence.find((candidate) => candidate.evidenceKey === key)?.artifactRef);
    if (refs.some((entryRef) => entryRef === undefined)) {
      context.addIssue({
        code: "custom",
        message: "claim references an unknown evidence key",
        path: ["claims", index, "evidenceKeys"],
      });
      return;
    }
    const expected = claimKey({
      kind: entry.kind,
      narrative: entry.narrative,
      evidenceRefs: refs as string[],
    });
    if (entry.claimKey !== expected) {
      context.addIssue({
        code: "custom",
        message: "claim key does not match claim payload",
        path: ["claims", index, "claimKey"],
      });
    }
    if (claimKeys.has(entry.claimKey)) {
      context.addIssue({
        code: "custom",
        message: "claim dictionary keys must be unique",
        path: ["claims", index, "claimKey"],
      });
    }
    claimKeys.add(entry.claimKey);
  });

  value.sources.forEach((source, index) => {
    if (source.sourceOrdinal !== index) {
      context.addIssue({
        code: "custom",
        message: "source ordinals must be contiguous and ordered",
        path: ["sources", index, "sourceOrdinal"],
      });
    }
    source.claims.forEach((entry, claimIndex) => {
      if (!claimKeys.has(entry.claimKey)) {
        context.addIssue({
          code: "custom",
          message: "source references an unknown claim key",
          path: ["sources", index, "claims", claimIndex, "claimKey"],
        });
      }
    });
  });

  const expectedSourceSet = sha256Canonical(
    value.sources.map((source) => source.receiptSha256),
  );
  if (value.sourceSetSha256 !== expectedSourceSet) {
    context.addIssue({
      code: "custom",
      message: "source set hash does not match ordered receipt hashes",
      path: ["sourceSetSha256"],
    });
  }

  const { foldSha256, ...content } = value;
  if (foldSha256 !== sha256Canonical(content)) {
    context.addIssue({
      code: "custom",
      message: "fold hash does not match canonical fold content",
      path: ["foldSha256"],
    });
  }
});

export type AcceptedChildReceiptContextItem = AcceptedChildReceiptContextItemV1;
export type AcceptedChildReceiptFoldV2 = Readonly<
  z.infer<typeof acceptedChildReceiptFoldSchema>
>;

export const cf2ContextFoldingEstimator = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "provider-neutral",
  provider: "bornagent",
  tokenizer: "utf8-bytes-v1",
  version: "fal-cf2-v2",
});

export type ContextFoldFaultMode = "none" | "throw" | "deadline_expired" | "invalid";

type FoldClaim = Readonly<{
  claimKey: string;
  kind: string;
  narrative: string;
  evidenceKeys: readonly string[];
}>;

type FoldEvidence = Readonly<{
  evidenceKey: string;
  artifactRef: string;
}>;

export interface ContextFoldSelection {
  readonly candidateBytes: number | null;
  readonly candidateTokens: number | null;
  readonly diagnosticCode: string | null;
  readonly fold: AcceptedChildReceiptFoldV2 | null;
  readonly losslessExpansion: boolean;
  readonly mode: "baseline" | "fold";
  readonly modelCalls: 0;
  readonly networkCalls: 0;
  readonly providerContext: string;
  readonly reason:
    | "disabled"
    | "selected"
    | "not_beneficial"
    | "over_bound"
    | "deadline_expired"
    | "candidate_fault"
    | "invalid_input";
  readonly selected: boolean;
  readonly toolCalls: 0;
}

function evidenceKey(artifactRef: string): string {
  return sha256Canonical({ artifactRef });
}

function claimKey(input: {
  readonly kind: string;
  readonly narrative: string;
  readonly evidenceRefs: readonly string[];
}): string {
  return sha256Canonical({
    kind: input.kind,
    narrative: input.narrative,
    evidenceRefs: input.evidenceRefs,
  });
}

function freezeReceipt(
  input: AcceptedChildReceiptContextItem,
): AcceptedChildReceiptContextItem {
  return Object.freeze({
    ...input,
    verifiedClaims: Object.freeze(input.verifiedClaims.map((claim) => Object.freeze({
      ...claim,
      evidenceRefs: Object.freeze([...claim.evidenceRefs]),
    }))),
    verificationGenerationIds: Object.freeze([...input.verificationGenerationIds]),
  });
}

export function foldAcceptedChildReceipts(
  input: unknown,
): AcceptedChildReceiptFoldV2 {
  const receipts = acceptedChildReceiptContextSchema.parse(input);
  const claims = new Map<string, FoldClaim>();
  const evidence = new Map<string, FoldEvidence>();

  const sources = receipts.map((receipt, sourceOrdinal) => {
    const sourceClaims = receipt.verifiedClaims.map((claim) => {
      const key = claimKey(claim);
      if (!claims.has(key)) {
        const evidenceKeys = claim.evidenceRefs.map((artifactRef) => {
          const keyForEvidence = evidenceKey(artifactRef);
          if (!evidence.has(keyForEvidence)) {
            evidence.set(keyForEvidence, Object.freeze({
              evidenceKey: keyForEvidence,
              artifactRef,
            }));
          }
          return keyForEvidence;
        });
        claims.set(key, Object.freeze({
          claimKey: key,
          kind: claim.kind,
          narrative: claim.narrative,
          evidenceKeys: Object.freeze(evidenceKeys),
        }));
      }
      return Object.freeze({ claimId: claim.claimId, claimKey: key });
    });
    return Object.freeze({
      sourceOrdinal,
      delegationId: receipt.delegationId,
      childAttemptId: receipt.childAttemptId,
      status: receipt.status,
      objective: receipt.objective,
      claims: Object.freeze(sourceClaims),
      changeBundleRef: receipt.changeBundleRef,
      verificationGenerationIds: Object.freeze([...receipt.verificationGenerationIds]),
      receiptSha256: receipt.receiptSha256,
    });
  });

  const content = foldContentSchema.parse({
    schemaVersion: 2,
    kind: "accepted_child_receipt_fold",
    sources,
    claims: [...claims.values()],
    evidence: [...evidence.values()],
    sourceSetSha256: sha256Canonical(receipts.map((receipt) => receipt.receiptSha256)),
  });
  return Object.freeze(acceptedChildReceiptFoldSchema.parse({
    ...content,
    foldSha256: sha256Canonical(content),
  }));
}

export function expandAcceptedChildReceiptFold(
  input: unknown,
): readonly AcceptedChildReceiptContextItem[] {
  const fold = acceptedChildReceiptFoldSchema.parse(input);
  const claims = new Map(fold.claims.map((entry) => [entry.claimKey, entry]));
  const evidence = new Map(fold.evidence.map((entry) => [entry.evidenceKey, entry]));
  return Object.freeze(fold.sources.map((source) => freezeReceipt({
    kind: "accepted_child_receipt",
    delegationId: source.delegationId,
    childAttemptId: source.childAttemptId,
    status: source.status,
    objective: source.objective,
    verifiedClaims: source.claims.map((sourceClaim) => {
      const claim = claims.get(sourceClaim.claimKey);
      if (claim === undefined) throw new Error("context_fold_invalid: missing claim dictionary entry");
      return Object.freeze({
        claimId: sourceClaim.claimId,
        kind: claim.kind,
        narrative: claim.narrative,
        evidenceRefs: Object.freeze(claim.evidenceKeys.map((key) => {
          const entry = evidence.get(key);
          if (entry === undefined) {
            throw new Error("context_fold_invalid: missing evidence dictionary entry");
          }
          return entry.artifactRef;
        })),
      });
    }),
    changeBundleRef: source.changeBundleRef,
    verificationGenerationIds: source.verificationGenerationIds,
    receiptSha256: source.receiptSha256,
  })));
}

function baselineSelection(
  providerContext: string,
  reason: ContextFoldSelection["reason"],
  diagnosticCode: string | null,
  candidate: {
    readonly bytes: number | null;
    readonly fold: AcceptedChildReceiptFoldV2 | null;
    readonly lossless: boolean;
    readonly tokens: number | null;
  } = { bytes: null, fold: null, lossless: false, tokens: null },
): ContextFoldSelection {
  return Object.freeze({
    candidateBytes: candidate.bytes,
    candidateTokens: candidate.tokens,
    diagnosticCode,
    fold: candidate.fold,
    losslessExpansion: candidate.lossless,
    mode: "baseline",
    modelCalls: 0,
    networkCalls: 0,
    providerContext,
    reason,
    selected: false,
    toolCalls: 0,
  });
}

export function selectAcceptedChildReceiptContext(input: {
  readonly acceptedChildReceipts: unknown;
  readonly baselineProviderContext: string;
  readonly baselineTaskContext: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly faultMode?: ContextFoldFaultMode;
}): ContextFoldSelection {
  if (!input.enabled) return baselineSelection(input.baselineProviderContext, "disabled", null);
  if (input.faultMode === "deadline_expired") {
    return baselineSelection(
      input.baselineProviderContext,
      "deadline_expired",
      "context_fold_deadline_expired_before_invocation",
    );
  }
  try {
    const receipts = acceptedChildReceiptContextSchema.parse(input.acceptedChildReceipts);
    if (
      canonicalJson(input.baselineTaskContext.acceptedChildReceipts ?? []) !==
      canonicalJson(receipts)
    ) {
      return baselineSelection(
        input.baselineProviderContext,
        "invalid_input",
        "context_fold_input_mismatch",
      );
    }
    const fold = foldAcceptedChildReceipts(receipts);
    const faultMode = input.faultMode ?? "none";
    if (faultMode === "throw") throw new Error("context_fold_injected_throw");
    const foldForExpansion = faultMode === "invalid"
      ? { ...fold, foldSha256: "0".repeat(64) }
      : fold;
    const expanded = expandAcceptedChildReceiptFold(foldForExpansion);
    const lossless = canonicalJson(expanded) === canonicalJson(receipts);
    if (!lossless) throw new Error("context_fold_invalid: expansion mismatch");

    const { acceptedChildReceipts: _baselineReceipts, ...contextWithoutReceipts } =
      input.baselineTaskContext;
    void _baselineReceipts;
    const candidateTaskContext = Object.freeze({
      ...contextWithoutReceipts,
      acceptedChildReceiptFold: fold,
    });
    const candidateProviderContext =
      `BORNAGENT_TASK_CONTEXT_V1\n${canonicalJson(candidateTaskContext)}`;
    const candidateBytes = Buffer.byteLength(candidateProviderContext, "utf8");
    const candidateTokens = cf2ContextFoldingEstimator
      .estimateText(candidateProviderContext).estimatedTokens;
    const baselineTokens = cf2ContextFoldingEstimator
      .estimateText(input.baselineProviderContext).estimatedTokens;
    const candidateObservation = {
      bytes: candidateBytes,
      fold,
      lossless,
      tokens: candidateTokens,
    } as const;
    if (candidateBytes > 64 * 1024) {
      return baselineSelection(
        input.baselineProviderContext,
        "over_bound",
        "context_fold_over_bound",
        candidateObservation,
      );
    }
    if (
      candidateTokens > Math.floor(baselineTokens * 0.75) ||
      candidateBytes > Buffer.byteLength(input.baselineProviderContext, "utf8")
    ) {
      return baselineSelection(
        input.baselineProviderContext,
        "not_beneficial",
        null,
        candidateObservation,
      );
    }
    return Object.freeze({
      candidateBytes,
      candidateTokens,
      diagnosticCode: null,
      fold,
      losslessExpansion: true,
      mode: "fold",
      modelCalls: 0,
      networkCalls: 0,
      providerContext: candidateProviderContext,
      reason: "selected",
      selected: true,
      toolCalls: 0,
    });
  } catch (error) {
    return baselineSelection(
      input.baselineProviderContext,
      "candidate_fault",
      error instanceof Error ? error.message : "context_fold_unknown_fault",
    );
  }
}
