import { z } from "zod";

import { parseQualifiedCapabilityId } from "../capabilities/capability-id.js";
import { canonicalJson } from "../completion/canonical-json.js";
import { canonicalStoredTextSchema } from "../coordination/task-text-schema.js";
import { planItemIdSchema, sha256Schema } from "../plans/plan-schema.js";
import { taskGraphBudgetSchema } from "../task-graph/task-graph-schema.js";
import { DelegationError } from "./delegation-errors.js";

export const MAX_DELEGATIONS_PER_PARENT = 8;
export const MAX_DELEGATION_REVISION_BYTES = 128 * 1024;
export const MAX_DELEGATION_CONTEXT_REFS = 32;
export const MAX_DELEGATION_TOOL_IDS = 32;
export const MAX_DELEGATION_CAPABILITY_IDS = 16;
export const MAX_DELEGATION_PATH_PREFIXES = 32;
export const MAX_DELEGATION_CLAIMS = 16;
export const MIN_DELEGATION_CAPSULE_BYTES = 16 * 1024;
export const MAX_DELEGATION_CAPSULE_BYTES = 256 * 1024;

const uuid = z.string().uuid();
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stableId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const claimId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const toolId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const boundedTitle = canonicalStoredTextSchema({
  maximumBytes: 256,
  maximumScalars: 256,
  minimumScalars: 1,
  nonblank: true,
});
const boundedObjective = canonicalStoredTextSchema({
  maximumBytes: 8 * 1024,
  maximumScalars: 8 * 1024,
  minimumScalars: 1,
  nonblank: true,
});
const boundedClaimDescription = canonicalStoredTextSchema({
  maximumBytes: 1024,
  maximumScalars: 1024,
  minimumScalars: 1,
  nonblank: true,
});

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  });
}

function portableRelativePath(value: string): boolean {
  if (value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    hasControl(value)
  ) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !hasControl(segment));
}

function pathArray(maximum: number) {
  return z.array(z.string()).max(maximum).superRefine((values, context) => {
    const folded = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!portableRelativePath(value)) {
        context.addIssue({
          code: "custom",
          message: "path must use canonical workspace-relative POSIX syntax",
          path: [index],
        });
      }
      const key = value.toLocaleLowerCase("en-US");
      if (folded.has(key)) {
        context.addIssue({
          code: "custom",
          message: "paths must not contain case-fold duplicates",
          path: [index],
        });
      }
      folded.add(key);
    }
  });
}

export const delegationParentBindingSchema = z.object({
  sessionId: uuid,
  parentRunId: uuid,
  parentActorId: uuid,
  goalId: uuid,
  goalRevision: positiveInteger,
  planId: uuid,
  planRevision: positiveInteger,
  planSha256: sha256Schema,
  graphId: uuid.nullable(),
  graphRevision: positiveInteger.nullable(),
  graphSha256: sha256Schema.nullable(),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).nullable(),
  nodeAttemptId: uuid.nullable(),
  parentWorkspaceLineageId: sha256Schema,
}).strict().superRefine((value, context) => {
  const graphFields = [
    value.graphId,
    value.graphRevision,
    value.graphSha256,
    value.nodeId,
    value.nodeAttemptId,
  ];
  const present = graphFields.filter((field) => field !== null).length;
  if (present !== 0 && present !== graphFields.length) {
    context.addIssue({
      code: "custom",
      message: "Graph-bound parent identity must be complete or entirely null",
      path: ["graphId"],
    });
  }
});

export const delegationExpectedClaimSchema = z.object({
  claimId,
  kind: z.enum([
    "answer",
    "file_observation",
    "symbol_observation",
    "change_bundle",
    "verification_result",
  ]),
  description: boundedClaimDescription,
  required: z.boolean(),
}).strict();

export const delegationExpectedReceiptSchema = z.object({
  kind: z.enum(["analysis", "change", "verification"]),
  requiredClaims: z.array(delegationExpectedClaimSchema).min(1).max(MAX_DELEGATION_CLAIMS),
}).strict().superRefine((value, context) => {
  const ids = value.requiredClaims.map((claim) => claim.claimId);
  if (!unique(ids)) {
    context.addIssue({ code: "custom", message: "receipt claim ids must be unique" });
  }
  const required = value.requiredClaims.filter((claim) => claim.required);
  if (required.length === 0) {
    context.addIssue({ code: "custom", message: "receipt must contain at least one required claim" });
  }
  const changeClaims = required.filter((claim) => claim.kind === "change_bundle");
  const verificationClaims = required.filter((claim) => claim.kind === "verification_result");
  if (value.kind === "analysis" && changeClaims.length > 0) {
    context.addIssue({ code: "custom", message: "analysis receipt cannot require a change bundle" });
  }
  if (value.kind === "change" && changeClaims.length !== 1) {
    context.addIssue({ code: "custom", message: "change receipt requires exactly one required change bundle" });
  }
  if (value.kind === "verification" && verificationClaims.length === 0) {
    context.addIssue({ code: "custom", message: "verification receipt requires a verification result" });
  }
});

