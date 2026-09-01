import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  MEM_E0_CASE_IDS,
  MEM_E0_EXPERIMENT_ID,
  type MemE0CaseId,
} from "./fixture.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const toolNameSchema = z.enum([
  "apply_patch",
  "finish_task",
  "read_file",
  "run_command",
]);

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function addSortedUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  if (!isSortedUnique(values)) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 receipt arrays must be strictly sorted and unique",
    });
  }
}

const sha256ListSchema = z.array(sha256Schema).max(128).superRefine(
  addSortedUniqueIssue,
);
const nonemptySha256ListSchema = z.array(sha256Schema).min(1).max(128).superRefine(
  addSortedUniqueIssue,
);
const toolNameListSchema = z.array(toolNameSchema).max(16).superRefine(
  addSortedUniqueIssue,
);

const armEvidenceInputSchema = z.object({
  admittedRecordIdSha256: sha256Schema,
  admittedRecordLogicalSha256: sha256Schema,
  armContractObserved: z.boolean(),
  freshVerifierPassed: z.boolean(),
  historicalItemCount: z.number().int().min(0).max(1),
  observationSha256s: nonemptySha256ListSchema,
  productPathObserved: z.boolean(),
  selectedMemoryValueSha256s: sha256ListSchema,
  selectedRecordIdSha256s: sha256ListSchema,
  toolArgumentSha256s: sha256ListSchema,
  toolNames: toolNameListSchema,
}).strict();

const pairInputSchema = z.object({
  caseClass: z.enum(["memory_dependent", "harm_control"]),
  caseId: z.enum(MEM_E0_CASE_IDS),
  distinctOsProcesses: z.boolean(),
  off: armEvidenceInputSchema,
  on: armEvidenceInputSchema,
  processBoundaryObservationSha256: sha256Schema,
}).strict();

const pairInputListSchema = z.array(pairInputSchema).length(4).superRefine(
  (pairs, context) => {
  for (const [index, caseId] of MEM_E0_CASE_IDS.entries()) {
    const pair = pairs[index];
    const expectedClass = caseId === "mem-e0-harm-control"
      ? "harm_control"
      : "memory_dependent";
    if (pair?.caseId !== caseId || pair.caseClass !== expectedClass) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 receipt pairs must use the frozen case order and classes",
        path: [index],
      });
    }
  }
});

const receiptInputSchema = z.object({
  implementationSha256s: nonemptySha256ListSchema,
  pairs: pairInputListSchema,
  protocolSha256: sha256Schema,
}).strict();

const armReceiptSchema = armEvidenceInputSchema.extend({
  arm: z.enum(["off", "on"]),
  eligible: z.boolean(),
  memoryMode: z.enum(["off", "local"]),
}).strict();

export const memE0MechanicsPairOutcomeSchema = z.enum([
  "baseline_only_regression",
  "both_fail",
  "both_pass",
  "candidate_only_win",
  "inconclusive_invalid_pair",
]);

const pairReceiptSchema = z.object({
  caseClass: z.enum(["memory_dependent", "harm_control"]),
  caseId: z.enum(MEM_E0_CASE_IDS),
  distinctOsProcesses: z.boolean(),
  eligible: z.boolean(),
  off: armReceiptSchema,
  on: armReceiptSchema,
  outcome: memE0MechanicsPairOutcomeSchema,
  processBoundaryObservationSha256: sha256Schema,
  productPathObserved: z.boolean(),
  sameLogicalMemory: z.boolean(),
}).strict().superRefine((value, context) => {
  if (
    value.off.arm !== "off" ||
    value.off.memoryMode !== "off" ||
    value.on.arm !== "on" ||
    value.on.memoryMode !== "local"
  ) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 receipt arm labels must bind off to off and on to local",
    });
  }
  const rescored = scorePair({
    caseClass: value.caseClass,
    caseId: value.caseId,
    distinctOsProcesses: value.distinctOsProcesses,
    off: value.off,
    on: value.on,
    processBoundaryObservationSha256: value.processBoundaryObservationSha256,
  });
  for (const key of [
    "eligible",
    "outcome",
    "productPathObserved",
    "sameLogicalMemory",
  ] as const) {
    if (value[key] !== rescored[key]) {
      context.addIssue({
        code: "custom",
        message: `MEM-E0 pair ${key} must be scorer-derived`,
        path: [key],
      });
    }
  }
  if (value.off.eligible !== rescored.off.eligible) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 off-arm eligibility must be scorer-derived",
      path: ["off", "eligible"],
    });
  }
  if (value.on.eligible !== rescored.on.eligible) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 on-arm eligibility must be scorer-derived",
      path: ["on", "eligible"],
    });
  }
});

