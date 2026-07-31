import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const positiveRevision = z.number().int().positive();
const boundedPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      value
        .split("/")
        .every((component) => component !== "" && component !== "." && component !== ".."),
    "path must be a normalized workspace-relative POSIX path",
  );
const objectRef = z
  .string()
  .regex(
    /^artifacts\/[0-9a-f-]{36}\/objects\/[a-f0-9]{64}$/u,
  );

export const goalChangeImageRefSchema = z
  .object({
    artifact_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
    event_id: uuid,
    object_ref: objectRef,
    sha256,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.artifact_id !== `sha256:${value.sha256}` ||
      !value.object_ref.endsWith(`/objects/${value.sha256}`)
    ) {
      context.addIssue({
        code: "custom",
        message: "Goal change image identity fields do not match",
      });
    }
  });

const baselineWithoutHashSchema = z
  .object({
    git_head_sha256: sha256,
    git_index_sha256: sha256,
    goal_id: uuid,
    goal_revision: positiveRevision,
    pre_existing_dirty_paths: z
      .array(boundedPath)
      .max(2048)
      .refine(
        (paths) =>
          new Set(paths).size === paths.length &&
          [...paths].sort().join("\0") === paths.join("\0") &&
          Buffer.byteLength(JSON.stringify(paths), "utf8") <= 256 * 1024,
        "dirty paths must be sorted, unique, and within 256 KiB",
      ),
    source_state_sha256: sha256,
  })
  .strict();

export type GoalExecutionBaselineInput = Readonly<
  z.infer<typeof baselineWithoutHashSchema>
>;

export function goalExecutionBaselineSha256(
  input: GoalExecutionBaselineInput,
): string {
  return sha256Canonical(baselineWithoutHashSchema.parse(input));
}

export const goalExecutionBaselineCapturedDataSchema = baselineWithoutHashSchema
  .extend({ baseline_sha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const input = {
      git_head_sha256: value.git_head_sha256,
      git_index_sha256: value.git_index_sha256,
      goal_id: value.goal_id,
      goal_revision: value.goal_revision,
      pre_existing_dirty_paths: value.pre_existing_dirty_paths,
      source_state_sha256: value.source_state_sha256,
    };
    if (value.baseline_sha256 !== goalExecutionBaselineSha256(input)) {
      context.addIssue({ code: "custom", message: "baseline hash does not match" });
    }
  });

export type GoalExecutionBaselineCapturedData = Readonly<
  z.infer<typeof goalExecutionBaselineCapturedDataSchema>
>;

export function createGoalExecutionBaselineData(
  input: GoalExecutionBaselineInput,
): GoalExecutionBaselineCapturedData {
  return Object.freeze(
    goalExecutionBaselineCapturedDataSchema.parse({
      ...input,
      baseline_sha256: goalExecutionBaselineSha256(input),
    }),
  );
}

const goalChangeFileSchema = z
  .object({
    kind: z.enum(["create", "modify"]),
    path: boundedPath,
    postimage: goalChangeImageRefSchema,
    preimage: goalChangeImageRefSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "create") !== (value.preimage === null)) {
      context.addIssue({
        code: "custom",
        message: "create requires null preimage and modify requires one preimage",
      });
    }
  });

const changeWithoutHashSchema = z
  .object({
    call_id: z.string().min(1).max(200),
    files: z
      .array(goalChangeFileSchema)
      .min(1)
      .max(8)
      .refine(
        (files) => new Set(files.map((file) => file.path)).size === files.length,
        "Goal change paths must be unique",
      ),
    goal_id: uuid,
    goal_revision: positiveRevision,
    patch_plan_event_id: uuid,
    source: z.discriminatedUnion("kind", [
      z
        .object({
          event_id: uuid,
          kind: z.literal("patch_completed"),
          run_id: uuid,
        })
        .strict(),
      z
        .object({
          event_id: uuid,
          kind: z.literal("reconciled_patch"),
          source_run_id: uuid,
        })
        .strict(),
    ]),
  })
  .strict();

export type GoalChangeRecordedInput = Readonly<
  z.infer<typeof changeWithoutHashSchema>
>;

export function goalChangeRecordSha256(input: GoalChangeRecordedInput): string {
  return sha256Canonical(changeWithoutHashSchema.parse(input));
}

export const goalChangeRecordedDataSchema = changeWithoutHashSchema
  .extend({ record_sha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const input = {
      call_id: value.call_id,
      files: value.files,
      goal_id: value.goal_id,
      goal_revision: value.goal_revision,
      patch_plan_event_id: value.patch_plan_event_id,
      source: value.source,
    };
    if (value.record_sha256 !== goalChangeRecordSha256(input)) {
      context.addIssue({ code: "custom", message: "Goal change record hash does not match" });
    }
  });

export type GoalChangeRecordedData = Readonly<
  z.infer<typeof goalChangeRecordedDataSchema>
>;

export function createGoalChangeRecordedData(
  input: GoalChangeRecordedInput,
): GoalChangeRecordedData {
  return Object.freeze(
    goalChangeRecordedDataSchema.parse({
      ...input,
      record_sha256: goalChangeRecordSha256(input),
    }),
  );
}

export const phase16GoalChangeRunEventDataSchemas = {
  "goal.change.recorded": goalChangeRecordedDataSchema,
  "goal.execution.baseline.captured": goalExecutionBaselineCapturedDataSchema,
} as const;

export type Phase16GoalChangeRunEventType =
  keyof typeof phase16GoalChangeRunEventDataSchemas;
export type Phase16GoalChangeRunEventData<
  TType extends Phase16GoalChangeRunEventType,
> = z.infer<(typeof phase16GoalChangeRunEventDataSchemas)[TType]>;
