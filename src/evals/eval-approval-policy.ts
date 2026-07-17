import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { decideTaskChangedPath, matchesEvalAgentCommand, type EvalAgentCommand, type EvalTaskManifest } from "./eval-task-schema.js";

export interface EvalApprovalDecision {
  readonly decision: "approved" | "denied";
  readonly decisionSource: "eval_policy";
  readonly reasonCode: string;
  readonly wouldAsk: boolean;
}

export class EvalApprovalPolicy {
  readonly bindingSha256: string;

  public constructor(
    private readonly manifest: EvalTaskManifest,
    private readonly disposableWorkspaceId: string,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(disposableWorkspaceId)) {
      throw new EvalCoreError("eval_harness_invariant", "invalid disposable eval workspace identity", 1);
    }
    this.bindingSha256 = sha256Canonical({
      disposableWorkspaceId,
      taskId: manifest.id,
      taskVersion: manifest.task_version,
      allowedChanges: manifest.allowed_changes,
      agentCommands: manifest.agent_commands,
    });
  }

  public decidePatch(input: {
    readonly disposableWorkspaceId: string;
    readonly paths: readonly string[];
    readonly changedLines: number;
  }): EvalApprovalDecision {
    // PHASE14: unattended auto-approval is scoped to one disposable attempt and cannot be selected by the normal Agent CLI.
    if (
      input.disposableWorkspaceId !== this.disposableWorkspaceId ||
      input.paths.length > this.manifest.allowed_changes.max_files ||
      input.changedLines > this.manifest.allowed_changes.max_changed_lines ||
      input.paths.some((path) => decideTaskChangedPath(this.manifest, path) !== "allowed")
    ) {
      return Object.freeze({ decision: "denied", decisionSource: "eval_policy", reasonCode: "eval_patch_outside_scope", wouldAsk: true });
    }
    return Object.freeze({ decision: "approved", decisionSource: "eval_policy", reasonCode: "eval_disposable_patch_exact", wouldAsk: true });
  }

  public decideCommand(input: {
    readonly disposableWorkspaceId: string;
    readonly command: EvalAgentCommand;
    readonly executor: "docker_v1" | "local";
    readonly network: "none" | "host";
  }): EvalApprovalDecision {
    if (
      input.disposableWorkspaceId !== this.disposableWorkspaceId ||
      input.executor !== "docker_v1" ||
      input.network !== "none" ||
      !matchesEvalAgentCommand(this.manifest.agent_commands, input.command)
    ) {
      return Object.freeze({ decision: "denied", decisionSource: "eval_policy", reasonCode: "eval_command_not_exact", wouldAsk: true });
    }
    return Object.freeze({ decision: "approved", decisionSource: "eval_policy", reasonCode: "eval_command_exact", wouldAsk: true });
  }
}
