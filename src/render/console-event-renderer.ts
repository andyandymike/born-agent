import type { CliIO } from "../cli/types.js";
import type { RunEvent } from "../events/run-event.js";
import type { RunEventRenderer } from "../events/event-publisher.js";

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export class ConsoleEventRenderer implements RunEventRenderer {
  private hasOutput = false;
  private outputEndsWithNewline = false;

  constructor(
    private readonly io: CliIO,
    private readonly verbose: boolean,
  ) {}

  render(event: RunEvent): void {
    // PHASE2: renderer 只决定“事件怎么显示”，不决定事件是否合法或是否保存。
    // 文本走 stdout，诊断/元数据走 stderr，方便 shell 分别重定向两类输出。
    switch (event.type) {
      case "run.started":
        if (this.verbose) {
          this.io.stderr.write(
            `session=${event.session_id} run=${event.run_id} provider=${event.data.provider} model=${oneLine(event.data.model)}\n`,
          );
        }
        return;
      case "text.delta":
        this.io.stdout.write(event.data.delta);
        this.hasOutput = true;
        this.outputEndsWithNewline = event.data.delta.endsWith("\n");
        return;
      case "usage":
        if (this.verbose) {
          const cached =
            event.data.cached_input_tokens === undefined
              ? ""
              : ` cached_input_tokens=${event.data.cached_input_tokens}`;
          this.io.stderr.write(
            `input_tokens=${event.data.input_tokens} output_tokens=${event.data.output_tokens} total_tokens=${event.data.total_tokens}${cached}${event.data.model_turns === undefined ? "" : ` model_turns=${event.data.model_turns}`}${event.data.usage_incomplete === true ? " usage_incomplete=true" : ""}\n`,
          );
        }
        return;
      case "tool.call.requested":
        if (this.verbose) {
          this.io.stderr.write(`tool=${event.data.tool_name} requested\n`);
        }
        return;
      case "tool.call.completed":
        if (this.verbose) {
          this.io.stderr.write(
            `tool=${event.data.tool_name} status=${event.data.status} duration_ms=${event.data.duration_ms}${event.data.truncated ? " truncated=true" : ""}\n`,
          );
        }
        return;
      case "run.completed":
        if (!this.hasOutput) {
          this.io.stdout.write("\n");
          this.hasOutput = true;
          this.outputEndsWithNewline = true;
        } else {
          this.ensureOutputLine();
        }
        if (this.verbose) {
          const responseId =
            event.data.provider_response_id === undefined
              ? ""
              : ` response_id=${oneLine(event.data.provider_response_id)}`;
          this.io.stderr.write(
            `completed duration_ms=${event.data.duration_ms} output_chars=${event.data.output_chars}${responseId}${event.data.model_turns === undefined ? "" : ` model_turns=${event.data.model_turns}`}${event.data.tool_calls === undefined ? "" : ` tool_calls=${event.data.tool_calls}`}\n`,
          );
        }
        return;
      case "run.failed":
        this.ensureOutputLine();
        this.io.stderr.write(`${event.data.message}\n`);
        return;
      case "run.cancelled":
        this.ensureOutputLine();
        this.io.stderr.write("Cancelled\n");
        return;
    }
  }

  renderStorageError(): void {
    this.ensureOutputLine();
    this.io.stderr.write("session storage failed\n");
  }

  renderDiagnostic(message: string): void {
    this.ensureOutputLine();
    this.io.stderr.write(`${oneLine(message)}\n`);
  }

  private ensureOutputLine(): void {
    if (this.hasOutput && !this.outputEndsWithNewline) {
      this.io.stdout.write("\n");
      this.outputEndsWithNewline = true;
    }
  }
}
