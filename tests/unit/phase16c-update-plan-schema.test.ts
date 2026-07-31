import { describe, expect, it } from "vitest";

import { updatePlanInputSchema } from "../../src/plans/update-plan-input-schema.js";

const plan = {
  items: [
    {
      acceptance: "The behavior is verified.",
      id: "implement",
      required: true,
      title: "Implement",
    },
  ],
  title: "Reviewable Plan",
};

describe("Phase 16C update_plan schema", () => {
  it("accepts the three strict operation shapes", () => {
    expect(
      updatePlanInputSchema.parse({ operation: "propose", plan }),
    ).toMatchObject({ operation: "propose" });
    expect(
      updatePlanInputSchema.parse({
        base_plan_id: "16000000-0000-4000-8000-000000000301",
        base_revision: 1,
        base_sha256: "a".repeat(64),
        operation: "revise",
        plan,
      }),
    ).toMatchObject({ operation: "revise" });
    expect(
      updatePlanInputSchema.parse({
        evidence_event_ids: [],
        item_id: "implement",
        note: "",
        operation: "set_item_status",
        plan_id: "16000000-0000-4000-8000-000000000301",
        plan_sha256: "a".repeat(64),
        revision: 1,
        status: "in_progress",
      }),
    ).toMatchObject({ operation: "set_item_status" });
  });

  it("rejects authority fields and invalid evidence/note combinations", () => {
    expect(() =>
      updatePlanInputSchema.parse({
        goal_id: "16000000-0000-4000-8000-000000000201",
        operation: "propose",
        plan,
      }),
    ).toThrow();
    expect(() =>
      updatePlanInputSchema.parse({
        evidence_event_ids: [],
        item_id: "implement",
        note: "done",
        operation: "set_item_status",
        plan_id: "16000000-0000-4000-8000-000000000301",
        plan_sha256: "a".repeat(64),
        revision: 1,
        status: "completed",
      }),
    ).toThrow(/evidence/u);
    expect(() =>
      updatePlanInputSchema.parse({
        evidence_event_ids: [],
        item_id: "implement",
        note: " ",
        operation: "set_item_status",
        plan_id: "16000000-0000-4000-8000-000000000301",
        plan_sha256: "a".repeat(64),
        revision: 1,
        status: "blocked",
      }),
    ).toThrow(/note/u);
  });
});
