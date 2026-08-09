import { z } from "zod";

import { redactSensitiveText } from "../security/redact.js";
import { parseStrictJson } from "../system/strict-json.js";

export const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

const gateOutputSchema = z.object({
  schemaVersion: z.literal(1),
  decision: z.enum(["deny", "no_objection"]),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u).optional(),
  evidence: z.array(z.string().min(1).max(512)).max(32).optional(),
  message: z.string().min(1).max(1024).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "deny" && (value.code === undefined || value.message === undefined)) {
    context.addIssue({ code: "custom", message: "deny requires code and message" });
  }
  if (value.decision === "no_objection" && (value.code !== undefined || value.message !== undefined)) {
    context.addIssue({ code: "custom", message: "no_objection cannot carry deny fields" });
  }
});

const observerOutputSchema = z.union([
  z.object({}).strict(),
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("observed"),
    message: z.string().min(1).max(1024).optional(),
  }).strict(),
]);

export type HookCommandRunnerResult =
  | {
      readonly actionSha256: string;
      readonly decision: "deny" | "no_objection";
      readonly evidence: readonly string[];
      readonly kind: "gate";
      readonly code?: string;
      readonly message?: string;
      readonly stderr: string;
      readonly stdout: string;
    }
  | {
      readonly actionSha256: string;
      readonly kind: "observer";
      readonly message?: string;
      readonly stderr: string;
      readonly stdout: string;
    };

export class HookCommandResultError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "HookCommandResultError";
  }
}

export function appendBoundedHookOutput(
  chunks: Buffer[],
  size: number,
  chunk: Buffer,
): { readonly exceeded: boolean; readonly size: number } {
  const next = size + chunk.byteLength;
  if (next <= MAX_HOOK_OUTPUT_BYTES) {
    chunks.push(Buffer.from(chunk));
    return { exceeded: false, size: next };
  }
  const remaining = Math.max(0, MAX_HOOK_OUTPUT_BYTES - size);
  if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
  return { exceeded: true, size: MAX_HOOK_OUTPUT_BYTES };
}

function decode(chunks: readonly Buffer[], label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new HookCommandResultError(`${label} is not valid UTF-8`, { cause: error });
  }
}

function containsTerminalControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 0x1b || codePoint === 0x9b;
  });
}

export function parseHookCommandResult(input: {
  readonly actionSha256: string;
  readonly mode: "gate" | "observe";
  readonly secrets: readonly (string | undefined)[];
  readonly stderr: readonly Buffer[];
  readonly stdout: readonly Buffer[];
}): HookCommandRunnerResult {
  const stdoutRaw = decode(input.stdout, "Hook stdout");
  const stderrRaw = decode(input.stderr, "Hook stderr");
  if (containsTerminalControl(stdoutRaw) || containsTerminalControl(stderrRaw)) {
    throw new HookCommandResultError("Hook output contains terminal control sequences");
  }
  const stdout = redactSensitiveText(stdoutRaw, input.secrets);
  const stderr = redactSensitiveText(stderrRaw, input.secrets);
  let parsed: unknown;
  try {
    parsed = parseStrictJson(stdout.trim());
  } catch (error) {
    throw new HookCommandResultError("Hook stdout is not one strict JSON document", { cause: error });
  }
  if (input.mode === "gate") {
    let result: z.infer<typeof gateOutputSchema>;
    try {
      result = gateOutputSchema.parse(parsed);
    } catch (error) {
      throw new HookCommandResultError("Hook gate output failed the strict protocol", { cause: error });
    }
    return Object.freeze({
      actionSha256: input.actionSha256,
      ...(result.code === undefined ? {} : { code: result.code }),
      decision: result.decision,
      evidence: Object.freeze([...(result.evidence ?? [])]),
      kind: "gate" as const,
      ...(result.message === undefined ? {} : { message: result.message }),
      stderr,
      stdout,
    });
  }
  let result: z.infer<typeof observerOutputSchema>;
  try {
    result = observerOutputSchema.parse(parsed);
  } catch (error) {
    throw new HookCommandResultError("Hook observer output failed the strict protocol", { cause: error });
  }
  return Object.freeze({
    actionSha256: input.actionSha256,
    kind: "observer" as const,
    ...(Object.hasOwn(result, "message") && typeof result.message === "string" ? { message: result.message } : {}),
    stderr,
    stdout,
  });
}
