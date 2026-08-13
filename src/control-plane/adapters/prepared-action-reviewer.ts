import type { CliIO, CliRuntime } from "../../cli/types.js";
import type { ApplicationActionTargetV1 } from "../application-protocol.js";
import type { PreparedActionResponseV1 } from "../application-service.js";

/** The exact Host-built bytes an interactive surface reviews before commit. */
export interface PreparedApplicationActionReviewV1 {
  readonly actionKind: string;
  readonly displaySha256: string;
  readonly expiresAt: string;
  readonly preparedActionId: string;
  readonly preparedActionSha256: string;
  readonly summary: string;
  readonly target: ApplicationActionTargetV1;
  readonly warnings: readonly string[];
}

export type PreparedApplicationActionReviewDecisionV1 =
  | "cancelled"
  | "confirmed"
  | "expired"
  | "stale";

export type PreparedApplicationActionReviewerV1 = (
  review: PreparedApplicationActionReviewV1,
) => Promise<PreparedApplicationActionReviewDecisionV1>;

const reviewers = new WeakMap<CliRuntime, PreparedApplicationActionReviewerV1>();

/**
 * PHASE21: this process-local presentation port carries no authorization of
 * its own. The Host-created prepared id/hash remains the exact commit token.
 */
export function registerPreparedApplicationActionReviewer(
  runtime: CliRuntime,
  reviewer: PreparedApplicationActionReviewerV1,
): () => void {
  reviewers.set(runtime, reviewer);
  return () => {
    if (reviewers.get(runtime) === reviewer) reviewers.delete(runtime);
  };
}

export async function reviewPreparedApplicationAction(input: {
  readonly io: CliIO;
  readonly prepared: PreparedActionResponseV1;
  readonly runtime: CliRuntime;
  readonly surface: "cli" | "tui";
}): Promise<PreparedApplicationActionReviewDecisionV1> {
  const confirmation = input.prepared.prepared.confirmation;
  if (confirmation === "none") return "confirmed";
  if (confirmation === "explicit_human") return "cancelled";
  const reviewer = input.surface === "tui" ? reviewers.get(input.runtime) : undefined;
  if (reviewer !== undefined) {
    return reviewer(Object.freeze({
      actionKind: input.prepared.prepared.actionKind,
      displaySha256: input.prepared.display.displaySha256,
      expiresAt: input.prepared.prepared.expiresAt,
      preparedActionId: input.prepared.prepared.preparedActionId,
      preparedActionSha256: input.prepared.prepared.preparedActionSha256,
      summary: input.prepared.display.summary,
      target: input.prepared.prepared.target,
      warnings: input.prepared.display.warnings,
    }));
  }
  input.io.stderr.write(`${input.prepared.display.summary}\n`);
  for (const warning of input.prepared.display.warnings) {
    input.io.stderr.write(`warning: ${warning}\n`);
  }
  return "confirmed";
}

export function preparedReviewFailure(
  decision: Exclude<PreparedApplicationActionReviewDecisionV1, "confirmed">,
): Readonly<{
  readonly code:
    | "control_authorization_denied"
    | "control_prepared_action_expired"
    | "control_stale_projection";
  readonly exitCode: 2 | 8;
  readonly message: string;
}> {
  if (decision === "expired") {
    return Object.freeze({
      code: "control_prepared_action_expired",
      exitCode: 8,
      message: "prepared action expired before commit; prepare the action again",
    });
  }
  if (decision === "stale") {
    return Object.freeze({
      code: "control_stale_projection",
      exitCode: 8,
      message: "prepared action became stale before commit; prepare the action again",
    });
  }
  return Object.freeze({
    code: "control_authorization_denied",
    exitCode: 2,
    message: "prepared action was cancelled before commit",
  });
}
