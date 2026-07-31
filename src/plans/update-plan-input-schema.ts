import { z } from "zod";

import { taskEventIdSchema, revisionSchema } from "../goals/goal-schema.js";
import {
  planIdSchema,
  planItemAcceptanceSchema,
  planItemIdSchema,
  planTitleSchema,
  sha256Schema,
} from "./plan-schema.js";
import { canonicalStoredTextSchema } from "../coordination/task-text-schema.js";

const editablePlanInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            acceptance: planItemAcceptanceSchema,
            id: planItemIdSchema,
            required: z.boolean(),
            title: planTitleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .superRefine((items, context) => {
        const ids = new Set<string>();
        for (const [index, item] of items.entries()) {
          if (ids.has(item.id)) {
            context.addIssue({
              code: "custom",
              message: "plan item ids must be unique",
              path: [index, "id"],
            });
          }
          ids.add(item.id);
        }
      }),
    title: planTitleSchema,
  })
  .strict();

const noteSchema = canonicalStoredTextSchema({ maximumBytes: 4 * 1024 });

const proposeSchema = z
  .object({
    operation: z.literal("propose"),
    plan: editablePlanInputSchema,
  })
  .strict();

const reviseSchema = z
  .object({
    base_plan_id: planIdSchema,
    base_revision: revisionSchema,
    base_sha256: sha256Schema,
    operation: z.literal("revise"),
    plan: editablePlanInputSchema,
  })
  .strict();

const statusChangeSchema = z
  .object({
    evidence_event_ids: z
      .array(taskEventIdSchema)
      .max(16)
      .refine(
        (values) => new Set(values).size === values.length,
        "evidence event ids must be unique",
      ),
    item_id: planItemIdSchema,
    note: noteSchema,
    operation: z.literal("set_item_status"),
    plan_id: planIdSchema,
    plan_sha256: sha256Schema,
    revision: revisionSchema,
    status: z.enum(["in_progress", "completed", "blocked", "skipped"]),
  })
  .strict()
  .superRefine((value, context) => {
    const nonblank = value.note.trim().length > 0;
    if (
      (value.status === "completed" ||
        value.status === "blocked" ||
        value.status === "skipped") &&
      !nonblank
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.status} requires a non-empty note`,
        path: ["note"],
      });
    }
    if (
      value.status === "completed" &&
      value.evidence_event_ids.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "completed requires at least one evidence event id",
        path: ["evidence_event_ids"],
      });
    }
    if (
      (value.status === "in_progress" || value.status === "skipped") &&
      value.evidence_event_ids.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.status} must not include evidence event ids`,
        path: ["evidence_event_ids"],
      });
    }
  });

export const updatePlanInputSchema = z.discriminatedUnion("operation", [
  proposeSchema,
  reviseSchema,
  statusChangeSchema,
]);

export type EditablePlanInput = Readonly<
  z.infer<typeof editablePlanInputSchema>
>;
export type UpdatePlanInput = Readonly<z.infer<typeof updatePlanInputSchema>>;
