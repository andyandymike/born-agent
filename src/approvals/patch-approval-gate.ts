import type { EditApprovalMode } from "../agent/agent-types.js";
import type { PatchPlan } from "../changes/patch-types.js";
import type { EventPublisher } from "../events/event-publisher.js";
import type { ApprovalDecision, ApprovalPrompt } from "./approval-types.js";

export interface PatchApprovalGateOptions {
  readonly mode: EditApprovalMode;
  readonly prompt: ApprovalPrompt;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
}

export interface PatchApprovalRequest {
  readonly callId: string;
  readonly plan: PatchPlan;
  readonly step: number;
}

export interface PatchApprovalResult {
  readonly approvalRequestId: string;
  readonly decision: ApprovalDecision;
}

export class PatchApprovalGate {
  constructor(private readonly options: PatchApprovalGateOptions) {}

  async request(
    request: PatchApprovalRequest,
    signal: AbortSignal,
  ): Promise<PatchApprovalResult> {
    const approvalRequestId = this.options.randomUUID();
    const paths = request.plan.files.map((file) => ({
      kind: file.kind,
      path: file.relativePath,
    }));

    // PHASE5: planId 包含 patch 与 preimage hash；批准绑定它，不能授权等待期间变化的文件。
    await this.options.publisher.publish({
      data: {
        action: "apply_patch",
        added_lines: request.plan.addedLines,
        approval_request_id: approvalRequestId,
        call_id: request.callId,
        paths,
        plan_id: request.plan.planId,
        preview: request.plan.preview,
        removed_lines: request.plan.removedLines,
        step: request.step,
        truncated: request.plan.previewTruncated,
      },
      type: "approval.requested",
    });

    const decision =
      this.options.mode === "deny"
        ? "denied"
        : await this.options.prompt.request(
            {
              actionKind: "apply_patch",
              addedLines: request.plan.addedLines,
              paths,
              planId: request.plan.planId,
              preview: request.plan.preview,
              previewTruncated: request.plan.previewTruncated,
              removedLines: request.plan.removedLines,
            },
            signal,
          );

    // PHASE5: 决定先写入 durable audit；approved 事件落盘前绝不能触碰 workspace。
    await this.options.publisher.publish({
      data: {
        action: "apply_patch",
        approval_request_id: approvalRequestId,
        call_id: request.callId,
        decision,
        plan_id: request.plan.planId,
        step: request.step,
      },
      type: "approval.decided",
    });
    return { approvalRequestId, decision };
  }
}
