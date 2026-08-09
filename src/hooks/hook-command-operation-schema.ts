import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith("Z"),
  "timestamp must be UTC",
);
const bounded = (bytes: number) => z.string().refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= bytes,
  `must be NUL-free and at most ${bytes} UTF-8 bytes`,
);

const base = z.object({
  actionSha256: sha256,
  createdAt: timestamp,
  failurePolicy: z.enum(["fail_closed", "record_degraded"]),
  hookIdentitySha256: sha256,
  inputSha256: sha256,
  invocationId: uuid,
  mode: z.enum(["gate", "observe"]),
  nonceSha256: sha256,
  requestedEventId: uuid,
  runId: uuid,
  schemaVersion: z.literal(1),
  sessionId: uuid,
  sessionLockNonceSha256: sha256,
  terminalEventId: uuid,
}).strict();

const supervisorIdentity = z.object({
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: bounded(256).min(1),
}).strict();

const processIdentity = supervisorIdentity.extend({
  hookPid: z.number().int().positive(),
  processIdentitySha256: sha256,
}).strict();

const gateResult = z.object({
  actionSha256: sha256,
  code: bounded(128).optional(),
  decision: z.enum(["deny", "no_objection"]),
  evidence: z.array(bounded(512).min(1)).max(32),
  kind: z.literal("gate"),
  message: bounded(1024).optional(),
  stderr: bounded(64 * 1024),
  stdout: bounded(64 * 1024),
}).strict().superRefine((value, context) => {
  if (value.decision === "deny" && (value.code === undefined || value.message === undefined)) {
    context.addIssue({ code: "custom", message: "deny requires code and message" });
  }
  if (value.decision === "no_objection" && (value.code !== undefined || value.message !== undefined)) {
    context.addIssue({ code: "custom", message: "no_objection cannot carry deny fields" });
  }
});

const observerResult = z.object({
  actionSha256: sha256,
  kind: z.literal("observer"),
  message: bounded(1024).optional(),
  stderr: bounded(64 * 1024),
  stdout: bounded(64 * 1024),
}).strict();

const failureResult = z.object({
  code: z.enum([
    "hook_gate_output_invalid",
    "hook_invocation_cancelled",
    "hook_invocation_failed",
    "hook_invocation_timeout",
  ]),
  effectState: z.enum(["none", "unknown"]),
  kind: z.literal("failure"),
}).strict();

export const hookCommandOperationCaptureSchema = z.discriminatedUnion("kind", [
  gateResult,
  observerResult,
  failureResult,
]);

const requested = base.extend({
  state: z.literal("requested"),
}).strict();

const spawning = base.extend({
  spawningAt: timestamp,
  state: z.literal("spawning"),
  supervisor: supervisorIdentity,
}).strict();

const started = base.extend({
  process: processIdentity,
  startedAt: timestamp,
  state: z.literal("started"),
}).strict();

const captured = base.extend({
  capture: hookCommandOperationCaptureSchema,
  capturedAt: timestamp,
  process: processIdentity.optional(),
  startedAt: timestamp.optional(),
  state: z.literal("captured"),
}).strict().superRefine((value, context) => {
  const hasProcess = value.process !== undefined || value.startedAt !== undefined;
  if (hasProcess && (value.process === undefined || value.startedAt === undefined)) {
    context.addIssue({ code: "custom", message: "captured process identity is incomplete" });
  }
  if (!hasProcess && (value.capture.kind !== "failure" || value.capture.effectState !== "none")) {
    context.addIssue({ code: "custom", message: "a capture without spawn identity must prove no effect" });
  }
});

const terminal = base.extend({
  capture: hookCommandOperationCaptureSchema,
  capturedAt: timestamp,
  process: processIdentity.optional(),
  startedAt: timestamp.optional(),
  state: z.literal("terminal"),
  terminalCommittedAt: timestamp,
  terminalType: z.enum([
    "hook.invocation.completed",
    "hook.invocation.decided",
    "hook.invocation.failed",
  ]),
}).strict().superRefine((value, context) => {
  const hasProcess = value.process !== undefined || value.startedAt !== undefined;
  if (hasProcess && (value.process === undefined || value.startedAt === undefined)) {
    context.addIssue({ code: "custom", message: "terminal process identity is incomplete" });
  }
  if (!hasProcess && (value.capture.kind !== "failure" || value.capture.effectState !== "none")) {
    context.addIssue({ code: "custom", message: "a terminal without spawn identity must prove no effect" });
  }
});

export const hookCommandOperationRecordSchema = z.discriminatedUnion("state", [
  requested,
  spawning,
  started,
  captured,
  terminal,
]);

export type HookCommandOperationCaptureV1 = z.infer<typeof hookCommandOperationCaptureSchema>;
export type HookCommandOperationRecordV1 = z.infer<typeof hookCommandOperationRecordSchema>;
export type HookCommandOperationRequestedV1 = z.infer<typeof requested>;
export type HookCommandOperationSpawningV1 = z.infer<typeof spawning>;
export type HookCommandOperationStartedV1 = z.infer<typeof started>;
export type HookCommandOperationCapturedV1 = z.infer<typeof captured>;
