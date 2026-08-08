import { createHash } from "node:crypto";

import { z } from "zod";

import type { PatchApprovalGate } from "../approvals/patch-approval-gate.js";
import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import {
  MAX_PATCH_BYTES,
  PatchOperationError,
  type PatchApplyResult,
  type PatchPlan,
} from "../changes/patch-types.js";
import {
  createPatchRuleScopeBinding,
  type PatchRuleScopeBinding,
} from "../changes/patch-rule-scope-binding.js";
import type { RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";
import type { RepositoryRuleObservationTracker } from "../repository-rules/repository-rule-observation-binding.js";
import {
  EventPersistenceError,
  type EventPublisher,
} from "../events/event-publisher.js";
import type { RunEventDraft } from "../events/run-event.js";
import type { RunEvent } from "../events/run-event.js";
import {
  createGoalChangeRecordedData,
  type GoalChangeRecordedData,
} from "../coordination/goal-change-event-schema.js";
import { GoalChangeLedgerError } from "../coordination/goal-change-ledger.js";
import { toolError } from "./tool-errors.js";
import {
  FatalToolExecutionError,
  type ToolDefinition,
  type ToolRawResult,
} from "./tool-types.js";

export const applyPatchInputSchema = z
  .object({
    patch: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_PATCH_BYTES,
        "patch must not exceed 16 KiB",
      )
      .describe("Required. A Git-style unified text diff that creates or modifies files."),
  })
  .strict();

type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

export interface PatchPlannerLike {
  plan(patch: string): Promise<PatchPlan>;
  revalidate(plan: PatchPlan, signal?: AbortSignal): Promise<void>;
}

export interface PatchApplierLike {
  apply(plan: PatchPlan, signal: AbortSignal): Promise<PatchApplyResult>;
}

export interface ApplyPatchToolOptions {
  readonly approvalGate: PatchApprovalGate;
  readonly applier: PatchApplierLike;
  readonly now: () => number;
  readonly onApplied?: (result: PatchApplyResult) => Promise<void> | void;
  readonly planner: PatchPlannerLike;
  readonly publisher: EventPublisher;
  readonly repositoryRules?: {
    readonly assertFresh: () => Promise<void>;
    readonly resolver: RepositoryRuleScopeResolver;
    readonly tracker?: RepositoryRuleObservationTracker;
  };
  readonly goalChange?: {
    readonly artifactRuntime: ArtifactSessionRuntimeLike;
    readonly beforeCapture: (plan: PatchPlan) => Promise<void> | void;
    readonly goalId: string;
    readonly goalRevision: number;
  };
  readonly secrets?: readonly (string | undefined)[];
}

async function repositoryRulesStale(
  repositoryRules: ApplyPatchToolOptions["repositoryRules"],
): Promise<ToolRawResult | null> {
  if (repositoryRules === undefined) return null;
  try {
    await repositoryRules.assertFresh();
    return null;
  } catch {
    return {
      error: toolError(
        "permission",
        "repository_rules_stale",
        "repository rules changed after this run was frozen; start a new run",
        true,
      ),
      ok: false,
    };
  }
}

async function publishBoundary(
  publisher: EventPublisher,
  draft: RunEventDraft,
  workspaceMayHaveChanged: boolean,
): Promise<RunEvent> {
  try {
    return await publisher.publish(draft);
  } catch (error) {
    if (error instanceof EventPersistenceError) {
      throw new FatalToolExecutionError(
        "storage",
        workspaceMayHaveChanged
          ? "session storage failed after workspace mutation"
          : "session storage failed before workspace mutation",
        { cause: error, workspaceMayHaveChanged },
      );
    }
    if (workspaceMayHaveChanged) {
      throw new FatalToolExecutionError(
        "ambiguous_patch_state",
        "patch evidence failed after workspace mutation",
        { cause: error, workspaceMayHaveChanged: true },
      );
    }
    throw error;
  }
}

