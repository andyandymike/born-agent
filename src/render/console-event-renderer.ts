import type { CliIO } from "../cli/types.js";
import type { RunEvent } from "../events/run-event.js";
import type { RunEventRenderer } from "../events/event-publisher.js";

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export class ConsoleEventRenderer implements RunEventRenderer {
  private hasOutput = false;
  private outputEndsWithNewline = false;
  private taskProfile: "read-only" | "coding" | undefined;

  constructor(
    private readonly io: CliIO,
    private readonly verbose: boolean,
  ) {}

  render(event: RunEvent): void {
    // PHASE2: renderer 只决定“事件怎么显示”，不决定事件是否合法或是否保存。
    // 文本走 stdout，诊断/元数据走 stderr，方便 shell 分别重定向两类输出。
    switch (event.type) {
      case "run.started":
        if (event.data.command === "agent") {
          this.taskProfile = event.data.task_profile ?? "read-only";
        } else {
          this.taskProfile = undefined;
        }
        if (this.verbose) {
          this.io.stderr.write(
            `session=${event.session_id} run=${event.run_id} provider=${event.data.provider} model=${oneLine(event.data.model)}${event.data.command === "agent" && event.data.task_profile !== undefined ? ` task_profile=${event.data.task_profile}` : ""}\n`,
          );
        }
        return;
      case "text.delta":
        // PHASE7: coding prose is persisted as an internal candidate; only the
        // deterministic report rendered after durable completion may claim success.
        if (
          this.taskProfile === "coding" ||
          event.data.visibility === "internal_candidate"
        ) {
          return;
        }
        this.io.stdout.write(event.data.delta);
        this.hasOutput = true;
        this.outputEndsWithNewline = event.data.delta.endsWith("\n");
        return;
      case "agent.step.started":
        // PHASE4: verbose 只显示预算元数据；默认 stdout 仍只包含模型文本。
        if (this.verbose) {
          this.io.stderr.write(
            `step=${event.data.step}/${event.data.max_steps} started input=${event.data.input_kind} remaining_duration_ms=${event.data.remaining_duration_ms} remaining_tokens=${event.data.remaining_tokens} remaining_tool_output_bytes=${event.data.remaining_tool_output_bytes}\n`,
          );
        }
        return;
      case "model.usage":
        // PHASE4: step usage 与末尾聚合 usage 分开显示，便于定位哪一步消耗异常。
        if (this.verbose) {
          const cached =
            event.data.cached_input_tokens === undefined
              ? ""
              : ` cached_input_tokens=${event.data.cached_input_tokens}`;
          this.io.stderr.write(
            `step=${event.data.step} input_tokens=${event.data.input_tokens} output_tokens=${event.data.output_tokens} total_tokens=${event.data.total_tokens}${cached}\n`,
          );
        }
        return;
      case "agent.step.completed":
        // PHASE4: outcome=tool_call 表示 run 继续；outcome=final 才可能进入成功终态。
        if (this.verbose) {
          this.io.stderr.write(
            `step=${event.data.step} outcome=${event.data.outcome} duration_ms=${event.data.duration_ms} text_chars=${event.data.text_chars}\n`,
          );
        }
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
        // PHASE3: 默认模式不显示参数；verbose 也只显示工具名，不泄露 prompt 派生内容。
        if (this.verbose) {
          this.io.stderr.write(`tool=${event.data.tool_name} requested\n`);
        }
        return;
      case "tool.call.completed":
        // PHASE3: 工具正文只进入受控 session/模型上下文，终端元数据仅显示状态与耗时。
        if (this.verbose) {
          this.io.stderr.write(
            `tool=${event.data.tool_name} status=${event.data.status} duration_ms=${event.data.duration_ms}${event.data.truncated ? " truncated=true" : ""}\n`,
          );
        }
        return;
      case "patch.plan.created":
        if (this.verbose) {
          this.io.stderr.write(
            `patch plan=${event.data.plan_id.slice(0, 12)} files=${event.data.paths.length} +${event.data.added_lines} -${event.data.removed_lines}${event.data.truncated ? " preview_truncated=true" : ""}\n`,
          );
        }
        return;
      case "approval.requested":
        if (this.verbose) {
          this.io.stderr.write(
            `approval=${event.data.approval_request_id} requested action=${event.data.action}\n`,
          );
        }
        return;
      case "approval.decided":
        if (this.verbose) {
          this.io.stderr.write(
            `approval=${event.data.approval_request_id} decision=${event.data.decision}\n`,
          );
        }
        return;
      case "permission.evaluated":
        if (this.verbose) {
          this.io.stderr.write(
            `permission effect=${event.data.effect} rule=${event.data.rule_id} policy=${event.data.policy_version} action=${event.data.action_sha256.slice(0, 12)}${event.data.reason_code === undefined ? "" : ` reason=${event.data.reason_code}`}\n`,
          );
        }
        return;
      case "command.execution.requested":
        // PHASE6: renderer only sees redacted argv after persistence; it never renders host executable paths or env values.
        if (this.verbose) {
          const args = event.data.redacted_argv
            .map((argument) => JSON.stringify(oneLine(argument)))
            .join(" ");
          this.io.stderr.write(
            `command=${args} cwd=${event.data.cwd} purpose=${event.data.purpose} execution=${event.data.execution_id}\n`,
          );
        }
        return;
      case "command.started":
        if (this.verbose) {
          this.io.stderr.write(
            `command execution=${event.data.execution_id} status=started\n`,
          );
        }
        return;
      case "command.output":
        if (this.verbose) {
          const suffix = event.data.chunk.endsWith("\n") ? "" : "\n";
          this.io.stderr.write(
            `command ${event.data.channel}[${event.data.chunk_index}] ${event.data.chunk}${suffix}`,
          );
        }
        return;
      case "command.completed":
        if (this.verbose) {
          this.io.stderr.write(
            `command execution=${event.data.execution_id} termination=${event.data.termination} exit_code=${event.data.exit_code === null ? "none" : event.data.exit_code} duration_ms=${event.data.duration_ms} stdout_bytes=${event.data.stdout_bytes} stderr_bytes=${event.data.stderr_bytes}${event.data.truncated ? " truncated=true" : ""}\n`,
          );
        }
        return;
      case "verification.started":
        if (this.verbose) {
          this.io.stderr.write(
            `verification=${event.data.verification_id} status=started kind=${event.data.kind} generation=${event.data.generation} execution=${event.data.command_execution_id} snapshot=${event.data.snapshot_sha256.slice(0, 12)}\n`,
          );
        }
        return;
      case "verification.completed":
        if (this.verbose) {
          this.io.stderr.write(
            `verification=${event.data.verification_id} status=${event.data.status} exit_code=${event.data.exit_code === null ? "none" : event.data.exit_code} generation=${event.data.started_generation}->${event.data.completed_generation} duration_ms=${event.data.duration_ms}${event.data.stale ? " stale=true" : ""}\n`,
          );
        }
        return;
      case "completion.candidate":
        if (this.verbose) {
          this.io.stderr.write(
            `completion call=${event.data.call_id} candidate=${event.data.status} hash=${event.data.candidate_sha256.slice(0, 12)}\n`,
          );
        }
        return;
      case "completion.evaluated":
        if (this.verbose) {
          this.io.stderr.write(
            `completion call=${event.data.call_id} effect=${event.data.effect}${event.data.reasons.length === 0 ? "" : ` reasons=${event.data.reasons.join(",")}`}\n`,
          );
        }
        return;
      case "patch.apply.started":
        if (this.verbose) {
          this.io.stderr.write(
            `patch plan=${event.data.plan_id.slice(0, 12)} apply=started\n`,
          );
        }
        return;
      case "patch.apply.completed":
        if (this.verbose) {
          this.io.stderr.write(
            `patch plan=${event.data.plan_id.slice(0, 12)} apply=completed duration_ms=${event.data.duration_ms}\n`,
          );
        }
        return;
      case "run.completed":
        if (event.data.completion_mode !== "verified_finish_task") {
          if (!this.hasOutput) {
            this.io.stdout.write("\n");
            this.hasOutput = true;
            this.outputEndsWithNewline = true;
          } else {
            this.ensureOutputLine();
          }
        }
        if (this.verbose) {
          const responseId =
            event.data.provider_response_id === undefined
              ? ""
              : ` response_id=${oneLine(event.data.provider_response_id)}`;
          this.io.stderr.write(
            `completed duration_ms=${event.data.duration_ms} output_chars=${event.data.output_chars}${responseId}${event.data.completion_mode === undefined ? "" : ` completion_mode=${event.data.completion_mode}`}${event.data.model_turns === undefined ? "" : ` model_turns=${event.data.model_turns}`}${event.data.steps === undefined ? "" : ` steps=${event.data.steps}`}${event.data.tool_calls === undefined ? "" : ` tool_calls=${event.data.tool_calls}`}\n`,
          );
        }
        return;
      case "run.incomplete":
        // PHASE7: an evidence-based incomplete terminal is actionable task state,
        // while run.failed remains reserved for provider/storage/program failure.
        this.ensureOutputLine();
        this.io.stderr.write(`Incomplete: ${event.data.reason}\n`);
        return;
      case "run.failed":
        this.ensureOutputLine();
        this.io.stderr.write(`${event.data.message}\n`);
        return;
      case "run.cancelled":
        this.ensureOutputLine();
        this.io.stderr.write("Cancelled\n");
        return;
      case "run.budget_exceeded":
        // PHASE4: 预算停止不是 provider/internal error，使用独立、可操作的终端提示。
        this.ensureOutputLine();
        this.io.stderr.write(
          `Agent stopped: ${event.data.reason} reached (${event.data.limit})\n`,
        );
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
