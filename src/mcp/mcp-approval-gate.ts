import type {
  ApprovalDecision,
  ApprovalPrompt,
  McpApprovalPreview,
} from "../approvals/approval-types.js";
import type {
  Phase12McpRunEventData,
  Phase12McpRunEventType,
} from "./mcp-event-schema.js";

export interface McpEventAppender {
  append<TType extends Phase12McpRunEventType>(
    type: TType,
    data: Phase12McpRunEventData<TType>,
  ): Promise<void>;
}

export class McpApprovalGate {
  public constructor(
    private readonly options: {
      readonly events: McpEventAppender;
      readonly prompt: ApprovalPrompt;
      readonly randomUUID: () => string;
    },
  ) {}

  public async request(
    preview: Omit<McpApprovalPreview, "actionKind"> & {
      readonly actionKind: "mcp.server.start" | "mcp.tool.call";
      readonly serverId: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly approvalRequestId: string; readonly decision: ApprovalDecision }> {
    const approvalRequestId = this.options.randomUUID();
    const previewSource = [preview.title, ...preview.reviewLines, `WARNING: ${preview.riskWarning}`].join("\n");
    const persistedPreview = truncateUtf8(previewSource, 32 * 1024);
    await this.options.events.append("mcp.approval.requested", {
      action_kind: preview.actionKind,
      action_sha256: preview.actionSha256,
      approval_request_id: approvalRequestId,
      preview: persistedPreview,
      server_id: preview.serverId,
      truncated: persistedPreview !== previewSource,
    });
    const decision = await this.options.prompt.request(preview, signal);
    // PHASE12: resolving a prompt is not authority. The exact action decision
    // must be durable before launcher/call code may cross the side-effect edge.
    await this.options.events.append("mcp.approval.decided", {
      action_kind: preview.actionKind,
      action_sha256: preview.actionSha256,
      approval_request_id: approvalRequestId,
      decision,
      server_id: preview.serverId,
    });
    return Object.freeze({ approvalRequestId, decision });
  }
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limit) break;
    output += character;
    bytes += next;
  }
  return output;
}