type CapturedGoalChangeFile = GoalChangeRecordedData["files"][number];

function imageReference(
  reference: Awaited<
    ReturnType<ArtifactSessionRuntimeLike["materializeText"]>
  >,
): CapturedGoalChangeFile["postimage"] {
  if (
    reference.eventId === undefined ||
    reference.captureStatus !== "complete" ||
    reference.captureTruncated ||
    reference.mediaType !== "text/plain; charset=utf-8"
  ) {
    throw new TypeError("Goal change image is not an exact durable text artifact");
  }
  return {
    artifact_id: reference.artifactId,
    bytes: reference.bytes,
    event_id: reference.eventId,
    object_ref: reference.objectRef,
    sha256: reference.sha256,
  };
}

async function captureGoalChangeFiles(
  options: NonNullable<ApplyPatchToolOptions["goalChange"]>,
  plan: PatchPlan,
  patchPlanEventId: string,
): Promise<readonly CapturedGoalChangeFile[]> {
  await options.beforeCapture(plan);
  const files: CapturedGoalChangeFile[] = [];
  for (const file of plan.files) {
    const preimage =
      file.kind === "create"
        ? null
        : imageReference(
            await options.artifactRuntime.materializeText({
              bytes: file.preimage,
              expectedSha256: file.preimageSha256,
              mediaType: "text/plain; charset=utf-8",
              originEventId: patchPlanEventId,
            }),
          );
    const postimage = imageReference(
      await options.artifactRuntime.materializeText({
        bytes: file.postimage,
        expectedSha256: file.postimageSha256,
        mediaType: "text/plain; charset=utf-8",
        originEventId: patchPlanEventId,
      }),
    );
    files.push({
      kind: file.kind,
      path: file.relativePath,
      postimage,
      preimage,
    });
  }
  return Object.freeze(files);
}

function resultJournalSha256(result: PatchApplyResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        files: result.files,
        planId: result.planId,
        stats: {
          addedLines: result.addedLines,
          removedLines: result.removedLines,
        },
      }),
      "utf8",
    )
    .digest("hex");
}

function patchFailure(error: PatchOperationError): ToolRawResult {
  if (error.state === "unknown") {
    throw new FatalToolExecutionError(
      "ambiguous_patch_state",
      "workspace state is ambiguous after patch failure",
      { cause: error, workspaceMayHaveChanged: true },
    );
  }
  return {
    error: toolError(
      error.category,
      error.code,
      error.message,
      error.code === "patch_stale",
    ),
    ok: false,
  };
}

