import { z } from "zod";

import {
  goalIdSchema,
  goalObjectiveSchema,
  revisionSchema,
  taskEventIdSchema,
} from "../goals/goal-schema.js";
import {
  planIdSchema,
  planItemIdSchema,
  planItemStatusSchema,
  planRevisionContentSchema,
  sha256Schema,
} from "../plans/plan-schema.js";
import { canonicalStoredTextSchema } from "./task-text-schema.js";

const callIdSchema = z.string().min(1).max(200);
const noteSchema = canonicalStoredTextSchema({ maximumBytes: 4 * 1024 });
const reasonSchema = canonicalStoredTextSchema({
  maximumBytes: 4 * 1024,
  minimumScalars: 1,
  nonblank: true,
});

export const userOriginSchema = z
  .object({
    input_surface: z.enum(["cli", "tui"]),
    kind: z.literal("user"),
  })
  .strict();

export const agentOriginSchema = z
  .object({
    call_id: callIdSchema,
    kind: z.literal("agent"),
    mutation_id: callIdSchema,
    run_id: z.string().uuid(),
  })
  .strict();

export const taskGraphProgressOriginSchema = z
  .object({
    graph_id: z.string().uuid(),
    graph_revision: revisionSchema,
    graph_sha256: sha256Schema,
    kind: z.literal("task_graph"),
  })
  .strict();

export const hostCompletionOriginSchema = z
  .object({ kind: z.literal("host_completion") })
  .strict();

export const goalCreatedDataSchema = z
  .object({
    goal_id: goalIdSchema,
    objective: goalObjectiveSchema,
    origin: userOriginSchema,
    parent_goal_id: goalIdSchema.nullable(),
    replaces_active_goal: z
      .object({
        disposition: z.literal("abandoned"),
        goal_id: goalIdSchema,
        revision: revisionSchema,
      })
      .strict()
      .nullable(),
    revision: z.literal(1),
  })
  .strict();

export const goalRevisedDataSchema = z
  .object({
    base_revision: revisionSchema,
    goal_id: goalIdSchema,
    objective: goalObjectiveSchema,
    origin: userOriginSchema,
    revision: revisionSchema,
  })
  .strict();

const goalAbandonedDataSchema = z
  .object({
    from: z.literal("active"),
    goal_id: goalIdSchema,
    origin: userOriginSchema,
    reason: reasonSchema,
    revision: revisionSchema,
    to: z.literal("abandoned"),
  })
  .strict();

const goalCompletedDataSchema = z
  .object({
    completion_evaluated_event_id: taskEventIdSchema,
    finish_task_call_id: callIdSchema,
    from: z.literal("active"),
    goal_id: goalIdSchema,
    origin: hostCompletionOriginSchema,
    revision: revisionSchema,
    to: z.literal("completed"),
  })
  .strict();

export const goalStatusChangedDataSchema = z.discriminatedUnion("to", [
  goalAbandonedDataSchema,
  goalCompletedDataSchema,
]);

const planMutationOriginSchema = z.union([
  userOriginSchema,
  agentOriginSchema,
]);

export const planProposedDataSchema = z
  .object({
    content: planRevisionContentSchema,
    origin: planMutationOriginSchema,
    plan_sha256: sha256Schema,
  })
  .strict()
  .refine((value) => value.content.revision === 1, {
    message: "plan.proposed content revision must be 1",
    path: ["content", "revision"],
  });

export const planRevisedDataSchema = z
  .object({
    base_revision: revisionSchema,
    base_sha256: sha256Schema,
    content: planRevisionContentSchema,
    origin: planMutationOriginSchema,
    plan_sha256: sha256Schema,
  })
  .strict();

const planDecisionFields = {
  goal_id: goalIdSchema,
  goal_revision: revisionSchema,
  origin: userOriginSchema,
  plan_id: planIdSchema,
  plan_sha256: sha256Schema,
  revision: revisionSchema,
};

export const planApprovedDataSchema = z
  .object(planDecisionFields)
  .strict();

export const planRejectedDataSchema = z
  .object({
    ...planDecisionFields,
    reason: reasonSchema,
  })
  .strict();

export const planItemStatusChangedDataSchema = z
  .object({
    evidence_event_ids: z
      .array(taskEventIdSchema)
      .max(16)
      .refine(
        (values) => new Set(values).size === values.length,
        "evidence event ids must be unique",
      ),
    from: planItemStatusSchema,
    goal_id: goalIdSchema,
    goal_revision: revisionSchema,
    item_id: planItemIdSchema,
    note: noteSchema,
    origin: z.union([agentOriginSchema, taskGraphProgressOriginSchema]),
    plan_id: planIdSchema,
    plan_sha256: sha256Schema,
    revision: revisionSchema,
    to: planItemStatusSchema,
  })
  .strict();

export const planCompletedDataSchema = z
  .object({
    completion_evaluated_event_id: taskEventIdSchema,
    finish_task_call_id: callIdSchema,
    goal_id: goalIdSchema,
    goal_revision: revisionSchema,
    origin: hostCompletionOriginSchema,
    plan_id: planIdSchema,
    plan_sha256: sha256Schema,
    revision: revisionSchema,
  })
  .strict();

export const phase16TaskSessionEventDataSchemas = {
  "goal.created": goalCreatedDataSchema,
  "goal.revised": goalRevisedDataSchema,
  "goal.status.changed": goalStatusChangedDataSchema,
  "plan.approved": planApprovedDataSchema,
  "plan.completed": planCompletedDataSchema,
  "plan.item.status_changed": planItemStatusChangedDataSchema,
  "plan.proposed": planProposedDataSchema,
  "plan.rejected": planRejectedDataSchema,
  "plan.revised": planRevisedDataSchema,
} as const;

export type UserOrigin = Readonly<z.infer<typeof userOriginSchema>>;
export type AgentOrigin = Readonly<z.infer<typeof agentOriginSchema>>;
export type TaskGraphProgressOrigin = Readonly<z.infer<typeof taskGraphProgressOriginSchema>>;
export type HostCompletionOrigin = Readonly<
  z.infer<typeof hostCompletionOriginSchema>
>;
export type Phase16TaskSessionEventType =
  keyof typeof phase16TaskSessionEventDataSchemas;
export type Phase16TaskSessionEventData<
  TType extends Phase16TaskSessionEventType,
> = z.infer<(typeof phase16TaskSessionEventDataSchemas)[TType]>;
