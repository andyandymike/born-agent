import { createHash } from "node:crypto";

import { z } from "zod";

import type { PatchApprovalGate } from "../approvals/patch-approval-gate.js";
import {
  MAX_PATCH_BYTES,
  PatchOperationError,
  type PatchApplyResult,
  type PatchPlan,
} from "../changes/patch-types.js";
import {
  EventPersistenceError,
  type EventPublisher,
} from "../events/event-publisher.js";
import type { RunEventDraft } from "../events/run-event.js";
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
  readonly planner: PatchPlannerLike;
  readonly publisher: EventPublisher;
  readonly secrets?: readonly (string | undefined)[];
}

async function publishBoundary(
  publisher: EventPublisher,
  draft: RunEventDraft,
  workspaceMayHaveChanged: boolean,
): Promise<void> {
  try {
    await publisher.publish(draft);
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

      await publishBoundary(
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
        approval = await options.approvalGate.request(
          { callId: context.callId, plan, step: context.step },
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
              pre_sha256:
                file.kind === "create" ? null : file.preimageSha256,
            })),
            plan_id: plan.planId,
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

      await publishBoundary(
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
            removed_lines: result.removedLines,
            step: context.step,
          },
          type: "patch.apply.completed",
        },
        true,
      );

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
