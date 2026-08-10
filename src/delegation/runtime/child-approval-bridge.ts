import type { ApprovalDecision, ApprovalPreview, ApprovalPrompt } from "../../approvals/approval-types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import type { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import { DelegationError } from "../delegation-errors.js";
import type { ExecutableChildEnvelopeV1 } from "./executable-child-envelope.js";
import {
  assertBoundedProtocolFrame,
  delegationChildApprovalDecisionFrameSchema,
} from "./child-handshake-schema.js";

export interface DelegationChildControlChannelV1 {
  readonly connected: boolean;
  send(frame: unknown): void;
  onMessage(listener: (frame: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
}

export class DelegatedChildApprovalBridge implements ApprovalPrompt {
  constructor(private readonly input: {
    readonly channel: DelegationChildControlChannelV1;
    readonly envelope: ExecutableChildEnvelopeV1;
    readonly randomUuid: () => string;
    readonly writer: V2SessionWriter;
  }) {}

  async request(preview: ApprovalPreview, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted || !this.input.channel.connected) return "cancelled";
    const actor = this.input.envelope.prepared.actor;
    const approvalRequestId = this.input.randomUuid();
    // PHASE20: parent/sibling approvals cannot match because the digest binds
    // the child actor, attempt, workspace, and fresh approval namespace.
    const actionDigest = sha256Canonical({
      action: preview,
      approval_namespace: this.input.envelope.prepared.approvalNamespace,
      actor_id: actor.actorId,
      attempt_id: actor.attemptId,
      delegation_sha256: actor.delegationSha256,
      workspace: this.input.envelope.prepared.workspace,
    });
    await this.input.writer.appendDelegationEvent("delegation.child.approval_waiting", {
      action_digest: actionDigest,
      action_kind: preview.actionKind.replaceAll(".", "_") as "apply_patch" | "run_command" | "mcp_server_start" | "mcp_tool_call" | "mcp_resource_read" | "mcp_prompt_get",
      approval_request_id: approvalRequestId,
      child_actor_id: actor.actorId,
      child_attempt_id: actor.attemptId,
      delegation_id: actor.delegationId,
      delegation_revision: actor.delegationRevision,
      delegation_sha256: actor.delegationSha256,
      parent_actor_id: actor.parentActorId,
      parent_run_id: actor.parentRunId,
      workspace_id: this.input.envelope.prepared.workspace.mode === "managed_worktree"
        ? this.input.envelope.prepared.workspace.logicalWorkspaceId
        : null,
    });
    const request = {
      schemaVersion: 1 as const,
      protocolVersion: 1 as const,
      frame: "approval_requested" as const,
      operationId: this.input.envelope.execution.operationId,
      childAttemptId: actor.attemptId,
      approvalRequestId,
      actionDigest,
      actionKind: preview.actionKind,
      preview: { ...preview },
    };
    assertBoundedProtocolFrame(request);
    this.input.channel.send(request);
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        offMessage();
        offClose();
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => finish("cancelled");
      const offMessage = this.input.channel.onMessage((candidate) => {
        const decision = delegationChildApprovalDecisionFrameSchema.safeParse(candidate);
        if (!decision.success) return;
        if (
          decision.data.operationId === request.operationId &&
          decision.data.childAttemptId === request.childAttemptId &&
          decision.data.approvalRequestId === approvalRequestId &&
          decision.data.actionDigest === actionDigest
        ) finish(decision.data.decision);
      });
      const offClose = this.input.channel.onClose(() => finish("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    }).catch((error) => {
      throw new DelegationError("delegation_decision_mismatch", "child approval bridge failed", { cause: error });
    });
  }
}
