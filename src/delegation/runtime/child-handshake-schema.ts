import { z } from "zod";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const delegationChildHandshakeSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("handshake"),
  operationId: uuid,
  childActorId: uuid,
  childAttemptId: uuid,
  envelopeSha256: sha256,
  executableDescriptorSha256: sha256,
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1).max(512),
  nonceProofSha256: sha256,
}).strict();

export const delegationChildStartSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("start"),
  operationId: uuid,
  childAttemptId: uuid,
  envelopeSha256: sha256,
  startBarrierProofSha256: sha256,
}).strict();

export const delegationChildTerminalFrameSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("terminal"),
  operationId: uuid,
  childAttemptId: uuid,
  childRunId: uuid,
  exitCode: z.number().int().min(0).max(255),
  observedTerminalEventId: uuid.nullable(),
  diagnosticCode: z.string().regex(/^[a-z0-9_.:-]{1,128}$/u).nullable(),
}).strict();

export const delegationChildApprovalRequestFrameSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("approval_requested"),
  operationId: uuid,
  childAttemptId: uuid,
  approvalRequestId: uuid,
  actionDigest: sha256,
  actionKind: z.enum(["apply_patch", "run_command", "mcp.server.start", "mcp.tool.call", "mcp.resource.read", "mcp.prompt.get"]),
  preview: z.record(z.string(), z.unknown()),
}).strict();

export const delegationChildApprovalDecisionFrameSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("approval_decision"),
  operationId: uuid,
  childAttemptId: uuid,
  approvalRequestId: uuid,
  actionDigest: sha256,
  decision: z.enum(["approved", "cancelled", "denied"]),
}).strict();

export const delegationChildCancelFrameSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  frame: z.literal("cancel"),
  operationId: uuid,
  childAttemptId: uuid,
  cancelRequestId: uuid,
  reasonSha256: sha256,
  /** Host surface failure is distinct from a durable user cancellation. */
  kind: z.enum(["user_cancel", "tui_surface_fatal"]),
}).strict();

export type DelegationChildHandshakeV1 = Readonly<z.infer<typeof delegationChildHandshakeSchema>>;
export type DelegationChildStartV1 = Readonly<z.infer<typeof delegationChildStartSchema>>;
export type DelegationChildTerminalFrameV1 = Readonly<z.infer<typeof delegationChildTerminalFrameSchema>>;
export type DelegationChildApprovalRequestFrameV1 = Readonly<z.infer<typeof delegationChildApprovalRequestFrameSchema>>;
export type DelegationChildApprovalDecisionFrameV1 = Readonly<z.infer<typeof delegationChildApprovalDecisionFrameSchema>>;
export type DelegationChildCancelFrameV1 = Readonly<z.infer<typeof delegationChildCancelFrameSchema>>;

export function assertBoundedProtocolFrame(frame: unknown): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  } catch (error) {
    throw new TypeError("child protocol frame is not JSON serializable", { cause: error });
  }
  if (bytes > 64 * 1024) throw new TypeError("child protocol frame exceeds 64 KiB");
}
