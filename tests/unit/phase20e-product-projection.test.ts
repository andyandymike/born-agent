import { describe, expect, it } from "vitest";

import { projectTaskContext } from "../../src/coordination/task-context-projection.js";
import { renderDelegationPanel } from "../../src/tui/components/delegation-panel.js";
import { createInitialTuiEphemeralState, setDelegationPanel } from "../../src/tui/tui-ephemeral-state.js";
import { phase20Projection, phase20Revision } from "../phase20-test-helpers.js";

describe("Phase 20E product projection", () => {
  it("renders delegation identity with non-color active/status markers", () => {
    const revision = phase20Revision({ envelope: true, status: "queued" });
    const lines = renderDelegationPanel(
      phase20Projection([revision]),
      setDelegationPanel(createInitialTuiEphemeralState(), true),
    );
    expect(lines.join("\n")).toContain("DELEGATIONS");
    expect(lines.join("\n")).toContain("-- #1 queued");
    expect(lines.join("\n")).toContain(revision.delegationId);
    expect(lines.join("\n")).not.toContain("Default deny");
  });

  it("adds only typed accepted receipt facts to the next parent context", () => {
    const state = {
      activeGoalId: "30000000-0000-4000-8000-000000000020",
      blockers: [],
      currentApprovedPlan: null,
      goals: [{ content: { goalId: "30000000-0000-4000-8000-000000000020", objective: "Finish safely", parentGoalId: null, revision: 1 }, createdEventId: "a", lastStatusEventId: null, status: "active" }],
      lastSessionSeq: 1,
      pendingDraft: null,
      plans: [],
      readyForCompletion: false,
      trackingMode: "phase16",
    } as const;
    const receipt = {
      kind: "accepted_child_receipt" as const,
      delegationId: "50000000-0000-4000-8000-000000000020",
      childAttemptId: "70000000-0000-4000-8000-000000000020",
      status: "succeeded" as const,
      objective: "Inspect facts",
      verifiedClaims: [{ claimId: "answer", kind: "answer", narrative: "Bounded verified fact", evidenceRefs: ["sha256:a"] }],
      changeBundleRef: null,
      verificationGenerationIds: [],
      receiptSha256: "a".repeat(64),
    };
    const projected = projectTaskContext({ agentMode: "plan", taskState: state, acceptedChildReceipts: [receipt] });
    expect(projected.acceptedChildReceipts).toEqual([receipt]);
    expect(JSON.stringify(projected)).not.toContain("transcript");
    expect(projectTaskContext({ agentMode: "plan", taskState: state })).not.toHaveProperty("acceptedChildReceipts");
  });
});