export const delegationContextFactRequestSchema = z.object({
  kind: z.enum(["receipt", "artifact", "repository_snapshot", "rule_manifest"]),
  ref: z.string().min(1).max(1024),
  sha256: sha256Schema,
  required: z.boolean(),
}).strict();

export const delegationContextRequestSchema = z.object({
  includeGoal: z.literal(true),
  includeApprovedPlanItems: z.array(planItemIdSchema).max(16).refine(unique, "Plan item ids must be unique"),
  includeParentFacts: z.array(delegationContextFactRequestSchema).max(MAX_DELEGATION_CONTEXT_REFS),
  requestedPaths: pathArray(MAX_DELEGATION_PATH_PREFIXES),
  maximumCapsuleBytes: z.number().int().min(MIN_DELEGATION_CAPSULE_BYTES).max(MAX_DELEGATION_CAPSULE_BYTES),
}).strict().superRefine((value, context) => {
  const facts = value.includeParentFacts.map((fact) => `${fact.kind}\0${fact.ref}\0${fact.sha256}`);
  if (!unique(facts)) context.addIssue({ code: "custom", message: "context fact requests must be unique" });
});

export const delegationAuthorityRequestSchema = z.object({
  taskProfile: z.enum(["read-only", "coding"]),
  toolIds: z.array(toolId).max(MAX_DELEGATION_TOOL_IDS).refine(unique, "tool ids must be unique"),
  capabilityIds: z.array(z.string().max(512)).max(MAX_DELEGATION_CAPABILITY_IDS).superRefine((values, context) => {
    if (!unique(values)) context.addIssue({ code: "custom", message: "capability ids must be unique" });
    for (const [index, value] of values.entries()) {
      try {
        parseQualifiedCapabilityId(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "capability must use a complete qualified Phase 18 identity",
          path: [index],
        });
      }
    }
  }),
}).strict();

export const delegationWorkspaceRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("origin_read_only"),
    sourceSnapshotSha256: sha256Schema,
    managedWorkspaceId: z.null(),
    declaredPathPrefixes: pathArray(MAX_DELEGATION_PATH_PREFIXES),
  }).strict(),
  z.object({
    mode: z.literal("managed_worktree"),
    sourceSnapshotSha256: sha256Schema,
    managedWorkspaceId: uuid,
    declaredPathPrefixes: pathArray(MAX_DELEGATION_PATH_PREFIXES),
  }).strict(),
]);

export const delegationModelRequestSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("same_as_parent"),
    exactProfileId: z.null(),
    exactProviderId: z.null(),
    exactModelId: z.null(),
  }).strict(),
  z.object({
    strategy: z.literal("exact_qualified_model"),
    exactProfileId: stableId,
    exactProviderId: stableId,
    exactModelId: z.string().min(1).max(500),
  }).strict(),
]);

export const delegationRetrySchema = z.object({
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
  automaticOn: z.array(z.literal("pre_effect_infrastructure_failure")).max(1).refine(unique),
}).strict().superRefine((value, context) => {
  if (value.maxAttempts === 1 && value.automaticOn.length > 0) {
    context.addIssue({ code: "custom", message: "automatic retry requires maxAttempts=2" });
  }
});

const delegationRevisionEditableFields = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().min(1).max(MAX_DELEGATIONS_PER_PARENT),
  title: boundedTitle,
  objective: boundedObjective,
  expectedReceipt: delegationExpectedReceiptSchema,
  contextRequest: delegationContextRequestSchema,
  authorityRequest: delegationAuthorityRequestSchema,
  budget: taskGraphBudgetSchema,
  workspace: delegationWorkspaceRequestSchema,
  model: delegationModelRequestSchema,
  retry: delegationRetrySchema,
} as const;