const outcomeCountsSchema = z.object({
  baselineOnlyRegression: z.number().int().nonnegative(),
  bothFail: z.number().int().nonnegative(),
  bothPass: z.number().int().nonnegative(),
  candidateOnlyWin: z.number().int().nonnegative(),
  inconclusiveInvalidPair: z.number().int().nonnegative(),
}).strict();

const aggregateSchema = z.object({
  armCount: z.literal(8),
  eligibleArmCount: z.number().int().min(0).max(8),
  eligiblePairCount: z.number().int().min(0).max(4),
  harmControlPairCount: z.literal(1),
  memoryDependentPairCount: z.literal(3),
  observationHashCount: z.number().int().nonnegative(),
  outcomeCounts: outcomeCountsSchema,
  pairCount: z.literal(4),
  selectedRecordHashCount: z.number().int().nonnegative(),
  toolArgumentHashCount: z.number().int().nonnegative(),
}).strict();

const claimsSchema = z.object({
  liveEffect: z.object({
    reasonCode: z.literal("deterministic_mechanics_only"),
    result: z.literal("not_run"),
  }).strict(),
  structuralMechanics: z.object({
    reasonCode: z.enum([
      "all_pairs_eligible_expected_outcomes_observed",
      "eligible_pair_outcome_mismatch",
      "one_or_more_pairs_ineligible",
    ]),
    result: z.enum(["inconclusive", "refuted", "supported"]),
  }).strict(),
}).strict();

const mechanicsReceiptContentSchema = z.object({
  actorClass: z.literal("deterministic_mechanics_only"),
  aggregate: aggregateSchema,
  claims: claimsSchema,
  effectClaimAllowed: z.literal(false),
  evidenceClass: z.literal("product_path_structural_causal_mechanics"),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  implementationSha256s: nonemptySha256ListSchema,
  liveModelConsumptionObserved: z.literal(false),
  pairs: z.array(pairReceiptSchema).length(4),
  protocolSha256: sha256Schema,
  providerCalls: z.literal(0),
  receiptType: z.literal("mechanics-receipt-v1"),
  schemaVersion: z.literal(1),
}).strict();

export const memE0MechanicsReceiptSchema = mechanicsReceiptContentSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  for (const [index, caseId] of MEM_E0_CASE_IDS.entries()) {
    const pair = value.pairs[index];
    const expectedClass = caseId === "mem-e0-harm-control"
      ? "harm_control"
      : "memory_dependent";
    if (pair?.caseId !== caseId || pair.caseClass !== expectedClass) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 receipt pairs must use the frozen case order and classes",
        path: ["pairs", index],
      });
    }
  }
  const expected = scoreParsedPairs(value.pairs);
  if (sha256Canonical(value.aggregate) !== sha256Canonical(expected.aggregate)) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 mechanics aggregate must be derived from pairs",
      path: ["aggregate"],
    });
  }
  if (sha256Canonical(value.claims) !== sha256Canonical(expected.claims)) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 mechanics claims must be derived from pairs",
      path: ["claims"],
    });
  }
  const { receiptSha256, ...content } = value;
  if (receiptSha256 !== sha256Canonical(content)) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 mechanics receipt canonical self-hash mismatch",
      path: ["receiptSha256"],
    });
  }
});

export interface MemE0MechanicsArmEvidenceInput {
  readonly admittedRecordIdSha256: string;
  readonly admittedRecordLogicalSha256: string;
  readonly armContractObserved: boolean;
  readonly freshVerifierPassed: boolean;
  readonly historicalItemCount: number;
  readonly observationSha256s: readonly string[];
  readonly productPathObserved: boolean;
  readonly selectedMemoryValueSha256s: readonly string[];
  readonly selectedRecordIdSha256s: readonly string[];
  readonly toolArgumentSha256s: readonly string[];
  readonly toolNames: readonly z.infer<typeof toolNameSchema>[];
}

export interface MemE0MechanicsPairInput {
  readonly caseClass: "harm_control" | "memory_dependent";
  readonly caseId: MemE0CaseId;
  readonly distinctOsProcesses: boolean;
  readonly off: MemE0MechanicsArmEvidenceInput;
  readonly on: MemE0MechanicsArmEvidenceInput;
  readonly processBoundaryObservationSha256: string;
}

