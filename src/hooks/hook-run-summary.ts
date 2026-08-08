import { z } from "zod";

import type { DecodedRunEvent } from "../events/event-decoder-registry.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const hookRunSummarySchema = z.object({
  counts: z.object({
    degraded: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict(),
  invocations: z.array(z.object({
    code: z.string().max(128).nullable(),
    decision: z.enum(["deny", "no_objection"]).nullable(),
    event: z.string().min(1).max(64),
    hookId: z.string().min(1).max(512),
    inputSha256: sha256,
    invocationId: uuid,
    mode: z.enum(["gate", "observe"]),
    originalActionSha256: sha256.nullable(),
    status: z.enum(["degraded", "denied", "no_objection", "observed", "pending", "skipped"]),
  }).strict()).max(128),
}).strict();

export type HookRunSummary = z.infer<typeof hookRunSummarySchema>;

export function projectHookRunSummary(events: readonly DecodedRunEvent[]): HookRunSummary {
  const values = new Map<string, {
    code: string | null;
    decision: "deny" | "no_objection" | null;
    event: string;
    hookId: string;
    inputSha256: string;
    invocationId: string;
    mode: "gate" | "observe";
    originalActionSha256: string | null;
    status: HookRunSummary["invocations"][number]["status"];
  }>();
  for (const event of events) {
    if (event.type === "hook.matched") {
      values.set(event.data.invocation_id, {
        code: null,
        decision: null,
        event: event.data.event,
        hookId: event.data.hook_identity.qualifiedId,
        inputSha256: event.data.input_sha256,
        invocationId: event.data.invocation_id,
        mode: "gate",
        originalActionSha256: event.data.original_action_sha256 ?? null,
        status: "pending",
      });
    } else if (event.type === "hook.invocation.requested") {
      const current = values.get(event.data.invocation_id);
      if (current !== undefined) current.mode = event.data.mode;
    } else if (event.type === "hook.invocation.decided") {
      const current = values.get(event.data.invocation_id);
      if (current !== undefined) {
        current.code = event.data.code ?? null;
        current.decision = event.data.decision;
        current.status = event.data.decision === "deny" ? "denied" : "no_objection";
      }
    } else if (event.type === "hook.invocation.completed") {
      const current = values.get(event.data.invocation_id);
      if (current !== undefined) {
        current.status = event.data.status === "degraded" ? "degraded" : "observed";
      }
    } else if (event.type === "hook.invocation.failed") {
      const current = values.get(event.data.invocation_id);
      if (current !== undefined) {
        current.code = event.data.code;
        current.status = event.data.code === "hook_short_circuited" ? "skipped" : "degraded";
      }
    }
  }
  const invocations = [...values.values()];
  return hookRunSummarySchema.parse({
    counts: {
      degraded: invocations.filter((value) => value.status === "degraded").length,
      denied: invocations.filter((value) => value.status === "denied").length,
      executed: invocations.filter((value) =>
        ["degraded", "denied", "no_objection", "observed"].includes(value.status)
      ).length,
      matched: invocations.length,
      pending: invocations.filter((value) => value.status === "pending").length,
      skipped: invocations.filter((value) => value.status === "skipped").length,
    },
    invocations,
  });
}
