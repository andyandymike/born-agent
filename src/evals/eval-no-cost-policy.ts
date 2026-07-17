import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError, evalHarnessInvariant } from "./eval-errors.js";

const inProcessSourceSchema = z
  .object({
    kind: z.literal("in_process_test"),
    provider: z.enum(["fake", "mock"]),
  })
  .strict();

const localOllamaSourceSchema = z
  .object({
    kind: z.literal("local_ollama"),
    provider: z.literal("ollama"),
    endpoint: z.string(),
    installedModelTag: z.string().min(1).max(512),
    installedModelDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u),
  })
  .strict();

export const evalExecutionSourceSchema = z.discriminatedUnion("kind", [
  inProcessSourceSchema,
  localOllamaSourceSchema,
]);

export type EvalExecutionSource = z.infer<typeof evalExecutionSourceSchema>;

export interface EvalNoCostEvidence {
  readonly policy: "zero-paid-provider-v1";
  readonly policySha256: string;
  readonly sourceKind: EvalExecutionSource["kind"];
  readonly endpointScope: "none" | "literal_loopback";
  readonly credentialAccessEnabled: false;
  readonly proxyEnabled: false;
  readonly redirectsEnabled: false;
  readonly remoteFallbackEnabled: false;
  readonly automaticPullEnabled: false;
  readonly billableProviderRequestsSent: 0;
  readonly forbiddenProviderRequestsBlocked: number;
  readonly estimatedCostUsd: null;
  readonly billedCostUsd: null;
  readonly costReason: "test_backend" | "local_unpriced_backend";
}

const NO_COST_POLICY_DEFINITION = Object.freeze({
  policy: "zero-paid-provider-v1",
  allowedSources: ["in_process_test:fake", "in_process_test:mock", "local_ollama:literal_loopback"],
  credentialAccessEnabled: false,
  proxyEnabled: false,
  redirectsEnabled: false,
  remoteFallbackEnabled: false,
  automaticPullEnabled: false,
});

export const EVAL_NO_COST_POLICY_SHA256 = sha256Canonical(NO_COST_POLICY_DEFINITION);

function assertLiteralLoopbackEndpoint(endpoint: string): void {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(endpoint);
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new EvalCoreError(
      "eval_no_cost_source_forbidden",
      "Ollama eval endpoint must be literal http://127.0.0.1:<port> or http://[::1]:<port>",
      2,
    );
  }
}

function parseAllowedSource(input: unknown): EvalExecutionSource {
  const parsed = evalExecutionSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError(
      "eval_no_cost_source_forbidden",
      "eval source is not a pinned in-process test backend or local Ollama descriptor",
      2,
      { cause: parsed.error },
    );
  }
  if (parsed.data.kind === "local_ollama") {
    assertLiteralLoopbackEndpoint(parsed.data.endpoint);
  }
  return Object.freeze(parsed.data);
}

export interface EvalTurnGuard {
  readonly sourceSha256: string;
  readonly evidence: EvalNoCostEvidence;
  assertBeforeModelTurn(currentSource: unknown): void;
}

export function preflightEvalNoCostPolicy(input: unknown): EvalTurnGuard {
  // PHASE14: a provider label is not a security boundary; source classification happens before credentials, backend construction, or transport.
  const source = parseAllowedSource(input);
  const sourceSha256 = sha256Canonical(source);
  const evidence: EvalNoCostEvidence = Object.freeze({
    policy: "zero-paid-provider-v1",
    policySha256: EVAL_NO_COST_POLICY_SHA256,
    sourceKind: source.kind,
    endpointScope: source.kind === "local_ollama" ? "literal_loopback" : "none",
    credentialAccessEnabled: false,
    proxyEnabled: false,
    redirectsEnabled: false,
    remoteFallbackEnabled: false,
    automaticPullEnabled: false,
    billableProviderRequestsSent: 0,
    forbiddenProviderRequestsBlocked: 0,
    estimatedCostUsd: null,
    billedCostUsd: null,
    costReason: source.kind === "local_ollama" ? "local_unpriced_backend" : "test_backend",
  });
  return Object.freeze({
    sourceSha256,
    evidence,
    assertBeforeModelTurn(currentSource: unknown): void {
      // PHASE14: loopback transport disables proxy, redirects, fallback, and pulls, then rechecks the frozen source before every turn to stop TOCTOU drift.
      let current: EvalExecutionSource;
      try {
        current = parseAllowedSource(currentSource);
      } catch {
        throw evalHarnessInvariant("eval execution source became forbidden after preflight");
      }
      if (sha256Canonical(current) !== sourceSha256) {
        throw evalHarnessInvariant("eval execution source changed after no-cost preflight");
      }
    },
  });
}

export interface FullSuitePolicyRefusal {
  readonly authorized: false;
  readonly reason: "full_suite_forbidden_by_policy";
  readonly exitCode: 2;
  readonly fixedTaskIds: readonly string[];
  readonly attemptsStarted: 0;
  readonly providerRequestsSent: 0;
  readonly fullSuiteExecution: "not_run_by_policy";
  readonly noCostEvidence: EvalNoCostEvidence;
}

export function refuseFullSuiteExecution(
  fixedTaskIds: readonly string[],
  source: unknown,
): FullSuitePolicyRefusal {
  const guard = preflightEvalNoCostPolicy(source);
  // PHASE14: full manifests may be loaded and planned offline, but this phase records refusal before any attempt/backend as the only honest execution evidence.
  return Object.freeze({
    authorized: false,
    reason: "full_suite_forbidden_by_policy",
    exitCode: 2,
    fixedTaskIds: Object.freeze([...fixedTaskIds]),
    attemptsStarted: 0,
    providerRequestsSent: 0,
    fullSuiteExecution: "not_run_by_policy",
    noCostEvidence: guard.evidence,
  });
}
