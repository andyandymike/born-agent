import { describe, expect, it } from "vitest";

import { canonicalPlanIdentity } from "../../src/plans/plan-identity.js";
import { GOAL_2, PLAN_2, planContent } from "./phase16a-test-fixtures.js";

describe("Phase 16A canonical Plan identity", () => {
  it("ignores object key order and source JSON whitespace", () => {
    const content = planContent();
    const reordered = {
      title: content.title,
      schemaVersion: content.schemaVersion,
      revision: content.revision,
      planId: content.planId,
      items: content.items.map((item) => ({
        title: item.title,
        required: item.required,
        id: item.id,
        acceptance: item.acceptance,
      })),
      goalRevision: content.goalRevision,
      goalId: content.goalId,
    };
    const spaced = JSON.parse(JSON.stringify(reordered, null, 4)) as unknown;

    expect(canonicalPlanIdentity(reordered).sha256).toBe(
      canonicalPlanIdentity(content).sha256,
    );
    expect(canonicalPlanIdentity(spaced).sha256).toBe(
      canonicalPlanIdentity(content).sha256,
    );
  });

  it.each([
    ["plan id", { planId: PLAN_2 }],
    ["plan revision", { revision: 2 }],
    ["Goal id", { goalId: GOAL_2 }],
    ["Goal revision", { goalRevision: 2 }],
    ["title", { title: "Changed plan" }],
    [
      "item text",
      {
        items: [
          {
            ...planContent().items[0]!,
            acceptance: "Different acceptance",
          },
        ],
      },
    ],
    [
      "required flag",
      {
        items: [{ ...planContent().items[0]!, required: false }],
      },
    ],
    [
      "item order",
      {
        items: [
          { ...planContent().items[0]!, id: "second" },
          planContent().items[0]!,
        ],
      },
    ],
  ])("changes hash when %s changes", (_name, change) => {
    expect(canonicalPlanIdentity(planContent(change)).sha256).not.toBe(
      canonicalPlanIdentity(planContent()).sha256,
    );
  });

  it("returns the shared canonical JSON representation and rejects undefined/oversize content", () => {
    const identity = canonicalPlanIdentity(planContent());
    expect(identity.canonicalJson).toContain('"schemaVersion":1');
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(identity.content)).toBe(true);
    expect(Object.isFrozen(identity.content.items)).toBe(true);
    expect(() =>
      canonicalPlanIdentity({ ...planContent(), title: undefined }),
    ).toThrow();
  });
});
