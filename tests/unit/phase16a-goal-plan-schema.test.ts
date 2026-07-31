import { describe, expect, it } from "vitest";

import {
  goalObjectiveSchema,
  goalRevisionContentSchema,
} from "../../src/goals/goal-schema.js";
import {
  planItemContentSchema,
  planRevisionContentSchema,
} from "../../src/plans/plan-schema.js";
import {
  GOAL,
  PLAN,
  planContent,
} from "./phase16a-test-fixtures.js";

describe("Phase 16A Goal and Plan schemas", () => {
  it("accepts scalar-aware objective bounds and canonical LF/TAB text", () => {
    expect(goalObjectiveSchema.parse("line 1\n\tline 2")).toBe(
      "line 1\n\tline 2",
    );
    expect(goalObjectiveSchema.parse("😀".repeat(8_000))).toHaveLength(16_000);
    expect(
      goalRevisionContentSchema.parse({
        goalId: GOAL,
        objective: "Ship Phase 16A",
        parentGoalId: null,
        revision: 1,
      }),
    ).toMatchObject({ goalId: GOAL, revision: 1 });
  });

  it.each([
    ["blank", " \t\n"],
    ["NUL", "bad\0text"],
    ["CRLF requiring normalization", "bad\r\ntext"],
    ["C1 control", "bad\u0085text"],
    ["unpaired surrogate", "bad\ud800text"],
    ["trailing unpaired surrogate", "bad\ud800"],
    ["too many scalars", "a".repeat(8_001)],
  ])("rejects %s objective text", (_name, value) => {
    expect(() => goalObjectiveSchema.parse(value)).toThrow();
  });

  it("strictly validates Plan item ids, text, and extra properties", () => {
    expect(
      planItemContentSchema.parse({
        acceptance: "Passes",
        id: "item_1",
        required: true,
        title: "Implement",
      }),
    ).toMatchObject({ id: "item_1" });
    expect(() =>
      planItemContentSchema.parse({
        acceptance: "Passes",
        extra: true,
        id: "Item 1",
        required: true,
        title: "Implement",
      }),
    ).toThrow();
  });

  it("rejects duplicate items, invalid revisions, ids, and oversized canonical content", () => {
    const duplicate = planContent({
      items: [planContent().items[0]!, planContent().items[0]!],
    });
    expect(() => planRevisionContentSchema.parse(duplicate)).toThrow(
      "must be unique",
    );
    expect(() =>
      planRevisionContentSchema.parse({ ...planContent(), revision: 0 }),
    ).toThrow();
    expect(() =>
      planRevisionContentSchema.parse({ ...planContent(), planId: "not-uuid" }),
    ).toThrow();

    const oversized = planContent({
      items: Array.from({ length: 32 }, (_, index) => ({
        acceptance: "😀".repeat(800),
        id: `item_${index}`,
        required: true,
        title: `Item ${index}`,
      })),
    });
    expect(() => planRevisionContentSchema.parse(oversized)).toThrow(
      "canonical plan content",
    );
  });

  it("rejects missing/extra Plan fields while accepting the minimal valid content", () => {
    expect(planRevisionContentSchema.parse(planContent())).toMatchObject({
      goalId: GOAL,
      planId: PLAN,
      schemaVersion: 1,
    });
    expect(() =>
      planRevisionContentSchema.parse({ ...planContent(), extra: true }),
    ).toThrow();
    const missing = { ...planContent() } as Record<string, unknown>;
    delete missing.title;
    expect(() => planRevisionContentSchema.parse(missing)).toThrow();
  });
});
