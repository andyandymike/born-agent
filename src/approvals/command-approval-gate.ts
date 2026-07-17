import type { CommandApprovalMode } from "../agent/agent-types.js";
import type { EventPublisher } from "../events/event-publisher.js";
import type { ApprovalDecision, ApprovalPrompt } from "./approval-types.js";

export interface CommandApprovalGateOptions {
  readonly mode: CommandApprovalMode;
  readonly prompt: ApprovalPrompt;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
}

export interface CommandApprovalRequest {
  readonly actionSha256: string;
  readonly args: readonly string[];
  readonly callId: string;
  readonly cwd: string;
  readonly executor?: "docker" | "local";
  readonly executable: string;
  readonly purpose: "inspect" | "verify";
  readonly reviewLines?: readonly string[];
  readonly riskWarning?: string;
  readonly step: number;
}

export interface CommandApprovalResult {
  readonly approvalRequestId: string;
  readonly decision: ApprovalDecision;
}

export class CommandApprovalGate {
  constructor(private readonly options: CommandApprovalGateOptions) {}

  async request(
    request: CommandApprovalRequest,
    signal: AbortSignal,
  ): Promise<CommandApprovalResult> {
    const approvalRequestId = this.options.randomUUID();
    const previewSource = [
      `cwd: ${request.cwd}`,
      `executor: ${request.executor ?? "local"}`,
      `executable: ${request.executable}`,
      ...request.args.map((argument, index) => `argv[${index}]: ${argument}`),
      ...(request.reviewLines ?? []).map((line) => `review: ${line}`),
      `purpose: ${request.purpose}`,
      `WARNING: ${
        request.riskWarning ??
        "repository code may perform additional host side effects"
      }`,
    ].join("\n");
    const preview = truncateUtf8(previewSource, 32 * 1024);

    await this.options.publisher.publish({
      data: {
        action: "run_command",
        action_kind: "run_command",
        action_sha256: request.actionSha256,
        approval_request_id: approvalRequestId,
        call_id: request.callId,
        cwd: request.cwd,
        executable: request.executable,
        preview,
        purpose: request.purpose,
        redacted_argv: [request.executable, ...request.args],
        step: request.step,
        truncated: preview !== previewSource,
      },
      type: "approval.requested",
    });

    const decision =
      this.options.mode === "deny"
        ? "denied"
        : await this.options.prompt.request(
            {
              actionKind: "run_command",
              actionSha256: request.actionSha256,
              args: request.args,
              cwd: request.cwd,
              executor: request.executor ?? "local",
              executable: request.executable,
              purpose: request.purpose,
              reviewLines: request.reviewLines ?? [],
              riskWarning:
                request.riskWarning ??
                "repository code may perform additional host side effects; LocalExecutor is not a sandbox",
            },
            signal,
          );

    // PHASE6: approval is bound to the immutable action digest and durable before spawn;
    // a visually similar display string is never authority.
    await this.options.publisher.publish({
      data: {
        action: "run_command",
        action_kind: "run_command",
        action_sha256: request.actionSha256,
        approval_request_id: approvalRequestId,
        call_id: request.callId,
        decision,
        step: request.step,
      },
      type: "approval.decided",
    });
    return { approvalRequestId, decision };
  }
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    output += character;
    bytes += size;
  }
  return output;
}
