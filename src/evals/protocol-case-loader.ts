import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";

const caseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const protocolCasesSchema = z
  .object({
    schema_version: z.literal(1),
    cases: z
      .array(
        z
          .object({
            id: caseIdSchema,
            value: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

const observationSchema = z
  .object({
    case_id: caseIdSchema,
    value: z.unknown(),
  })
  .strict();

export interface LoadedProtocolCases {
  readonly inputs: ReadonlyMap<string, unknown>;
  readonly expected: ReadonlyMap<string, unknown>;
  readonly caseIds: readonly string[];
  readonly casesSha256: string;
}

function parseCases(input: unknown, label: string): ReadonlyMap<string, unknown> {
  const parsed = protocolCasesSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_case_protocol_invalid", `${label} case bundle is invalid`, 1, {
      cause: parsed.error,
    });
  }
  const result = new Map<string, unknown>();
  for (const item of parsed.data.cases) {
    if (result.has(item.id)) {
      throw new EvalCoreError("eval_case_protocol_invalid", `${label} contains duplicate case ID '${item.id}'`, 1);
    }
    result.set(item.id, item.value);
  }
  return result;
}

export function loadProtocolCases(inputs: unknown, expected: unknown): LoadedProtocolCases {
  // PHASE14: inputs and expectations remain separate host-only bundles; exact case-ID equality prevents order-based accidental grading.
  const inputMap = parseCases(inputs, "input");
  const expectedMap = parseCases(expected, "expected");
  const inputIds = [...inputMap.keys()].sort();
  const expectedIds = [...expectedMap.keys()].sort();
  if (canonicalJson(inputIds) !== canonicalJson(expectedIds)) {
    throw new EvalCoreError("eval_case_protocol_invalid", "input and expected case IDs must match exactly", 1);
  }
  return Object.freeze({
    inputs: inputMap,
    expected: expectedMap,
    caseIds: Object.freeze(inputIds),
    casesSha256: sha256Canonical({
      inputs: inputIds.map((id) => ({ id, value: inputMap.get(id) })),
      expected: expectedIds.map((id) => ({ id, value: expectedMap.get(id) })),
    }),
  });
}

export function decodeProtocolObservations(
  utf8: string,
  requiredCaseIds: readonly string[],
  limits: { readonly maxFrameBytes: number; readonly maxTotalBytes: number },
): ReadonlyMap<string, unknown> {
  if (Buffer.byteLength(utf8, "utf8") > limits.maxTotalBytes) {
    throw new EvalCoreError("eval_case_protocol_invalid", "worker observation stream exceeds total byte limit", 1);
  }
  if (!utf8.endsWith("\n")) {
    throw new EvalCoreError("eval_case_protocol_invalid", "worker observation stream must end at a JSONL frame boundary", 1);
  }
  const required = new Set(requiredCaseIds);
  const observed = new Map<string, unknown>();
  for (const line of utf8.slice(0, -1).split("\n")) {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > limits.maxFrameBytes) {
      throw new EvalCoreError("eval_case_protocol_invalid", "worker emitted an empty or oversized JSONL frame", 1);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      throw new EvalCoreError("eval_case_protocol_invalid", "worker emitted invalid JSONL", 1, { cause: error });
    }
    const parsed = observationSchema.safeParse(decoded);
    if (!parsed.success || !required.has(parsed.data.case_id) || observed.has(parsed.data.case_id)) {
      throw new EvalCoreError(
        "eval_case_protocol_invalid",
        "worker emitted an unknown, duplicate, or malformed observation",
        1,
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    observed.set(parsed.data.case_id, parsed.data.value);
  }
  if (observed.size !== required.size) {
    throw new EvalCoreError("eval_case_protocol_invalid", "worker omitted one or more required observations", 1);
  }
  return observed;
}
