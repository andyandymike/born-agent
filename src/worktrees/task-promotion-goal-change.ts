import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const path = z.string().min(1).max(1024).refine((value) =>
  !value.includes("\\") && !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"path must be normalized workspace-relative POSIX form");

const withoutHashSchema = z.object({
  files: z.array(z.object({
    bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
    kind: z.enum(["add", "modify"]),
    mode: z.enum(["100644", "100755"]),
    path,
    post_sha256: sha256,
    pre_sha256: sha256.nullable(),
  }).strict()).min(1).max(256),
  goal_id: uuid,
  goal_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source: z.object({
    approval_event_id: uuid,
    attempt_id: uuid,
    bundle_sha256: sha256,
    graph_id: uuid,
    graph_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    graph_sha256: sha256,
    kind: z.literal("task_promotion"),
    node_id: nodeId,
    operation_id: uuid,
    proposal_event_id: uuid,
    request_event_id: uuid,
    workspace_id: uuid,
  }).strict(),
}).strict();

export const taskPromotionGoalChangeRecordedDataSchema = withoutHashSchema
  .extend({ record_sha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const { record_sha256: _recordSha256, ...withoutHash } = value;
    void _recordSha256;
    if (sha256Canonical(withoutHash) !== value.record_sha256) {
      context.addIssue({ code: "custom", message: "task promotion Goal change hash is inconsistent" });
    }
  });

export type TaskPromotionGoalChangeRecordedDataV1 = Readonly<z.infer<typeof taskPromotionGoalChangeRecordedDataSchema>>;

export function createTaskPromotionGoalChangeRecordedData(
  input: z.input<typeof withoutHashSchema>,
): TaskPromotionGoalChangeRecordedDataV1 {
  const body = withoutHashSchema.parse(input);
  return Object.freeze(taskPromotionGoalChangeRecordedDataSchema.parse({
    ...body,
    record_sha256: sha256Canonical(body),
  }));
}
