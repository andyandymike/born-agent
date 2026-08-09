import { createHash } from "node:crypto";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import {
  normalizeTaskGraphRevision,
  type TaskGraphRevisionContentV1,
} from "./task-graph-schema.js";

export interface TaskGraphRevisionIdentityV1 {
  readonly bytes: Buffer;
  readonly byteLength: number;
  readonly content: TaskGraphRevisionContentV1;
  readonly graphSha256: string;
}

export function canonicalTaskGraphIdentity(value: unknown): TaskGraphRevisionIdentityV1 {
  const content = normalizeTaskGraphRevision(value);
  const bytes = Buffer.from(canonicalJson(content), "utf8");
  const graphSha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({ bytes, byteLength: bytes.byteLength, content, graphSha256 });
}

export function taskGraphApprovalIdentity(input: {
  readonly approvalRequestId: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly sessionId: string;
  readonly binding: TaskGraphRevisionContentV1["binding"];
}): string {
  // PHASE19: timestamps are excluded from Graph content identity, while the
  // fresh request ID prevents approval reuse across otherwise identical bytes.
  return sha256Canonical({
    approval_request_id: input.approvalRequestId,
    goal_id: input.binding.goalId,
    goal_revision: input.binding.goalRevision,
    graph_id: input.graphId,
    graph_revision: input.graphRevision,
    graph_sha256: input.graphSha256,
    plan_id: input.binding.planId,
    plan_revision: input.binding.planRevision,
    plan_sha256: input.binding.planSha256,
    session_id: input.sessionId,
  });
}
