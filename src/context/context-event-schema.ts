import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stableIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const contextItemIdSchema = z.string().regex(/^ctx:[0-9a-f]{64}$/u);
const protectedFactIdSchema = z.string().regex(/^fact:[0-9a-f]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;
const uniqueIds = <T extends z.ZodType<string>>(schema: T, maximum = 4_096) =>
  z
    .array(schema)
    .max(maximum)
    .refine(unique, "ids must be unique");

const protectedCategorySchema = z.enum([
  "approval_history",
  "backend_budget_epoch",
  "change_journal",
  "dirty_baseline",
  "pending_effects",
  "repository_rules",
  "repository_state",
  "system_policy",
  "unresolved_errors",
  "user_instruction",
  "verification_state",
]);

export const contextEstimateCreatedDataSchema = z
  .object({
    absolute_input_tokens: positiveIntegerSchema,
    capacity_source: z.enum(["pinned_catalog", "user_conservative_limit"]),
    compaction_target_tokens: positiveIntegerSchema,
    compaction_threshold: z.number().min(0.5).max(0.95),
    context_window_tokens: positiveIntegerSchema,
    epoch: nonnegativeIntegerSchema,
    estimated_input_tokens: nonnegativeIntegerSchema,
    estimator_id: sha256Schema,
    estimator_version: stableIdentifierSchema,
    fixed_safety_margin_tokens: nonnegativeIntegerSchema,
    model: z.string().min(1).max(500),
    provider: stableIdentifierSchema,
    reserved_output_tokens: z.number().int().min(512).max(32_768),
    step: positiveIntegerSchema,
    tokenizer: stableIdentifierSchema,
  })
  .strict()
  .superRefine((data, context) => {
    if (
      data.compaction_target_tokens > data.absolute_input_tokens ||
      data.absolute_input_tokens +
          data.reserved_output_tokens +
          data.fixed_safety_margin_tokens !==
        data.context_window_tokens
    ) {
      context.addIssue({
        code: "custom",
        message: "context estimate capacity fields are inconsistent",
      });
    }
  });

export const contextCompactionStartedDataSchema = z
  .object({
    estimated_input_tokens: nonnegativeIntegerSchema,
    from_epoch: nonnegativeIntegerSchema,
    protected_estimated_tokens: nonnegativeIntegerSchema,
    step: positiveIntegerSchema,
    target_input_tokens: positiveIntegerSchema,
    to_epoch: positiveIntegerSchema,
  })
  .strict()
  .superRefine((data, context) => {
    if (
      data.to_epoch !== data.from_epoch + 1 ||
      data.estimated_input_tokens <= data.target_input_tokens
    ) {
      context.addIssue({
        code: "custom",
        message: "context compaction epoch or threshold is inconsistent",
      });
    }
  });

export const contextPlanCreatedDataSchema = z
  .object({
    archived_item_ids: uniqueIds(contextItemIdSchema),
    canonical_context_sha256: sha256Schema,
    compacted: z.boolean(),
    descriptor_item_ids: uniqueIds(contextItemIdSchema),
    epoch: nonnegativeIntegerSchema,
    estimated_input_tokens: nonnegativeIntegerSchema,
    included_item_ids: uniqueIds(contextItemIdSchema),
    planner_version: stableIdentifierSchema,
    protected_estimated_tokens: nonnegativeIntegerSchema,
    protected_categories: z
      .array(protectedCategorySchema)
      .max(10)
      .refine(unique, "protected categories must be unique")
      .optional(),
    protected_fact_ids: uniqueIds(protectedFactIdSchema),
    protected_item_ids: uniqueIds(contextItemIdSchema),
    step: positiveIntegerSchema,
  })
  .strict()
  .superRefine((data, context) => {
    const included = new Set(data.included_item_ids);
    const archived = new Set(data.archived_item_ids);
    if (data.archived_item_ids.some((id) => included.has(id))) {
      context.addIssue({
        code: "custom",
        message: "included and archived context item ids must be disjoint",
      });
    }
    if (
      data.protected_item_ids.some(
        (id) => !included.has(id) || archived.has(id),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "protected context items must remain included",
      });
    }
  });

export const modelRequestEncodedDataSchema = z
  .object({
    adapter: stableIdentifierSchema,
    adapter_encoding_version: stableIdentifierSchema,
    adapter_version: z.string().min(1).max(200),
    canonical_context_sha256: sha256Schema,
    encoded_request_sha256: sha256Schema.optional(),
    epoch: nonnegativeIntegerSchema,
    model: z.string().min(1).max(500),
    provider: stableIdentifierSchema,
    step: positiveIntegerSchema,
  })
  .strict();

export const contextCompactionFailedDataSchema = z
  .object({
    active_effect_ids: uniqueIds(z.string().min(1).max(300), 128),
    category_estimated_tokens: z
      .array(
        z
          .object({
            category: protectedCategorySchema,
            estimated_tokens: nonnegativeIntegerSchema,
          })
          .strict(),
      )
      .max(10)
      .refine(
        (entries) =>
          new Set(entries.map(({ category }) => category)).size ===
          entries.length,
        "protected categories must be unique",
      ),
    epoch: nonnegativeIntegerSchema,
    estimated_input_tokens: nonnegativeIntegerSchema,
    limit_input_tokens: positiveIntegerSchema,
    reason: z.enum([
      "context_estimate_overflow",
      "context_protected_overflow",
      "context_unsafe_compaction",
    ]),
    step: positiveIntegerSchema,
  })
  .strict();

export const phase10ContextRunEventDataSchemas = {
  "context.compaction.failed": contextCompactionFailedDataSchema,
  "context.compaction.started": contextCompactionStartedDataSchema,
  "context.estimate.created": contextEstimateCreatedDataSchema,
  "context.plan.created": contextPlanCreatedDataSchema,
  "model.request.encoded": modelRequestEncodedDataSchema,
} as const;

export type Phase10ContextRunEventType =
  keyof typeof phase10ContextRunEventDataSchemas;

export type Phase10ContextRunEventData<
  TType extends Phase10ContextRunEventType,
> = z.infer<(typeof phase10ContextRunEventDataSchemas)[TType]>;
