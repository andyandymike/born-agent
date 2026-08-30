import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  callDeepSeekReader,
  DEEPSEEK_DOCUMENTED_MODEL_VERSION,
  DEEPSEEK_MODEL_ALIAS,
  DEEPSEEK_OUTPUT_SCHEMA_SHA256,
  DEEPSEEK_PRICING_SNAPSHOT,
  DEEPSEEK_READER_PROMPT_CONTRACT_SHA256,
  DEEPSEEK_RESPONSES_ENDPOINT,
  type DeepSeekFetch,
} from "./deepseek-reader-worker.js";
import { rawSha256 } from "./reader-worker.js";

const smokeExpectations = Object.freeze([
  Object.freeze({
    probeId: "smoke-probe-1",
    action: "answer" as const,
    answerFragments: Object.freeze(["cobalt-blue"]),
    evidenceRefs: Object.freeze(["record:smoke-record-1"]),
  }),
  Object.freeze({
    probeId: "smoke-probe-2",
    action: "answer" as const,
    answerFragments: Object.freeze(["alpha", "beta"]),
    evidenceRefs: Object.freeze([
      "record:smoke-record-2-old",
      "record:smoke-record-2-current",
    ]),
  }),
  Object.freeze({
    probeId: "smoke-probe-3",
    action: "abstain" as const,
    answerFragments: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
  }),
  Object.freeze({
    probeId: "smoke-probe-4",
    action: "answer" as const,
    answerFragments: Object.freeze(["48000hz"]),
    evidenceRefs: Object.freeze(["record:smoke-record-4"]),
  }),
  Object.freeze({
    probeId: "smoke-probe-5",
    action: "abstain" as const,
    answerFragments: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
  }),
]);

export const DEEPSEEK_READER_SMOKE_PROMPT = [
  "Read this JSON evidence packet. Each question embeds exactly the record evidence available for that question.",
  "Return the five listed probeIds exactly once, in the listed order as valid json.",
  "Answer only from the listed evidence; otherwise abstain with answer=\"\" and evidenceRefs=[].",
  JSON.stringify({
    schemaVersion: 2,
    timelineId: "deepseek-reader-smoke",
    batchOrdinal: 0,
    asOf: "2026-08-30T00:00:00.000Z",
    receiptContext: "BORNAGENT_TASK_CONTEXT_V1\n{\"acceptedChildReceipts\":[]}",
    questions: [
      {
        probeId: "smoke-probe-1",
        query: "What is the frozen launch color?",
        contextBudgetTokens: 2_048,
        recordEvidence: [{
          evidenceRef: "record:smoke-record-1",
          occurredAt: "2026-08-01T00:00:00.000Z",
          title: "Frozen launch color",
          text: "The frozen launch color is cobalt-blue.",
        }],
      },
      {
        probeId: "smoke-probe-2",
        query: "Give the previous-to-current channel sequence.",
        contextBudgetTokens: 2_048,
        recordEvidence: [
          {
            evidenceRef: "record:smoke-record-2-old",
            occurredAt: "2026-08-01T00:00:00.000Z",
            title: "Previous channel",
            text: "The previous channel was alpha.",
          },
          {
            evidenceRef: "record:smoke-record-2-current",
            occurredAt: "2026-08-02T00:00:00.000Z",
            title: "Current channel",
            text: "Beta replaced alpha as the current channel.",
          },
        ],
      },
      {
        probeId: "smoke-probe-3",
        query: "Who owns the rollback pager?",
        contextBudgetTokens: 2_048,
        recordEvidence: [],
      },
      {
        probeId: "smoke-probe-4",
        query: "当前生效的音频采样率是多少？",
        contextBudgetTokens: 2_048,
        recordEvidence: [{
          evidenceRef: "record:smoke-record-4",
          occurredAt: "2026-08-03T00:00:00.000Z",
          title: "Current audio sample rate",
          text: "The current authoritative audio sample rate is 48000Hz.",
        }],
      },
      {
        probeId: "smoke-probe-5",
        query: "What is the emergency rollback phone number?",
        contextBudgetTokens: 2_048,
        recordEvidence: [{
          evidenceRef: "record:smoke-record-5-near-miss",
          occurredAt: "2026-08-04T00:00:00.000Z",
          title: "Maintenance window",
          text: "The maintenance window starts at 03:00 UTC; no phone number is recorded.",
        }],
      },
    ],
  }),
].join("\n");

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export async function runDeepSeekReaderSmoke(input: Readonly<{
  readonly apiKey: string;
  readonly fetchImpl?: DeepSeekFetch;
  readonly generatedAt: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}>): Promise<Readonly<Record<string, unknown>>> {
  const call = await callDeepSeekReader({
    apiKey: input.apiKey,
    expectedProbeIds: smokeExpectations.map((entry) => entry.probeId),
    prompt: DEEPSEEK_READER_SMOKE_PROMPT,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const failures: string[] = [];
  if (call.parseState !== "parsed") failures.push(`parse_state_${call.parseState}`);
  for (const expectation of smokeExpectations) {
    const answer = call.answers.find((entry) => entry.probeId === expectation.probeId);
    if (answer === undefined) {
      failures.push(`${expectation.probeId}_missing`);
      continue;
    }
    if (answer.action !== expectation.action) {
      failures.push(`${expectation.probeId}_wrong_action`);
    }
    const renderedAnswer = normalized(answer.answer);
    if (expectation.answerFragments.some((fragment) => !renderedAnswer.includes(fragment))) {
      failures.push(`${expectation.probeId}_missing_answer_fragment`);
    }
    if (expectation.action === "abstain" && answer.answer !== "") {
      failures.push(`${expectation.probeId}_nonempty_abstention`);
    }
    const actualRefs = [...answer.evidenceRefs].sort();
    const expectedRefs = [...expectation.evidenceRefs].sort();
    if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
      failures.push(`${expectation.probeId}_wrong_evidence_refs`);
    }
  }
  const content = Object.freeze({
    schemaVersion: 1,
    benchmarkId: "fal-memory-shared-v1",
    smokeId: "deepseek-reader-json-schema-v1",
    generatedAt: input.generatedAt,
    executionBoundary: "fixed_public_synthetic_smoke_allowlisted_remote_model_only",
    provider: "deepseek",
    api: "responses",
    endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
    modelAlias: DEEPSEEK_MODEL_ALIAS,
    documentedModelVersion: DEEPSEEK_DOCUMENTED_MODEL_VERSION,
    promptContractSha256: DEEPSEEK_READER_PROMPT_CONTRACT_SHA256,
    outputSchemaSha256: DEEPSEEK_OUTPUT_SCHEMA_SHA256,
    smokePromptSha256: rawSha256(DEEPSEEK_READER_SMOKE_PROMPT),
    pricing: DEEPSEEK_PRICING_SNAPSHOT,
    maximumAttempts: 1,
    externalNetworkCalls: 1,
    parseState: call.parseState,
    passed: failures.length === 0,
    failureReasons: Object.freeze(failures),
    answers: call.answers,
    rawResponse: call.rawResponse,
    rawResponseSha256: rawSha256(call.rawResponse),
    callReceipt: call.receipt,
  });
  return Object.freeze({ ...content, smokeReceiptSha256: sha256Canonical(content) });
}
