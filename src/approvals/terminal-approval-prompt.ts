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
    if (preview.actionKind === "apply_patch") {
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
    } else if (preview.actionKind === "run_command") {
      // PHASE6: argv 逐项显示，避免 shell-like display 把授权内容变成另一条命令。
      this.options.output.write(
        preview.executor === "docker"
          ? "Allow command in Docker sandbox?\n"
          : "Allow command locally?\n",
      );
      this.options.output.write(`  cwd: ${preview.cwd}\n`);
      this.options.output.write(`  executable: ${preview.executable}\n`);
      preview.args.forEach((argument, index) => {
        this.options.output.write(`  argv[${index}]: ${argument}\n`);
      });
      preview.reviewLines.forEach((line) => {
        this.options.output.write(`  reviewed: ${line}\n`);
      });
      this.options.output.write(`  purpose: ${preview.purpose}\n`);
      this.options.output.write(`  action: ${preview.actionSha256.slice(0, 12)}\n`);
      this.options.output.write(`  WARNING: ${preview.riskWarning}\n`);
    } else {
      this.options.output.write(`${preview.title}\n`);
      preview.reviewLines.forEach((line) => {
        this.options.output.write(`  ${line}\n`);
      });
      this.options.output.write(`  action: ${preview.actionSha256.slice(0, 12)}\n`);
      this.options.output.write(`  WARNING: ${preview.riskWarning}\n`);
    }

    if (!this.options.interactive) {
      this.options.output.write("Approval denied: interactive stdin/stderr required.\n");
      return "denied";
    }
    if (signal.aborted) return "cancelled";
    this.options.output.write(
      preview.actionKind === "apply_patch"
        ? "Apply patch? [y/N] "
        : preview.actionKind === "run_command"
          ? preview.executor === "docker"
            ? "Allow command in Docker sandbox? [y/N] "
            : "Allow command locally? [y/N] "
          : "Approve MCP action? [y/N] ",
    );
    const answer = await this.options.readLine(signal);
    if (signal.aborted) return "cancelled";
    return answer?.trim().toLowerCase() === "y" ? "approved" : "denied";
  }
}
