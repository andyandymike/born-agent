import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const itemIdSchema = z.string().regex(/^ctx:[0-9a-f]{64}$/u);
const factIdSchema = z.string().regex(/^fact:[0-9a-f]{64}$/u);
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const contextPlanSchema = z
  .object({
    archivedItemIds: z.array(itemIdSchema),
    canonicalContextSha256: sha256Schema,
    capacity: z
      .object({
        absoluteInputTokens: z.number().int().positive(),
        capacitySource: z.enum(["pinned_catalog", "user_conservative_limit"]),
        compactionTargetTokens: z.number().int().positive(),
        compactionThreshold: z.number().min(0.5).max(0.95),
        contextWindowTokens: z.number().int().positive(),
        fixedSafetyMarginTokens: z.number().int().nonnegative(),
        reservedOutputTokens: z.number().int().min(512).max(32_768),
      })
      .strict(),
    compacted: z.boolean(),
    descriptorItemIds: z.array(itemIdSchema),
    epoch: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
    estimator: z
      .object({
        estimatorId: sha256Schema,
        model: z.string().min(1),
        provider: z.string().min(1),
        tokenizer: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    includedItemIds: z.array(itemIdSchema),
    plannerVersion: z.string().regex(/^[a-z0-9._-]+$/u),
    protectedEstimatedTokens: z.number().int().nonnegative(),
    protectedFactIds: z.array(factIdSchema),
    protectedItemIds: z.array(itemIdSchema),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((plan, context) => {
    for (const [field, values] of [
      ["archivedItemIds", plan.archivedItemIds],
      ["descriptorItemIds", plan.descriptorItemIds],
      ["includedItemIds", plan.includedItemIds],
      ["protectedFactIds", plan.protectedFactIds],
      ["protectedItemIds", plan.protectedItemIds],
    ] as const) {
      if (!unique(values)) {
        context.addIssue({
          code: "custom",
          message: `${field} must be unique`,
          path: [field],
        });
      }
    }
    const included = new Set(plan.includedItemIds);
    const archived = new Set(plan.archivedItemIds);
    if (plan.archivedItemIds.some((id) => included.has(id))) {
      context.addIssue({
        code: "custom",
        message: "included and archived item ids must be disjoint",
        path: ["archivedItemIds"],
      });
    }
    if (
      plan.protectedItemIds.some(
        (id) => !included.has(id) || archived.has(id),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "protected items must be included and never archived",
        path: ["protectedItemIds"],
      });
    }
    if (
      plan.capacity.compactionTargetTokens >
        plan.capacity.absoluteInputTokens ||
      plan.estimatedInputTokens > plan.capacity.absoluteInputTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "context plan exceeds its absolute input capacity",
        path: ["estimatedInputTokens"],
      });
    }
  });

type ParsedContextPlan = z.infer<typeof contextPlanSchema>;

export type ContextPlan = Omit<
  ParsedContextPlan,
  | "archivedItemIds"
  | "capacity"
  | "descriptorItemIds"
  | "estimator"
  | "includedItemIds"
  | "protectedFactIds"
  | "protectedItemIds"
> & {
  readonly archivedItemIds: readonly string[];
  readonly capacity: Readonly<ParsedContextPlan["capacity"]>;
  readonly descriptorItemIds: readonly string[];
  readonly estimator: Readonly<ParsedContextPlan["estimator"]>;
  readonly includedItemIds: readonly string[];
  readonly protectedFactIds: readonly string[];
  readonly protectedItemIds: readonly string[];
};

function freezePlan(plan: ParsedContextPlan): ContextPlan {
  return Object.freeze({
    ...plan,
    archivedItemIds: Object.freeze(plan.archivedItemIds),
    capacity: Object.freeze(plan.capacity),
    descriptorItemIds: Object.freeze(plan.descriptorItemIds),
    estimator: Object.freeze(plan.estimator),
    includedItemIds: Object.freeze(plan.includedItemIds),
    protectedFactIds: Object.freeze(plan.protectedFactIds),
    protectedItemIds: Object.freeze(plan.protectedItemIds),
  });
}

export function parseContextPlan(value: unknown): ContextPlan {
  return freezePlan(contextPlanSchema.parse(value));
}
