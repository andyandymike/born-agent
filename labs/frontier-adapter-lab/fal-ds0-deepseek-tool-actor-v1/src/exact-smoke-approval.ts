import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalPrompt,
} from "../../../../src/approvals/approval-types.js";
import {
  DS0_PUBLIC_SMOKE_TARGET,
  DS0_PUBLIC_SMOKE_VERIFY_ARGV,
  DS0_PUBLIC_SMOKE_VERIFY_CWD,
} from "./public-smoke-workspace.js";

export interface Ds0ApprovalObservation {
  readonly actionKind: ApprovalPreview["actionKind"];
  readonly decision: ApprovalDecision;
}

export class Ds0ExactSmokeApprovalPrompt implements ApprovalPrompt {
  readonly #observations: Ds0ApprovalObservation[] = [];

  get observations(): readonly Ds0ApprovalObservation[] {
    return Object.freeze(this.#observations.map((entry) => Object.freeze({ ...entry })));
  }

  async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const decision = signal.aborted
      ? "cancelled"
      : this.#matches(preview)
        ? "approved"
        : "denied";
    this.#observations.push(Object.freeze({
      actionKind: preview.actionKind,
      decision,
    }));
    return decision;
  }

  #matches(preview: ApprovalPreview): boolean {
    if (preview.actionKind === "apply_patch") {
      return (
        preview.paths.length === 1 &&
        preview.paths[0]?.kind === "modify" &&
        preview.paths[0].path === DS0_PUBLIC_SMOKE_TARGET &&
        preview.addedLines >= 1 &&
        preview.addedLines <= 8 &&
        preview.removedLines >= 1 &&
        preview.removedLines <= 8 &&
        !preview.previewTruncated
      );
    }
    if (preview.actionKind === "run_command") {
      return (
        preview.executable === DS0_PUBLIC_SMOKE_VERIFY_ARGV[0] &&
        preview.args.length === 1 &&
        preview.args[0] === DS0_PUBLIC_SMOKE_VERIFY_ARGV[1] &&
        preview.cwd === DS0_PUBLIC_SMOKE_VERIFY_CWD &&
        preview.executor === "local" &&
        preview.purpose === "verify"
      );
    }
    return false;
  }
}
