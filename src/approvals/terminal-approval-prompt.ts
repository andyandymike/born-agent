import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalPrompt,
  TerminalApprovalPromptOptions,
} from "./approval-types.js";

export class TerminalApprovalPrompt implements ApprovalPrompt {
  constructor(private readonly options: TerminalApprovalPromptOptions) {}

  async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    // PHASE5: preview 和 prompt 只写 stderr；stdout 必须继续只承载模型最终文本。
    this.options.output.write(
      `Apply patch to ${preview.paths.length} file${preview.paths.length === 1 ? "" : "s"} (+${preview.addedLines} -${preview.removedLines})?\n`,
    );
    for (const target of preview.paths) {
      this.options.output.write(`  ${target.kind} ${target.path}\n`);
    }
    this.options.output.write(`  plan ${preview.planId.slice(0, 12)}\n`);
    if (preview.preview.length > 0) {
      this.options.output.write(`${preview.preview}\n`);
    }
    if (preview.previewTruncated) {
      this.options.output.write("  [diff preview truncated]\n");
    }

    if (!this.options.interactive) {
      this.options.output.write("Approval denied: interactive stdin/stderr required.\n");
      return "denied";
    }
    if (signal.aborted) return "cancelled";
    this.options.output.write("Apply patch? [y/N] ");
    const answer = await this.options.readLine(signal);
    if (signal.aborted) return "cancelled";
    return answer?.trim().toLowerCase() === "y" ? "approved" : "denied";
  }
}
