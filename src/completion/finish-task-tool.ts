import { z } from "zod";

import {
  EventPersistenceError,
  type EventPublisher,
} from "../events/event-publisher.js";
import { toolError } from "../tools/tool-errors.js";
import {
  FatalToolExecutionError,
  type CompletionControlSignal,
  type ToolDefinition,
} from "../tools/tool-types.js";
import { sha256Canonical } from "./canonical-json.js";
import {
  evidenceChangedPaths,
  evidenceDiffStat,
} from "./completion-evidence-bindings.js";
import { createPersistedCompletionEvidence } from "./completion-evidence-schema.js";
import {
  createCompletedRunReport,
  createIncompleteRunReport,
  renderRunReport,
} from "./completion-report-renderer.js";
import type {
  CompletionPolicy,
  CompletionState,
  FinishTaskInput,
} from "./completion-types.js";
import {
  createIncompleteEvidence,
  EvidenceLedger,
} from "./evidence-ledger.js";
import type { EffectHookPipeline } from "../hooks/hook-pipeline.js";

export const finishTaskInputSchema = z
  .object({
    status: z.enum(["completed", "blocked"]),
    summary: z
      .string()
      .refine(
        (value) =>
          !value.includes("\0") &&
          [...value].length >= 1 &&
          [...value].length <= 2_000,
        "summary must contain 1..2000 NUL-free characters",
      ),
  })
  .strict();

export interface FinishTaskToolOptions {
  readonly hooks?: EffectHookPipeline;
  readonly policy: CompletionPolicy;
  readonly publisher: EventPublisher;
  readonly state: () => Promise<CompletionState>;
}

function controlReports(
  effect: "accept" | "incomplete",
  evidence: Parameters<typeof createCompletedRunReport>[0] |
    Parameters<typeof createIncompleteRunReport>[0],
): Extract<CompletionControlSignal, { readonly effect: typeof effect }> {
  const report =
    effect === "accept"
      ? createCompletedRunReport(
          evidence as Parameters<typeof createCompletedRunReport>[0],
        )
      : createIncompleteRunReport(
          evidence as Parameters<typeof createIncompleteRunReport>[0],
        );
  return {
    effect,
    evidenceSha256: sha256Canonical(evidence),
    kind: "completion",
    ...(effect === "incomplete"
      ? {
          reason: (evidence as Parameters<typeof createIncompleteRunReport>[0])
            .reason,
        }
      : {}),
    reportJson: renderRunReport(report, "json"),
    reportSha256: report.report_hash,
    reportText: renderRunReport(report, "text"),
  } as Extract<CompletionControlSignal, { readonly effect: typeof effect }>;
}

async function publishCompletionBoundary(
  publisher: EventPublisher,
  draft: Parameters<EventPublisher["publish"]>[0],
  workspaceMayHaveChanged: boolean,
): Promise<void> {
  try {
    await publisher.publish(draft);
  } catch (error) {
    if (error instanceof EventPersistenceError) {
      throw new FatalToolExecutionError(
        "storage",
        "completion evidence could not be persisted",
        { cause: error, workspaceMayHaveChanged },
      );
    }
    throw error;
  }
}