export interface MemE0MechanicsReceiptInput {
  readonly implementationSha256s: readonly string[];
  readonly pairs: readonly MemE0MechanicsPairInput[];
  readonly protocolSha256: string;
}
export type MemE0MechanicsPair = Readonly<z.infer<typeof pairReceiptSchema>>;
export type MemE0MechanicsReceipt = Readonly<
  z.infer<typeof memE0MechanicsReceiptSchema>
>;
export type MemE0MechanicsScore = Readonly<{
  readonly aggregate: Readonly<z.infer<typeof aggregateSchema>>;
  readonly claims: Readonly<z.infer<typeof claimsSchema>>;
  readonly pairs: readonly MemE0MechanicsPair[];
}>;

function hasSuccessfulToolChain(arm: z.infer<typeof armEvidenceInputSchema>): boolean {
  return ["read_file", "apply_patch", "run_command", "finish_task"].every((name) =>
    arm.toolNames.includes(name as z.infer<typeof toolNameSchema>)
  ) && arm.toolArgumentSha256s.length >= 4;
}

function scoreArm(
  arm: z.infer<typeof armEvidenceInputSchema>,
  armName: "off" | "on",
  caseClass: "memory_dependent" | "harm_control",
): z.infer<typeof armReceiptSchema> {
  const selectedRecordBound = arm.historicalItemCount === 0
    ? arm.selectedRecordIdSha256s.length === 0 &&
      arm.selectedMemoryValueSha256s.length === 0
    : arm.selectedRecordIdSha256s.length === 1 &&
      arm.selectedRecordIdSha256s[0] === arm.admittedRecordIdSha256 &&
      arm.selectedMemoryValueSha256s.length === 1;
  const recallContractObserved = armName === "off"
    ? arm.historicalItemCount === 0 && selectedRecordBound
    : caseClass === "memory_dependent"
      ? arm.historicalItemCount === 1 && selectedRecordBound
      : selectedRecordBound;
  const successfulEffectObserved = !arm.freshVerifierPassed || hasSuccessfulToolChain(arm);
  return armReceiptSchema.parse({
    ...arm,
    arm: armName,
    eligible:
      arm.armContractObserved &&
      arm.productPathObserved &&
      recallContractObserved &&
      successfulEffectObserved,
    memoryMode: armName === "off" ? "off" : "local",
  });
}

function scorePair(
  input: z.infer<typeof pairInputSchema> | Readonly<{
    readonly caseClass: "memory_dependent" | "harm_control";
    readonly caseId: MemE0CaseId;
    readonly distinctOsProcesses: boolean;
    readonly off: z.infer<typeof armEvidenceInputSchema> | z.infer<typeof armReceiptSchema>;
    readonly on: z.infer<typeof armEvidenceInputSchema> | z.infer<typeof armReceiptSchema>;
    readonly processBoundaryObservationSha256: string;
  }>,
): MemE0MechanicsPair {
  const off = scoreArm(input.off, "off", input.caseClass);
  const on = scoreArm(input.on, "on", input.caseClass);
  const sameLogicalMemory =
    off.admittedRecordLogicalSha256 === on.admittedRecordLogicalSha256;
  const productPathObserved = off.productPathObserved && on.productPathObserved;
  const eligible =
    off.eligible &&
    on.eligible &&
    input.distinctOsProcesses &&
    sameLogicalMemory &&
    productPathObserved;
  const outcome = !eligible
    ? "inconclusive_invalid_pair" as const
    : off.freshVerifierPassed
      ? on.freshVerifierPassed
        ? "both_pass" as const
        : "baseline_only_regression" as const
      : on.freshVerifierPassed
        ? "candidate_only_win" as const
        : "both_fail" as const;
  return Object.freeze({
    caseClass: input.caseClass,
    caseId: input.caseId,
    distinctOsProcesses: input.distinctOsProcesses,
    eligible,
    off,
    on,
    outcome,
    processBoundaryObservationSha256: input.processBoundaryObservationSha256,
    productPathObserved,
    sameLogicalMemory,
  });
}

