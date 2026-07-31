import { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";
import {
  goalIdSchema,
  revisionSchema,
} from "../goals/goal-schema.js";
import { canonicalStoredTextSchema } from "../coordination/task-text-schema.js";

export const MAX_CANONICAL_PLAN_BYTES = 32 * 1024;

export const planIdSchema = z.string().uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const planItemIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

export const planTitleSchema = canonicalStoredTextSchema({
  maximumBytes: 800,
  maximumScalars: 200,
  minimumScalars: 1,
  nonblank: true,
});

export const planItemAcceptanceSchema = canonicalStoredTextSchema({
  maximumBytes: 3_200,
  maximumScalars: 800,
  minimumScalars: 1,
  nonblank: true,
});

export const planItemContentSchema = z
  .object({
    acceptance: planItemAcceptanceSchema,
    id: planItemIdSchema,
    required: z.boolean(),
    title: planTitleSchema,
  })
  .strict();

export const planRevisionContentSchema = z
  .object({
    goalId: goalIdSchema,
    goalRevision: revisionSchema,
    items: z.array(planItemContentSchema).min(1).max(32),
    planId: planIdSchema,
    revision: revisionSchema,
    schemaVersion: z.literal(1),
    title: planTitleSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const itemIds = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (itemIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "plan item ids must be unique",
          path: ["items", index, "id"],
        });
      }
      itemIds.add(item.id);
    }
    if (
      Buffer.byteLength(canonicalJson(value), "utf8") >
      MAX_CANONICAL_PLAN_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: `canonical plan content must not exceed ${MAX_CANONICAL_PLAN_BYTES} UTF-8 bytes`,
      });
    }
  });

export const planRevisionStatusSchema = z.enum([
  "draft",
  "active",
  "completed",
  "rejected",
  "superseded",
]);

export const planItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
]);

type ParsedPlanItemContent = z.infer<typeof planItemContentSchema>;
type ParsedPlanRevisionContent = z.infer<typeof planRevisionContentSchema>;

export type PlanId = string;
export type Sha256 = string;
export type PlanItemId = string;
export type PlanRevisionStatus = z.infer<typeof planRevisionStatusSchema>;
export type PlanItemStatus = z.infer<typeof planItemStatusSchema>;
export type PlanItemContent = Readonly<ParsedPlanItemContent>;
export type PlanRevisionContent = Readonly<
  Omit<ParsedPlanRevisionContent, "items"> & {
    readonly items: readonly PlanItemContent[];
  }
>;
