import type { GitArgvRunner } from "../verification/git-argv-runner.js";
import { NodeGitArgvRunner } from "../verification/git-argv-runner.js";
import { SourceStateDigestBuilder } from "../verification/source-state-digest.js";
import { inspectDirtyPaths } from "../completion/phase7-completion-runtime.js";
import {
  createGoalExecutionBaselineData,
  type GoalExecutionBaselineCapturedData,
} from "./goal-change-event-schema.js";

export class GoalExecutionBaselineError extends Error {
  override readonly name = "GoalExecutionBaselineError";

  constructor(
    readonly code: "goal_baseline_capture_failed" | "goal_baseline_too_large",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export async function captureGoalExecutionBaseline(input: {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly gitRunner?: GitArgvRunner;
  readonly workspace: string;
}): Promise<GoalExecutionBaselineCapturedData> {
  const runner = input.gitRunner ?? new NodeGitArgvRunner();
  let sourceState;
  let dirtyPaths;
  try {
    [sourceState, dirtyPaths] = await Promise.all([
      new SourceStateDigestBuilder(runner).build(input.workspace),
      inspectDirtyPaths(input.workspace, runner),
    ]);
  } catch (error) {
    throw new GoalExecutionBaselineError(
      "goal_baseline_capture_failed",
      "could not capture the exact Goal execution baseline",
      { cause: error },
    );
  }
  if (
    dirtyPaths.length > 2_048 ||
    Buffer.byteLength(JSON.stringify(dirtyPaths), "utf8") > 256 * 1024
  ) {
    throw new GoalExecutionBaselineError(
      "goal_baseline_too_large",
      "pre-existing dirty paths exceed the fixed Goal baseline budget",
    );
  }
  try {
    return createGoalExecutionBaselineData({
      git_head_sha256: sourceState.gitHeadSha256,
      git_index_sha256: sourceState.gitIndexSha256,
      goal_id: input.goalId,
      goal_revision: input.goalRevision,
      pre_existing_dirty_paths: [...dirtyPaths],
      source_state_sha256: sourceState.sourceStateSha256,
    });
  } catch (error) {
    throw new GoalExecutionBaselineError(
      "goal_baseline_capture_failed",
      "captured Goal execution baseline failed strict validation",
      { cause: error },
    );
  }
}