export function createApplyPatchTool(
  options: ApplyPatchToolOptions,
): ToolDefinition<ApplyPatchInput> {
  return {
    capability: "mutation",
    description:
      "Propose a bounded Git-style unified diff. The host validates it and asks the user before creating or modifying files.",
    execute: async (input, context) => {
      const initialRulesFailure = await repositoryRulesStale(options.repositoryRules);
      if (initialRulesFailure !== null) return initialRulesFailure;
      if (
        (options.secrets ?? []).some(
          (secret) => secret !== undefined && secret.length > 0 && input.patch.includes(secret),
        )
      ) {
        return {
          error: toolError(
            "permission",
            "patch_contains_secret",
            "patch contains a configured secret and cannot be previewed safely",
          ),
          ok: false,
        };
      }
      let plan: PatchPlan;
      try {
        plan = await options.planner.plan(input.patch);
      } catch (error) {
        return error instanceof PatchOperationError
          ? patchFailure(error)
          : {
              error: toolError(
                "system",
                "patch_plan_failed",
                "patch could not be planned",
              ),
              ok: false,
            };
      }
      let ruleScope: PatchRuleScopeBinding | undefined;
      if (options.repositoryRules !== undefined) {
        const rulesFailure = await repositoryRulesStale(options.repositoryRules);
        if (rulesFailure !== null) return rulesFailure;
        try {
          ruleScope = createPatchRuleScopeBinding(
            options.repositoryRules.resolver,
            plan.files.map((file) => file.relativePath),
          );
          options.repositoryRules.tracker?.observe(
            plan.files.map((file) => file.relativePath),
          );
        } catch {
          return {
            error: toolError(
              "permission",
              "repository_rule_scope_invalid",
              "patch targets could not be bound to the frozen repository rules",
            ),
            ok: false,
          };
        }
      }

      const patchPlanEvent = await publishBoundary(
        options.publisher,
        {
          data: {
            added_lines: plan.addedLines,
            call_id: context.callId,
            patch_sha256: plan.patchSha256,
            paths: plan.files.map((file) => ({
              kind: file.kind,
              path: file.relativePath,
            })),
            plan_id: plan.planId,
            ...(ruleScope === undefined
              ? {}
              : {
                  rule_manifest_sha256: ruleScope.manifestSha256,
                  rule_scope_set_sha256: ruleScope.ruleScopeSetSha256,
                }),
            preview: plan.preview,
            removed_lines: plan.removedLines,
            step: context.step,
            truncated: plan.previewTruncated,
          },
          type: "patch.plan.created",
        },
        false,
      );

      let approval;
      try {
        const rulesFailure = await repositoryRulesStale(options.repositoryRules);
        if (rulesFailure !== null) return rulesFailure;
        approval = await options.approvalGate.request(
          {
            callId: context.callId,
            plan,
            ...(ruleScope === undefined ? {} : { ruleScope }),
            step: context.step,
          },
          context.signal,
        );
      } catch (error) {
        if (error instanceof EventPersistenceError) {
          throw new FatalToolExecutionError(
            "storage",
            "approval audit could not be persisted",
            { cause: error, workspaceMayHaveChanged: false },
          );
        }
        throw error;
      }

      if (approval.decision === "cancelled") {
        throw new FatalToolExecutionError(
          "user_cancelled",
          "patch approval was cancelled",
          { workspaceMayHaveChanged: false },
        );
      }
      if (approval.decision === "denied") {
        return {
          error: toolError(
            "permission",
            "patch_denied",
            "patch was not approved",
          ),
          ok: false,
        };
      }

      const approvedRulesFailure = await repositoryRulesStale(
        options.repositoryRules,
      );
      if (approvedRulesFailure !== null) return approvedRulesFailure;

      try {
        await options.planner.revalidate(plan, context.signal);
      } catch (error) {
        return error instanceof PatchOperationError
          ? patchFailure(error)
          : {
              error: toolError(
                "system",
                "patch_revalidation_failed",
                "patch could not be revalidated",
              ),
              ok: false,
            };
      }

      let capturedGoalChangeFiles: readonly CapturedGoalChangeFile[] | undefined;
      if (options.goalChange !== undefined) {
        try {
          capturedGoalChangeFiles = await captureGoalChangeFiles(
            options.goalChange,
            plan,
            patchPlanEvent.event_id,
          );
        } catch (error) {
          if (error instanceof EventPersistenceError) {
            throw new FatalToolExecutionError(
              "storage",
              "Goal change artifacts could not be persisted before patch apply",
              { cause: error, workspaceMayHaveChanged: false },
            );
          }
          return {
            error: toolError(
              error instanceof GoalChangeLedgerError &&
                error.code === "goal_change_budget_exceeded"
                ? "limit"
                : "system",
              error instanceof GoalChangeLedgerError
                ? error.code
                : "goal_change_capture_failed",
              error instanceof GoalChangeLedgerError
                ? error.message
                : "Goal change images could not be captured exactly",
            ),
            ok: false,
          };
        }
      }

      // PHASE5: apply.started 必须 durable 后才跨越副作用边界；之后任何证据失败都要报告可能已变化。
      await publishBoundary(
        options.publisher,
        {
          data: {
            approval_request_id: approval.approvalRequestId,
            call_id: context.callId,
            files: plan.files.map((file) => ({
              kind: file.kind,
              path: file.relativePath,
              post_sha256: file.postimageSha256,
              pre_sha256:
                file.kind === "create" ? null : file.preimageSha256,
            })),
            plan_id: plan.planId,
            ...(ruleScope === undefined
              ? {}
              : {
                  rule_manifest_sha256: ruleScope.manifestSha256,
                  rule_scope_set_sha256: ruleScope.ruleScopeSetSha256,
                }),
            step: context.step,
          },
          type: "patch.apply.started",
        },
        false,
      );

      const startedAt = options.now();
      let result: PatchApplyResult;
      try {
        result = await options.applier.apply(plan, context.signal);
      } catch (error) {
        // PHASE5: apply.started is already durable. Even a proven rollback ends the run so
        // an interrupted side-effect window cannot later be presented as successful.
        throw new FatalToolExecutionError(
          "ambiguous_patch_state",
          error instanceof PatchOperationError && error.state === "unchanged"
            ? "patch apply failed after the side-effect boundary and was rolled back"
            : "unexpected patch failure left workspace state unproven",
          {
            cause: error,
            workspaceMayHaveChanged:
              !(error instanceof PatchOperationError) || error.state === "unknown",
          },
        );
      }

      const completedEvent = await publishBoundary(
        options.publisher,
        {
          data: {
            added_lines: result.addedLines,
            approval_request_id: approval.approvalRequestId,
            call_id: context.callId,
            duration_ms: Math.max(0, Math.round(options.now() - startedAt)),
            files: result.files.map((file) => ({
              kind: file.kind,
              path: file.path,
              post_sha256: file.postimageSha256,
              pre_sha256:
                file.kind === "create" ? null : file.preimageSha256,
            })),
            journal_sha256: resultJournalSha256(result),
            plan_id: result.planId,
            ...(ruleScope === undefined
              ? {}
              : {
                  rule_manifest_sha256: ruleScope.manifestSha256,
                  rule_scope_set_sha256: ruleScope.ruleScopeSetSha256,
                }),
            removed_lines: result.removedLines,
            step: context.step,
          },
          type: "patch.apply.completed",
        },
        true,
      );
      if (options.goalChange !== undefined) {
        if (capturedGoalChangeFiles === undefined) {
          throw new FatalToolExecutionError(
            "ambiguous_patch_state",
            "patch completed without its required Goal change images",
            { workspaceMayHaveChanged: true },
          );
        }
        const record = createGoalChangeRecordedData({
          call_id: context.callId,
          files: [...capturedGoalChangeFiles],
          goal_id: options.goalChange.goalId,
          goal_revision: options.goalChange.goalRevision,
          patch_plan_event_id: patchPlanEvent.event_id,
          source: {
            event_id: completedEvent.event_id,
            kind: "patch_completed",
            run_id: completedEvent.run_id,
          },
        });
        try {
          await options.publisher.publishGoalChangeEvent(
            "goal.change.recorded",
            record,
          );
        } catch (error) {
          throw new FatalToolExecutionError(
            "ambiguous_patch_state",
            "patch completed but its Goal change commit record was not durable",
            { cause: error, workspaceMayHaveChanged: true },
          );
        }
      }
      try {
        await options.onApplied?.(result);
      } catch (error) {
        throw new FatalToolExecutionError(
          "ambiguous_patch_state",
          "patch was persisted but verification generation could not advance",
          { cause: error, workspaceMayHaveChanged: true },
        );
      }

      return {
        ok: true,
        truncated: false,
        value: {
          approved: true,
          files: result.files.map((file) => ({
            kind: file.kind,
            path: file.path,
            post_sha256: file.postimageSha256,
            pre_sha256:
              file.kind === "create" ? null : file.preimageSha256,
          })),
          plan_id: result.planId,
          stats: {
            added_lines: result.addedLines,
            removed_lines: result.removedLines,
          },
        },
      };
    },
    inputSchema: applyPatchInputSchema,
    name: "apply_patch",
  };
}
