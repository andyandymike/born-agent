import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import {
  modelQualificationIdentitySchema,
  modelQualificationIdentitySha256,
} from "./model-qualification-identity.js";

export const MODEL_QUALIFICATION_PROBE_IDS = Object.freeze([
  "streaming_text_v1",
  "strict_tool_args_v1",
  "tool_continuation_v1",
  "sequential_tools_v1",
  "cancellation_v1",
  "usage_semantics_v1",
] as const);

export type ModelQualificationProbeId =
  (typeof MODEL_QUALIFICATION_PROBE_IDS)[number];

const status = z.enum(["passed", "failed", "timeout", "cancelled", "not_run"]);
const common = {
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
  durationMs: z.number().int().nonnegative(),
  requestCount: z.number().int().min(0).max(6),
  status,
};

export const probeResultSchema = z.discriminatedUnion("probeId", [
  z
    .object({
      ...common,
      observed: z
        .object({ deltaCount: z.number().int().nonnegative(), terminalText: z.boolean() })
        .strict(),
      probeId: z.literal("streaming_text_v1"),
    })
    .strict(),
  z
    .object({
      ...common,
      observed: z
        .object({
          argumentsStrict: z.boolean(),
          callIdPresent: z.boolean(),
          toolCallCount: z.number().int().nonnegative(),
        })
        .strict(),
      probeId: z.literal("strict_tool_args_v1"),
    })
    .strict(),
  z
    .object({
      ...common,
      observed: z
        .object({ acknowledgementMatched: z.boolean(), terminalText: z.boolean() })
        .strict(),
      probeId: z.literal("tool_continuation_v1"),
    })
    .strict(),
  z
    .object({
      ...common,
      observed: z
        .object({ ordered: z.boolean(), toolCallCount: z.number().int().nonnegative() })
        .strict(),
      probeId: z.literal("sequential_tools_v1"),
    })
    .strict(),
  z
    .object({
      ...common,
      observed: z
        .object({
          abortObserved: z.boolean(),
          cancelLatencyMs: z.number().int().nonnegative(),
          lateEventCount: z.number().int().nonnegative(),
        })
        .strict(),
      probeId: z.literal("cancellation_v1"),
    })
    .strict(),
  z
    .object({
      ...common,
      observed: z
        .object({ availability: z.enum(["complete", "partial", "unavailable"]) })
        .strict(),
      probeId: z.literal("usage_semantics_v1"),
    })
    .strict(),
]);

const recordWithoutEvidenceSchema = z
  .object({
    createdAt: z
      .string()
      .datetime({ offset: true })
      .refine((value) => value.endsWith("Z"), "createdAt must be UTC"),
    identity: modelQualificationIdentitySchema,
    identitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    probeResults: z.array(probeResultSchema).length(MODEL_QUALIFICATION_PROBE_IDS.length),
    qualifiedModes: z.array(z.enum(["plan", "build"])).max(2),
    schemaVersion: z.literal(1),
    totalDurationMs: z.number().int().nonnegative(),
    totalRequestCount: z.number().int().min(0).max(6),
  })
  .strict();

export type ModelQualificationRecordInput = Readonly<
  z.infer<typeof recordWithoutEvidenceSchema>
>;

export function modelQualificationEvidenceSha256(
  record: z.infer<typeof recordWithoutEvidenceSchema>,
): string {
  return sha256Canonical(recordWithoutEvidenceSchema.parse(record));
}

function expectedQualifiedModes(
  results: readonly z.infer<typeof probeResultSchema>[],
): readonly ("plan" | "build")[] {
  const passed = new Set(
    results.filter((result) => result.status === "passed").map((result) => result.probeId),
  );
  const plan = [
    "streaming_text_v1",
    "strict_tool_args_v1",
    "tool_continuation_v1",
    "cancellation_v1",
  ].every((probe) => passed.has(probe as ModelQualificationProbeId));
  const build = plan && passed.has("sequential_tools_v1");
  return [...(plan ? (["plan"] as const) : []), ...(build ? (["build"] as const) : [])];
}

export const modelQualificationRecordSchema = recordWithoutEvidenceSchema
  .extend({ evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict()
  .superRefine((value, context) => {
    const probeIds = value.probeResults.map((result) => result.probeId);
    if (
      probeIds.join(",") !== MODEL_QUALIFICATION_PROBE_IDS.join(",") ||
      value.totalRequestCount !==
        value.probeResults.reduce((total, result) => total + result.requestCount, 0) ||
      new Set(value.qualifiedModes).size !== value.qualifiedModes.length ||
      value.qualifiedModes.join(",") !== expectedQualifiedModes(value.probeResults).join(",")
    ) {
      context.addIssue({ code: "custom", message: "qualification result matrix is inconsistent" });
    }
    if (
      value.identitySha256 !==
      modelQualificationIdentitySha256(value.identity)
    ) {
      context.addIssue({
        code: "custom",
        message: "qualification identity hash does not match",
      });
    }
    const withoutEvidence = {
      createdAt: value.createdAt,
      identity: value.identity,
      identitySha256: value.identitySha256,
      probeResults: value.probeResults,
      qualifiedModes: value.qualifiedModes,
      schemaVersion: value.schemaVersion,
      totalDurationMs: value.totalDurationMs,
      totalRequestCount: value.totalRequestCount,
    };
    if (value.evidenceSha256 !== modelQualificationEvidenceSha256(withoutEvidence)) {
      context.addIssue({ code: "custom", message: "qualification evidence hash does not match" });
    }
  });

export type ProbeResult = Readonly<z.infer<typeof probeResultSchema>>;
export type ModelQualificationRecordV1 = Readonly<
  z.infer<typeof modelQualificationRecordSchema>
>;

export function createModelQualificationRecord(
  input: z.infer<typeof recordWithoutEvidenceSchema>,
): ModelQualificationRecordV1 {
  return Object.freeze(
    modelQualificationRecordSchema.parse({
      ...input,
      evidenceSha256: modelQualificationEvidenceSha256(input),
    }),
  );
}