function validateRevisionSemantics(
  value: z.infer<z.ZodObject<typeof delegationRevisionEditableFields>>,
  context: z.RefinementCtx,
): void {
  if (value.expectedReceipt.kind === "analysis" && value.authorityRequest.taskProfile !== "read-only") {
    context.addIssue({ code: "custom", message: "analysis delegation requires read-only profile" });
  }
  if (value.authorityRequest.taskProfile === "read-only" && value.workspace.mode !== "origin_read_only") {
    context.addIssue({ code: "custom", message: "read-only delegation requires origin_read_only workspace" });
  }
  if (value.authorityRequest.taskProfile === "coding" && value.workspace.mode !== "managed_worktree") {
    context.addIssue({ code: "custom", message: "coding delegation requires a managed worktree" });
  }
  if (
    value.authorityRequest.taskProfile === "coding" &&
    !value.authorityRequest.toolIds.includes("finish_task")
  ) {
    context.addIssue({
      code: "custom",
      message: "coding delegation requires the package-owned finish_task completion gate",
      path: ["authorityRequest", "toolIds"],
    });
  }
  const paths = new Set(value.workspace.declaredPathPrefixes);
  for (const requested of value.contextRequest.requestedPaths) {
    const covered = [...paths].some((prefix) =>
      prefix === "." || requested === prefix || requested.startsWith(`${prefix}/`));
    if (!covered) {
      context.addIssue({
        code: "custom",
        message: "requested context path must be covered by declared workspace scope",
        path: ["contextRequest", "requestedPaths"],
      });
      break;
    }
  }
}

export const delegationRevisionDraftSchema = z
  .object(delegationRevisionEditableFields)
  .strict()
  .superRefine(validateRevisionSemantics);

export const delegationRevisionContentSchema = z.object({
  ...delegationRevisionEditableFields,
  delegationId: uuid,
  binding: delegationParentBindingSchema,
}).strict().superRefine(validateRevisionSemantics);

type ParsedDelegationRevision = z.infer<typeof delegationRevisionContentSchema>;
type DeepReadonly<T> = T extends readonly (infer TEntry)[]
  ? readonly DeepReadonly<TEntry>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export type DelegationParentBindingV1 = DeepReadonly<z.infer<typeof delegationParentBindingSchema>>;
export type DelegationExpectedReceiptV1 = DeepReadonly<z.infer<typeof delegationExpectedReceiptSchema>>;
export type DelegationContextRequestV1 = DeepReadonly<z.infer<typeof delegationContextRequestSchema>>;
export type DelegationAuthorityRequestV1 = DeepReadonly<z.infer<typeof delegationAuthorityRequestSchema>>;
export type DelegationWorkspaceRequestV1 = DeepReadonly<z.infer<typeof delegationWorkspaceRequestSchema>>;
export type DelegationModelRequestV1 = DeepReadonly<z.infer<typeof delegationModelRequestSchema>>;
export type DelegationRevisionContentV1 = DeepReadonly<ParsedDelegationRevision>;
export type DelegationRevisionDraftV1 = DeepReadonly<z.infer<typeof delegationRevisionDraftSchema>>;

function canonicalized(value: ParsedDelegationRevision): ParsedDelegationRevision {
  return {
    ...value,
    expectedReceipt: {
      ...value.expectedReceipt,
      requiredClaims: [...value.expectedReceipt.requiredClaims]
        .sort((left, right) => codePointCompare(left.claimId, right.claimId)),
    },
    contextRequest: {
      ...value.contextRequest,
      includeApprovedPlanItems: [...value.contextRequest.includeApprovedPlanItems].sort(codePointCompare),
      includeParentFacts: [...value.contextRequest.includeParentFacts].sort((left, right) =>
        codePointCompare(`${left.kind}\0${left.ref}\0${left.sha256}`, `${right.kind}\0${right.ref}\0${right.sha256}`)),
      requestedPaths: [...value.contextRequest.requestedPaths].sort(codePointCompare),
    },
    authorityRequest: {
      ...value.authorityRequest,
      toolIds: [...value.authorityRequest.toolIds].sort(codePointCompare),
      capabilityIds: [...value.authorityRequest.capabilityIds].sort(codePointCompare),
    },
    workspace: {
      ...value.workspace,
      declaredPathPrefixes: [...value.workspace.declaredPathPrefixes].sort(codePointCompare),
    },
    retry: {
      ...value.retry,
      automaticOn: [...value.retry.automaticOn].sort(codePointCompare),
    },
  };
}

export function normalizeDelegationRevision(value: unknown): DelegationRevisionContentV1 {
  const parsed = delegationRevisionContentSchema.parse(value);
  const normalized = delegationRevisionContentSchema.parse(canonicalized(parsed));
  const bytes = Buffer.byteLength(canonicalJson(normalized), "utf8");
  if (bytes > MAX_DELEGATION_REVISION_BYTES) {
    throw new DelegationError(
      "delegation_too_large",
      `delegation revision exceeds ${String(MAX_DELEGATION_REVISION_BYTES)} bytes`,
    );
  }
  return normalized as DelegationRevisionContentV1;
}

export function classifyDelegationSchemaError(error: z.ZodError): DelegationError {
  return new DelegationError(
    "delegation_invalid",
    error.issues[0]?.message ?? "delegation revision is invalid",
    { cause: error },
  );
}