export function createFinishTaskTool(
  options: FinishTaskToolOptions,
): ToolDefinition<FinishTaskInput> {
  return {
    capability: "mutation",
    description:
      "Propose verified completion or report that the task is blocked. The host decides from persisted change and verification evidence.",
    execute: async (candidate, context) => {
      // PHASE7: A model final is only a candidate. This adapter binds the candidate
      // to a normal tool call and asks host policy to decide from durable evidence.
      const candidateSha256 = sha256Canonical({
        callId: context.callId,
        candidate,
        step: context.step,
      });
      await publishCompletionBoundary(
        options.publisher,
        {
          data: {
            call_id: context.callId,
            candidate_sha256: candidateSha256,
            status: candidate.status,
            step: context.step,
            summary: candidate.summary,
          },
          type: "completion.candidate",
        },
        false,
      );

      try {
        let state = await options.state();
        let decision = await options.policy.evaluate(candidate, state);
        if (decision.effect === "accept" && options.hooks !== undefined) {
          const hookDecision = await options.hooks.run(
            "completion.before_commit",
            {
              action: {
                actionKind: "finish_task",
                originalActionSha256: candidateSha256,
                toolName: "finish_task",
              },
              completion: {
                changed_paths: state.changedByRun.map((change) => change.path),
                verification_count: state.verifications.length,
              },
              revalidateOriginalAction: async () => {
                const current = await options.state();
                return (await options.policy.evaluate(candidate, current)).effect === "accept";
              },
            },
            context.signal,
          );
          if (hookDecision.decision === "deny") {
            decision = { effect: "incomplete", reason: "task_blocked" };
          } else {
            state = await options.state();
            decision = await options.policy.evaluate(candidate, state);
          }
        }
        if (decision.effect === "continue") {
          await publishCompletionBoundary(
            options.publisher,
            {
              data: {
                call_id: context.callId,
                candidate_sha256: candidateSha256,
                changed_paths: state.changedByRun.map((change) => change.path),
                effect: "continue",
                reasons: [...decision.reasons],
                step: context.step,
                verification_ids: state.verifications.map(
                  (verification) =>
                    verification.verificationId ?? verification.executionId,
                ),
              },
              type: "completion.evaluated",
            },
            state.changedByRun.length > 0,
          );
          return {
            control: {
              effect: "continue",
              kind: "completion",
              reasons: decision.reasons,
            },
            error: toolError(
              "tool",
              "completion_rejected",
              `completion was rejected: ${decision.reasons.join(", ")}`,
              true,
            ),
            ok: false,
            value: { effect: "continue", reasons: decision.reasons },
          };
        }

        const proposedEvidence =
          decision.effect === "accept"
            ? decision.evidence
            : createIncompleteEvidence(state, candidate, decision.reason);
        const projection = createPersistedCompletionEvidence(proposedEvidence);
        await publishCompletionBoundary(
          options.publisher,
          { data: projection, type: "completion.evidence" },
          state.changedByRun.length > 0,
        );
        // PHASE7: Only the payload returned from a successful persistence boundary
        // becomes reportable evidence; the pre-write policy object is discarded.
        const persistedEvidence = EvidenceLedger.fromPersistedProjection(
          projection,
        ).snapshot();
        const persistedChangedPaths = evidenceChangedPaths(persistedEvidence);
        const persistedDiffStat = evidenceDiffStat(persistedEvidence);
        const control =
          decision.effect === "accept"
            ? controlReports(
                "accept",
                persistedEvidence as Parameters<
                  typeof createCompletedRunReport
                >[0],
              )
            : controlReports(
                "incomplete",
                persistedEvidence as Parameters<
                  typeof createIncompleteRunReport
                >[0],
              );
        await publishCompletionBoundary(
          options.publisher,
          {
            data: {
              call_id: context.callId,
              candidate_sha256: candidateSha256,
              changed_paths: [...persistedChangedPaths],
              // PHASE7: the evaluation summary is derived from the payload that
              // survived persistence, never from a pre-write mutable state view.
              diff_stat: persistedDiffStat,
              effect: decision.effect,
              evidence_sha256: control.evidenceSha256,
              reasons:
                decision.effect === "incomplete" ? [decision.reason] : [],
              report_sha256: control.reportSha256,
              step: context.step,
              verification_ids: persistedEvidence.verifications.map(
                (verification) =>
                  verification.verificationId ?? verification.executionId,
              ),
            },
            type: "completion.evaluated",
          },
          persistedChangedPaths.length > 0,
        );
        return {
          control,
          ok: true,
          truncated: false,
          value: {
            effect: decision.effect,
            evidence_sha256: control.evidenceSha256,
            report_sha256: control.reportSha256,
            ...(decision.effect === "incomplete"
              ? { reason: decision.reason }
              : {}),
          },
        };
      } catch (error) {
        // PHASE7: Once candidate is durable, every ordinary evaluator failure must
        // close that candidate explicitly. Storage failures remain fatal because a
        // failed writer cannot safely be retried or followed by a fabricated terminal.
        if (error instanceof FatalToolExecutionError) throw error;
        await publishCompletionBoundary(
          options.publisher,
          {
            data: {
              call_id: context.callId,
              candidate_sha256: candidateSha256,
              changed_paths: [],
              effect: "error",
              error_code: "completion_evaluation_failed",
              reasons: [],
              step: context.step,
              verification_ids: [],
            },
            type: "completion.evaluated",
          },
          true,
        );
        return {
          error: toolError(
            "system",
            "completion_evaluation_failed",
            "completion evaluation failed",
            false,
          ),
          ok: false,
          value: {
            effect: "error",
            error_code: "completion_evaluation_failed",
          },
        };
      }
    },
    inputSchema: finishTaskInputSchema,
    name: "finish_task",
  };
}