function scoreParsedPairs(pairs: readonly MemE0MechanicsPair[]): Readonly<{
  readonly aggregate: z.infer<typeof aggregateSchema>;
  readonly claims: z.infer<typeof claimsSchema>;
}> {
  const outcomeCounts = {
    baselineOnlyRegression: pairs.filter(
      (pair) => pair.outcome === "baseline_only_regression",
    ).length,
    bothFail: pairs.filter((pair) => pair.outcome === "both_fail").length,
    bothPass: pairs.filter((pair) => pair.outcome === "both_pass").length,
    candidateOnlyWin: pairs.filter(
      (pair) => pair.outcome === "candidate_only_win",
    ).length,
    inconclusiveInvalidPair: pairs.filter(
      (pair) => pair.outcome === "inconclusive_invalid_pair",
    ).length,
  };
  const allPairsEligible = pairs.every((pair) => pair.eligible);
  const expectedOutcomesObserved = pairs.every((pair) =>
    pair.caseClass === "memory_dependent"
      ? pair.outcome === "candidate_only_win"
      : pair.outcome === "both_pass"
  );
  const structuralMechanics = !allPairsEligible
    ? {
        reasonCode: "one_or_more_pairs_ineligible" as const,
        result: "inconclusive" as const,
      }
    : expectedOutcomesObserved
      ? {
          reasonCode: "all_pairs_eligible_expected_outcomes_observed" as const,
          result: "supported" as const,
        }
      : {
          reasonCode: "eligible_pair_outcome_mismatch" as const,
          result: "refuted" as const,
        };
  return Object.freeze({
    aggregate: aggregateSchema.parse({
      armCount: 8,
      eligibleArmCount: pairs.flatMap((pair) => [pair.off, pair.on]).filter(
        (arm) => arm.eligible,
      ).length,
      eligiblePairCount: pairs.filter((pair) => pair.eligible).length,
      harmControlPairCount: pairs.filter(
        (pair) => pair.caseClass === "harm_control",
      ).length,
      memoryDependentPairCount: pairs.filter(
        (pair) => pair.caseClass === "memory_dependent",
      ).length,
      observationHashCount: pairs.reduce(
        (count, pair) => count + pair.off.observationSha256s.length +
          pair.on.observationSha256s.length,
        0,
      ),
      outcomeCounts,
      pairCount: 4,
      selectedRecordHashCount: pairs.reduce(
        (count, pair) => count + pair.off.selectedRecordIdSha256s.length +
          pair.off.selectedMemoryValueSha256s.length +
          pair.on.selectedRecordIdSha256s.length +
          pair.on.selectedMemoryValueSha256s.length,
        0,
      ),
      toolArgumentHashCount: pairs.reduce(
        (count, pair) => count + pair.off.toolArgumentSha256s.length +
          pair.on.toolArgumentSha256s.length,
        0,
      ),
    }),
    claims: claimsSchema.parse({
      liveEffect: {
        reasonCode: "deterministic_mechanics_only",
        result: "not_run",
      },
      structuralMechanics,
    }),
  });
}

export function scoreMemE0MechanicsPairs(
  value: unknown,
): MemE0MechanicsScore {
  const parsed = pairInputListSchema.parse(value);
  const pairs = Object.freeze(parsed.map((pair) => scorePair(pair)));
  const scored = scoreParsedPairs(pairs);
  return Object.freeze({ ...scored, pairs });
}

export function createMemE0MechanicsReceipt(
  value: MemE0MechanicsReceiptInput,
): MemE0MechanicsReceipt {
  const parsed = receiptInputSchema.parse(value);
  const scored = scoreMemE0MechanicsPairs(parsed.pairs);
  const content = mechanicsReceiptContentSchema.parse({
    actorClass: "deterministic_mechanics_only",
    aggregate: scored.aggregate,
    claims: scored.claims,
    effectClaimAllowed: false,
    evidenceClass: "product_path_structural_causal_mechanics",
    experimentId: MEM_E0_EXPERIMENT_ID,
    implementationSha256s: parsed.implementationSha256s,
    liveModelConsumptionObserved: false,
    pairs: scored.pairs,
    protocolSha256: parsed.protocolSha256,
    providerCalls: 0,
    receiptType: "mechanics-receipt-v1",
    schemaVersion: 1,
  });
  return parseMemE0MechanicsReceipt({
    ...content,
    receiptSha256: sha256Canonical(content),
  });
}

export function parseMemE0MechanicsReceipt(
  value: unknown,
): MemE0MechanicsReceipt {
  return Object.freeze(memE0MechanicsReceiptSchema.parse(value));
}
