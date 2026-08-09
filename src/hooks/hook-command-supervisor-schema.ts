import { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const bounded = (bytes: number) => z.string().refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= bytes,
  `must be NUL-free and at most ${bytes} UTF-8 bytes`,
);
const canonicalBase64 = z.string().max(96 * 1024).refine((value) => {
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}, "must be canonical base64");

export const hookCommandSupervisorBootstrapSchema = z.object({
  actionSha256: sha256,
  argv: z.array(bounded(8 * 1024)).max(64),
  cwd: bounded(32 * 1024).min(1),
  environment: z.record(
    z.string().regex(/^[^=\0]{1,256}$/u),
    bounded(32 * 1024),
  ),
  executablePath: bounded(32 * 1024).min(1),
  executableSha256: sha256,
  hookIdentitySha256: sha256,
  inputBase64: canonicalBase64,
  inputSha256: sha256,
  invocationId: uuid,
  mode: z.enum(["gate", "observe"]),
  protocolVersion: z.literal(1),
  rawNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  scriptPath: bounded(32 * 1024).min(1),
  scriptSha256: sha256,
  secrets: z.array(bounded(32 * 1024).optional()).max(64),
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > 256 * 1024) {
    context.addIssue({ code: "custom", message: "Hook supervisor bootstrap exceeds 256 KiB" });
  }
});

export const hookCommandSupervisorStartedSchema = z.object({
  hookPid: z.number().int().positive(),
  invocationId: uuid,
  kind: z.literal("started"),
  processIdentitySha256: sha256,
  protocolVersion: z.literal(1),
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: bounded(256).min(1),
}).strict();

export const hookCommandSupervisorCapturedSchema = z.object({
  invocationId: uuid,
  kind: z.literal("captured"),
  protocolVersion: z.literal(1),
}).strict();

export const hookCommandSupervisorMessageSchema = z.discriminatedUnion("kind", [
  hookCommandSupervisorStartedSchema,
  hookCommandSupervisorCapturedSchema,
]);

export type HookCommandSupervisorBootstrapV1 = z.infer<typeof hookCommandSupervisorBootstrapSchema>;
export type HookCommandSupervisorMessageV1 = z.infer<typeof hookCommandSupervisorMessageSchema>;
