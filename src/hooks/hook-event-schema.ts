import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const bounded = (bytes: number) => z.string().refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= bytes,
  `must be NUL-free and at most ${bytes} UTF-8 bytes`,
);
const hookEvent = z.enum([
  "session.started",
  "run.started",
  "tool.before_effect",
  "tool.after_result",
  "completion.before_commit",
  "run.terminal",
  "session.ended",
]);
const identity = z.object({
  componentId: z.string().min(1).max(80),
  componentSha256: sha256,
  kind: z.literal("hook"),
  pluginId: z.string().min(1).max(80),
  pluginSha256: sha256,
  pluginVersion: z.string().min(1).max(64),
  qualifiedId: z.string().min(1).max(512),
  source: z.enum(["builtin", "user_install", "workspace"]),
}).strict();

export const phase18HookRunEventDataSchemas = {
  "hook.matched": z.object({
    event: hookEvent,
    hook_identity: identity,
    input_sha256: sha256,
    invocation_id: uuid,
    order: z.number().int().nonnegative().max(31),
    original_action_sha256: sha256.optional(),
  }).strict(),
  "hook.invocation.requested": z.object({
    event: hookEvent,
    handler: z.enum(["command", "declarative_gate"]),
    hook_identity: identity,
    hook_input_artifact_id: artifactId,
    hook_input_sha256: sha256,
    invocation_id: uuid,
    mode: z.enum(["gate", "observe"]),
  }).strict().refine(
    (value) => value.hook_input_artifact_id === `sha256:${value.hook_input_sha256}`,
    "Hook input artifact identity is inconsistent",
  ),
  "hook.invocation.started": z.object({
    action_sha256: sha256,
    invocation_id: uuid,
    pid: z.number().int().positive(),
    process_identity_sha256: sha256,
  }).strict(),
  "hook.invocation.decided": z.object({
    code: bounded(128).optional(),
    decision: z.enum(["deny", "no_objection"]),
    evidence: z.array(bounded(512).min(1)).max(32),
    invocation_id: uuid,
    message: bounded(1024).optional(),
  }).strict().superRefine((value, context) => {
    if (value.decision === "deny" && (value.code === undefined || value.message === undefined)) {
      context.addIssue({ code: "custom", message: "Hook deny requires code and message" });
    }
    if (value.decision === "no_objection" && value.code !== undefined) {
      context.addIssue({ code: "custom", message: "Hook no_objection cannot carry a deny code" });
    }
  }),
  "hook.invocation.completed": z.object({
    artifact_ids: z.array(artifactId).max(16),
    invocation_id: uuid,
    message: bounded(1024).optional(),
    status: z.enum(["degraded", "observed"]),
  }).strict(),
  "hook.invocation.failed": z.object({
    code: bounded(128).min(1),
    effect_state: z.enum(["none", "unknown"]),
    failure_policy: z.enum(["fail_closed", "record_degraded"]),
    invocation_id: uuid,
  }).strict(),
} as const;

export type Phase18HookRunEventType = keyof typeof phase18HookRunEventDataSchemas;
export type Phase18HookRunEventData<TType extends Phase18HookRunEventType> =
  z.infer<(typeof phase18HookRunEventDataSchemas)[TType]>;
