import { z } from "zod";

import { canonicalStoredTextSchema } from "../coordination/task-text-schema.js";

export const goalIdSchema = z.string().uuid();
export const taskEventIdSchema = z.string().uuid();
export const revisionSchema = z.number().int().positive();

export const goalObjectiveSchema = canonicalStoredTextSchema({
  maximumBytes: 32 * 1024,
  maximumScalars: 8_000,
  minimumScalars: 1,
  nonblank: true,
});

export const goalStatusSchema = z.enum([
  "active",
  "completed",
  "abandoned",
]);

export const goalRevisionContentSchema = z
  .object({
    goalId: goalIdSchema,
    objective: goalObjectiveSchema,
    parentGoalId: goalIdSchema.nullable(),
    revision: revisionSchema,
  })
  .strict();

export const goalProjectionSchema = z
  .object({
    content: goalRevisionContentSchema,
    createdEventId: taskEventIdSchema,
    lastStatusEventId: taskEventIdSchema.nullable(),
    status: goalStatusSchema,
  })
  .strict();

export type GoalId = string;
export type EventId = string;
export type Revision = number;
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalRevisionContent = Readonly<
  z.infer<typeof goalRevisionContentSchema>
>;
export type GoalProjection = Readonly<z.infer<typeof goalProjectionSchema>>;
