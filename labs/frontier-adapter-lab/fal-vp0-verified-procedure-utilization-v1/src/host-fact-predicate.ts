import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { FalVp0Predicate } from "./procedure-schema.js";
import { falVp0PredicateSchema } from "./procedure-schema.js";
import {
  identifierSchema,
  isStrictlySortedUnique,
  sha256Schema,
} from "./protocol.js";
import type { hostFactValueSchema } from "./protocol.js";

export const falVp0HostFactRegistryEntrySchema = z.object({
  factKey: identifierSchema,
  factSource: z.enum(["case_manifest", "runtime_preflight", "source_verifier"]),
  valueType: z.enum(["null", "boolean", "number", "string"]),
  extractorId: identifierSchema,
  extractorSha256: sha256Schema,
}).strict();

export const falVp0PredicateEvaluationSchema = z.object({
  conditionId: identifierSchema,
  factSource: z.enum(["case_manifest", "runtime_preflight", "source_verifier"]),
  factKey: identifierSchema,
  extractorId: identifierSchema,
  extractorSha256: sha256Schema,
  workspaceBeforeSha256: sha256Schema.nullable(),
  expectedCanonicalSha256: sha256Schema,
  actualCanonicalSha256: sha256Schema.nullable(),
  actualType: z.enum(["string", "number", "boolean", "missing"]).nullable(),
  evaluationStatus: z.enum([
    "matched",
    "not_matched",
    "missing",
    "type_mismatch",
    "invalid_expected",
    "extractor_failed",
  ]),
  gateValue: z.union([z.boolean(), z.literal("reject")]),
  evidenceSha256s: z.array(sha256Schema).max(32),
  extractorObservationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const expectedGate = value.evaluationStatus === "matched"
    ? true
    : value.evaluationStatus === "not_matched"
      ? false
      : "reject";
  if (value.gateValue !== expectedGate) {
    context.addIssue({ code: "custom", message: "predicate status/gate mapping mismatch" });
  }
  if (!isStrictlySortedUnique(value.evidenceSha256s)) {
    context.addIssue({ code: "custom", message: "predicate evidence hashes must be sorted and unique" });
  }
  if (value.evaluationStatus === "missing" && value.actualType !== "missing") {
    context.addIssue({ code: "custom", message: "missing predicate requires missing actual type" });
  }
});

export type FalVp0HostFactRegistryEntry = Readonly<
  z.infer<typeof falVp0HostFactRegistryEntrySchema>
>;
export type FalVp0PredicateEvaluation = Readonly<
  z.infer<typeof falVp0PredicateEvaluationSchema>
>;

type Scalar = z.infer<typeof hostFactValueSchema>;

function scalarType(value: Scalar): "null" | "boolean" | "number" | "string" {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  throw new TypeError("host fact scalar has an unsupported runtime type");
}

function observationType(value: Scalar | undefined, present: boolean):
  "string" | "number" | "boolean" | "missing" | null {
  if (!present) return "missing";
  if (value === null) return null;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  throw new TypeError("host fact observation has an unsupported runtime type");
}

function parseSemver(value: string): readonly [number, number, number] | null {
  const matched = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (matched === null) return null;
  const tuple = matched.slice(1).map(Number) as [number, number, number];
  return tuple.every((entry) => Number.isSafeInteger(entry) && entry <= 2_147_483_647)
    ? tuple
    : null;
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function semverSatisfies(actual: string, expected: string): boolean | null {
  const actualTuple = parseSemver(actual);
  if (actualTuple === null) return null;
  const exact = /^=(.+)$/u.exec(expected);
  if (exact !== null) {
    const wanted = parseSemver(exact[1] ?? "");
    return wanted === null ? null : compareSemver(actualTuple, wanted) === 0;
  }
  const bounded = /^>=(.+) <(.+)$/u.exec(expected);
  if (bounded === null) return null;
  const minimum = parseSemver(bounded[1] ?? "");
  const maximum = parseSemver(bounded[2] ?? "");
  if (minimum === null || maximum === null || compareSemver(minimum, maximum) >= 0) return null;
  return compareSemver(actualTuple, minimum) >= 0 && compareSemver(actualTuple, maximum) < 0;
}

function expectedIsValid(predicate: FalVp0Predicate): boolean {
  const expected = predicate.expected;
  switch (predicate.operator) {
    case "exists":
      return expected === null;
    case "equals":
    case "not_equals":
      return !Array.isArray(expected);
    case "one_of":
    case "none_of":
      return Array.isArray(expected) && expected.length >= 1 &&
        expected.every((entry) => typeof entry === "string") &&
        isStrictlySortedUnique(expected);
    case "sha256_equals":
      return typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected);
    case "semver_satisfies":
      return typeof expected === "string" &&
        (/^=\d+\.\d+\.\d+$/u.test(expected) ||
         /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/u.test(expected));
  }
}

