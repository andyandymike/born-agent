import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalPrompt,
} from "../../../../src/approvals/approval-types.js";
import type { DevelopmentPilotCase } from "./development-pilot-fixture.js";

export interface DevelopmentPilotApprovalObservation {
  readonly actionKind: ApprovalPreview["actionKind"];
  readonly decision: ApprovalDecision;
}

export class DevelopmentPilotExactApprovalPrompt implements ApprovalPrompt {
  readonly #observations: DevelopmentPilotApprovalObservation[] = [];

  constructor(private readonly caseInput: DevelopmentPilotCase) {}

  get observations(): readonly DevelopmentPilotApprovalObservation[] {
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
    this.#observations.push(Object.freeze({ actionKind: preview.actionKind, decision }));
    return decision;
  }

  #matches(preview: ApprovalPreview): boolean {
    if (preview.actionKind === "apply_patch") {
      return (
        preview.paths.length === 1 &&
        preview.paths[0]?.kind === "modify" &&
        preview.paths[0].path === this.caseInput.targetRelativePath &&
        preview.addedLines >= 1 &&
        preview.addedLines <= 8 &&
        preview.removedLines >= 1 &&
        preview.removedLines <= 8 &&
        !preview.previewTruncated
      );
    }
    if (preview.actionKind === "run_command") {
      return (
        preview.executable === this.caseInput.verifier.argv[0] &&
        preview.args.length === 1 &&
        preview.args[0] === this.caseInput.verifier.argv[1] &&
        preview.cwd === this.caseInput.verifier.cwd &&
        preview.executor === "local" &&
        preview.purpose === "verify"
      );
    }
    return false;
  }
}
