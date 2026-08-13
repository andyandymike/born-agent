import { z } from "zod";

// Surface-neutral intent contract shared by the TUI parser and coordinator.

import { agentModeSchema } from "../agent/agent-mode.js";
import { canonicalStoredTextSchema } from "./task-text-schema.js";
import { goalIdSchema, goalObjectiveSchema, revisionSchema } from "../goals/goal-schema.js";
import { planIdSchema, sha256Schema } from "../plans/plan-schema.js";

const sessionIdSchema = z.string().uuid();
const intentTextSchema = canonicalStoredTextSchema({
  maximumBytes: 64 * 1024,
  maximumScalars: 16_000,
  minimumScalars: 1,
  nonblank: true,
});
const reasonSchema = canonicalStoredTextSchema({
  maximumBytes: 4 * 1024,
  maximumScalars: 1_000,
  minimumScalars: 1,
  nonblank: true,
});
const localPlanPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0x20 && codePoint !== 0x7f;
      }),
    {
    message: "Plan path contains control characters",
    },
  );

export const idleSnapshotBindingSchema = z
  .object({
    expectedSessionSeq: z.number().int().nonnegative().nullable(),
    sessionId: sessionIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.sessionId === null) !== (value.expectedSessionSeq === null)) {
      context.addIssue({
        code: "custom",
        message: "sessionId and expectedSessionSeq must both be null or both be present",
      });
    }
  });

const bound = idleSnapshotBindingSchema.shape;
const planRevisionRefSchema = z
  .object({
    goalId: goalIdSchema,
    goalRevision: revisionSchema,
    planId: planIdSchema,
    planSha256: sha256Schema,
    revision: revisionSchema,
  })
  .strict();

export const phase16UserIntentSchema = z.discriminatedUnion("type", [
  z.object({ mode: agentModeSchema, type: z.literal("set_agent_mode") }).strict(),
  z
    .object({
      expectedSessionSeq: bound.expectedSessionSeq,
      sessionId: bound.sessionId,
      text: intentTextSchema,
      type: z.literal("submit_idle_message"),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.sessionId === null) !== (value.expectedSessionSeq === null)) {
        context.addIssue({ code: "custom", message: "idle snapshot binding is incomplete" });
      }
    }),
  z
    .object({
      expectedSessionSeq: bound.expectedSessionSeq,
      mode: agentModeSchema,
      reason: z.enum([
        "approved_plan_build",
        "explicit_continue",
        "retry_goal_start",
      ]),
      sessionId: bound.sessionId,
      type: z.literal("start_run_without_message"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({
          code: "custom",
          message: "starting an existing Goal requires a session snapshot",
        });
      }
    }),
  z
    .object({
      confirmedAbandon: z.boolean(),
      currentGoalId: goalIdSchema.nullable(),
      currentGoalRevision: revisionSchema.nullable(),
      expectedSessionSeq: bound.expectedSessionSeq,
      sessionId: bound.sessionId,
      text: goalObjectiveSchema,
      type: z.literal("start_new_goal"),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.sessionId === null) !== (value.expectedSessionSeq === null)) {
        context.addIssue({ code: "custom", message: "idle snapshot binding is incomplete" });
      }
      if ((value.currentGoalId === null) !== (value.currentGoalRevision === null)) {
        context.addIssue({ code: "custom", message: "current Goal binding is incomplete" });
      }
      if (value.currentGoalId !== null && !value.confirmedAbandon) {
        context.addIssue({ code: "custom", message: "active Goal replacement requires confirmation" });
      }
    }),
  z
    .object({
      baseRevision: revisionSchema,
      expectedSessionSeq: bound.expectedSessionSeq,
      goalId: goalIdSchema,
      objective: goalObjectiveSchema,
      sessionId: bound.sessionId,
      type: z.literal("revise_goal"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({ code: "custom", message: "Goal revision requires a session snapshot" });
      }
    }),
  z
    .object({
      expectedSessionSeq: bound.expectedSessionSeq,
      goalId: goalIdSchema,
      reason: reasonSchema,
      revision: revisionSchema,
      sessionId: bound.sessionId,
      type: z.literal("abandon_goal"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({ code: "custom", message: "Goal abandonment requires a session snapshot" });
      }
    }),
  z
    .object({
      expectedSessionSeq: bound.expectedSessionSeq,
      goalId: goalIdSchema,
      goalRevision: revisionSchema,
      planId: planIdSchema,
      revision: revisionSchema,
      sessionId: bound.sessionId,
      sha256: sha256Schema,
      type: z.literal("approve_plan"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({ code: "custom", message: "Plan approval requires a session snapshot" });
      }
    }),
  z
    .object({
      expectedSessionSeq: bound.expectedSessionSeq,
      goalId: goalIdSchema,
      goalRevision: revisionSchema,
      planId: planIdSchema,
      reason: reasonSchema,
      revision: revisionSchema,
      sessionId: bound.sessionId,
      sha256: sha256Schema,
      type: z.literal("reject_plan"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({ code: "custom", message: "Plan rejection requires a session snapshot" });
      }
    }),
  z
    .object({
      base: planRevisionRefSchema.nullable(),
      expectedSessionSeq: bound.expectedSessionSeq,
      goalId: goalIdSchema,
      goalRevision: revisionSchema,
      path: localPlanPathSchema,
      sessionId: bound.sessionId,
      type: z.literal("replace_plan_from_file"),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sessionId === null || value.expectedSessionSeq === null) {
        context.addIssue({ code: "custom", message: "Plan replacement requires a session snapshot" });
      }
    }),
  z.object({ type: z.literal("cancel_active_run") }).strict(),
  z.object({ sessionId: sessionIdSchema, type: z.literal("select_session") }).strict(),
  z.object({ type: z.literal("refresh_session") }).strict(),
  z.object({ type: z.literal("exit") }).strict(),
]);

export type IdleSnapshotBinding = Readonly<
  z.infer<typeof idleSnapshotBindingSchema>
>;
export type Phase16UserIntent = Readonly<
  z.infer<typeof phase16UserIntentSchema>
>;

export type Phase16StartIntent = Extract<
  Phase16UserIntent,
  {
    type:
      | "start_new_goal"
      | "start_run_without_message"
      | "submit_idle_message";
  }
>;

export type Phase16MutationIntent = Extract<
  Phase16UserIntent,
  {
    type:
      | "abandon_goal"
      | "approve_plan"
      | "reject_plan"
      | "replace_plan_from_file"
      | "revise_goal";
  }
>;

export function idleBindingOf(
  intent: Phase16StartIntent | Phase16MutationIntent,
): IdleSnapshotBinding {
  return {
    expectedSessionSeq: intent.expectedSessionSeq,
    sessionId: intent.sessionId,
  };
}

export function parsePhase16UserIntent(value: unknown): Phase16UserIntent {
  return phase16UserIntentSchema.parse(value);
}
