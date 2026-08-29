import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  acceptedChildReceiptFoldSchema,
  cf2ContextFoldingEstimator,
  expandAcceptedChildReceiptFold,
  foldAcceptedChildReceipts,
  selectAcceptedChildReceiptContext,
  type AcceptedChildReceiptContextItem,
} from "../src/context-fold.js";

function receipt(input: {
  readonly index: number;
  readonly narrative: string;
  readonly evidenceRefs?: readonly string[];
  readonly status?: AcceptedChildReceiptContextItem["status"];
}): AcceptedChildReceiptContextItem {
  return Object.freeze({
    kind: "accepted_child_receipt",
    delegationId: `50000000-0000-4000-8000-${String(input.index).padStart(12, "0")}`,
    childAttemptId: `60000000-0000-4000-8000-${String(input.index).padStart(12, "0")}`,
    status: input.status ?? "succeeded",
    objective: `Preserve source ${String(input.index)}`,
    verifiedClaims: Object.freeze([Object.freeze({
      claimId: `claim-${String(input.index)}`,
      kind: "answer",
      narrative: input.narrative,
      evidenceRefs: Object.freeze([...(input.evidenceRefs ?? ["evidence/shared"])]),
    })]),
    changeBundleRef: input.index === 2 ? "bundles/change-2" : null,
    verificationGenerationIds: Object.freeze([`70000000-0000-4000-8000-${String(input.index).padStart(12, "0")}`]),
    receiptSha256: sha256Canonical({ index: input.index, schemaVersion: 2 }),
  });
}

function providerContext(receipts: readonly AcceptedChildReceiptContextItem[], extra = ""): {
  readonly baselineProviderContext: string;
  readonly baselineTaskContext: Readonly<Record<string, unknown>>;
} {
  const baselineTaskContext = Object.freeze({
    acceptedChildReceipts: receipts,
    agentMode: "build",
    goal: Object.freeze({ id: "goal", objective: "test", revision: 1 }),
    extra,
  });
  return Object.freeze({
    baselineProviderContext:
      `BORNAGENT_TASK_CONTEXT_V1\n${canonicalJson(baselineTaskContext)}`,
    baselineTaskContext,
  });
}

describe("CF2 lossless dictionary fold", () => {
  it("preserves every source field and first-seen order deterministically", () => {
    const duplicate = "same verified payload ".repeat(160);
    const receipts = Object.freeze([
      receipt({ index: 1, narrative: duplicate, evidenceRefs: ["evidence/shared", "evidence/a"] }),
      receipt({ index: 2, narrative: duplicate, evidenceRefs: ["evidence/shared", "evidence/a"] }),
      receipt({ index: 3, narrative: "unique final fact", status: "blocked" }),
    ]);

    const first = foldAcceptedChildReceipts(receipts);
    const second = foldAcceptedChildReceipts(receipts);
    const expanded = expandAcceptedChildReceiptFold(first);

    expect(canonicalJson(expanded)).toBe(canonicalJson(receipts));
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.sources.map((entry) => entry.sourceOrdinal)).toEqual([0, 1, 2]);
    expect(first.claims).toHaveLength(2);
    expect(first.evidence.map((entry) => entry.artifactRef)).toEqual([
      "evidence/shared",
      "evidence/a",
    ]);
    expect(first.sourceSetSha256).toBe(sha256Canonical(
      receipts.map((entry) => entry.receiptSha256),
    ));
  });

  it("rejects tampered hashes, ordinal gaps, duplicate dictionaries and extra fields", () => {
    const fold = foldAcceptedChildReceipts([
      receipt({ index: 1, narrative: "one" }),
      receipt({ index: 2, narrative: "one" }),
    ]);

    expect(() => acceptedChildReceiptFoldSchema.parse({
      ...fold,
      foldSha256: "0".repeat(64),
    })).toThrow();
    expect(() => acceptedChildReceiptFoldSchema.parse({
      ...fold,
      sources: fold.sources.map((source, index) => ({
        ...source,
        sourceOrdinal: index + 1,
      })),
    })).toThrow();
    expect(() => acceptedChildReceiptFoldSchema.parse({
      ...fold,
      claims: [...fold.claims, fold.claims[0]],
    })).toThrow();
    expect(() => acceptedChildReceiptFoldSchema.parse({
      ...fold,
      unexpected: true,
    })).toThrow();
  });

  it("selects only a full-context 25 percent win and keeps exact fallback otherwise", () => {
    const duplicate = "same long verified child fact ".repeat(120);
    const receipts = Object.freeze([
      receipt({ index: 1, narrative: duplicate }),
      receipt({ index: 2, narrative: duplicate }),
      receipt({ index: 3, narrative: duplicate }),
      receipt({ index: 4, narrative: duplicate }),
    ]);
    const baseline = providerContext(receipts);
    const selected = selectAcceptedChildReceiptContext({
      acceptedChildReceipts: receipts,
      ...baseline,
      enabled: true,
    });

    expect(selected.selected).toBe(true);
    expect(selected.reason).toBe("selected");
    expect(selected.losslessExpansion).toBe(true);
    expect(selected.candidateTokens).toBeLessThanOrEqual(Math.floor(
      cf2ContextFoldingEstimator.estimateText(baseline.baselineProviderContext)
        .estimatedTokens * 0.75,
    ));
    expect(selected.modelCalls).toBe(0);
    expect(selected.toolCalls).toBe(0);
    expect(selected.networkCalls).toBe(0);

    const wrapperDominates = providerContext(receipts, "unrelated wrapper ".repeat(2_000));
    const notSelected = selectAcceptedChildReceiptContext({
      acceptedChildReceipts: receipts,
      ...wrapperDominates,
      enabled: true,
    });
    expect(notSelected.selected).toBe(false);
    expect(notSelected.reason).toBe("not_beneficial");
    expect(notSelected.providerContext).toBe(wrapperDominates.baselineProviderContext);
  });

  it("returns the byte-identical baseline for disabled and injected failures", () => {
    const receipts = Object.freeze([
      receipt({ index: 1, narrative: "duplicate ".repeat(400) }),
      receipt({ index: 2, narrative: "duplicate ".repeat(400) }),
    ]);
    const baseline = providerContext(receipts);

    const disabled = selectAcceptedChildReceiptContext({
      acceptedChildReceipts: receipts,
      ...baseline,
      enabled: false,
    });
    expect(disabled.reason).toBe("disabled");
    expect(disabled.providerContext).toBe(baseline.baselineProviderContext);

    for (const faultMode of ["throw", "invalid"] as const) {
      const failed = selectAcceptedChildReceiptContext({
        acceptedChildReceipts: receipts,
        ...baseline,
        enabled: true,
        faultMode,
      });
      expect(failed.reason).toBe("candidate_fault");
      expect(failed.providerContext).toBe(baseline.baselineProviderContext);
      expect(failed.selected).toBe(false);
    }

    const deadlineExpired = selectAcceptedChildReceiptContext({
      acceptedChildReceipts: receipts,
      ...baseline,
      enabled: true,
      faultMode: "deadline_expired",
    });
    expect(deadlineExpired.reason).toBe("deadline_expired");
    expect(deadlineExpired.diagnosticCode).toBe(
      "context_fold_deadline_expired_before_invocation",
    );
    expect(deadlineExpired.fold).toBeNull();
    expect(deadlineExpired.providerContext).toBe(baseline.baselineProviderContext);
  });
});