function evaluateMatch(predicate: FalVp0Predicate, actual: Scalar):
  "matched" | "not_matched" | "type_mismatch" | "invalid_expected" {
  const expected = predicate.expected;
  switch (predicate.operator) {
    case "exists":
      return "matched";
    case "equals":
    case "not_equals": {
      if (Array.isArray(expected) || scalarType(actual) !== scalarType(expected as Scalar)) {
        return "type_mismatch";
      }
      const equal = sha256Canonical(actual) === sha256Canonical(expected);
      const result = predicate.operator === "equals" ? equal : !equal;
      return result ? "matched" : "not_matched";
    }
    case "one_of":
    case "none_of": {
      if (typeof actual !== "string" || !Array.isArray(expected)) return "type_mismatch";
      const contains = expected.includes(actual);
      const result = predicate.operator === "one_of" ? contains : !contains;
      return result ? "matched" : "not_matched";
    }
    case "sha256_equals":
      if (typeof actual !== "string") return "type_mismatch";
      return actual === expected ? "matched" : "not_matched";
    case "semver_satisfies": {
      if (typeof actual !== "string" || typeof expected !== "string") return "type_mismatch";
      const result = semverSatisfies(actual, expected);
      return result === null ? "invalid_expected" : result ? "matched" : "not_matched";
    }
  }
}

export function evaluateFalVp0Predicate(input: {
  readonly conditionId: string;
  readonly evidenceSha256s: readonly string[];
  readonly facts: Readonly<Record<string, Scalar>>;
  readonly predicate: unknown;
  readonly registryEntry: FalVp0HostFactRegistryEntry | null;
  readonly workspaceBeforeSha256: string | null;
}): FalVp0PredicateEvaluation {
  const decoded = falVp0PredicateSchema.safeParse(input.predicate);
  const fallback = input.predicate !== null && typeof input.predicate === "object"
    ? input.predicate as Readonly<Record<string, unknown>>
    : {};
  const factKey = typeof fallback.factKey === "string" ? fallback.factKey : "invalid-fact";
  const factSource = fallback.factSource === "runtime_preflight" || fallback.factSource === "source_verifier"
    ? fallback.factSource
    : "case_manifest";
  const expected = fallback.expected ?? null;
  const predicate = decoded.success ? decoded.data : null;
  const registry = input.registryEntry;
  const registryMatches = predicate !== null && registry !== null &&
    registry.factKey === predicate.factKey &&
    registry.factSource === predicate.factSource &&
    registry.extractorId === predicate.extractorId &&
    registry.extractorSha256 === predicate.extractorSha256;
  const present = predicate !== null && Object.hasOwn(input.facts, predicate.factKey);
  const actual = present && predicate !== null ? input.facts[predicate.factKey] : undefined;
  let evaluationStatus: FalVp0PredicateEvaluation["evaluationStatus"];
  if (!decoded.success) evaluationStatus = "invalid_expected";
  else if (!registryMatches) evaluationStatus = "extractor_failed";
  else if (!expectedIsValid(predicate)) evaluationStatus = "invalid_expected";
  else if (!present) evaluationStatus = "missing";
  else if (scalarType(actual as Scalar) !== registry!.valueType) evaluationStatus = "type_mismatch";
  else evaluationStatus = evaluateMatch(predicate, actual as Scalar);
  const evidenceSha256s = [...new Set(input.evidenceSha256s)].sort();
  const extractorId = registry?.extractorId ??
    (typeof fallback.extractorId === "string" ? fallback.extractorId : "invalid-extractor");
  const extractorSha256 = registry?.extractorSha256 ??
    (typeof fallback.extractorSha256 === "string" && /^[a-f0-9]{64}$/u.test(fallback.extractorSha256)
      ? fallback.extractorSha256
      : sha256Canonical({ invalid: "extractor" }));
  const actualCanonicalSha256 = present ? sha256Canonical(actual) : null;
  const content = {
    conditionId: input.conditionId,
    factSource,
    factKey,
    extractorId,
    extractorSha256,
    workspaceBeforeSha256: input.workspaceBeforeSha256,
    expectedCanonicalSha256: sha256Canonical(expected),
    actualCanonicalSha256,
    actualType: observationType(actual, present),
    evaluationStatus,
    gateValue: evaluationStatus === "matched" ? true as const
      : evaluationStatus === "not_matched" ? false as const
        : "reject" as const,
    evidenceSha256s,
  };
  return falVp0PredicateEvaluationSchema.parse({
    ...content,
    extractorObservationSha256: sha256Canonical(content),
  });
}
