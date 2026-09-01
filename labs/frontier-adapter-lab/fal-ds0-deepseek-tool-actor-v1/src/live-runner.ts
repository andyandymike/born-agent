import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { executeAgent } from "../../../../src/commands/agent.js";
import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { executeModelsQualify } from "../../../../src/commands/model-qualification.js";
import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import type { CliIO, CliRuntime, OutputWriter } from "../../../../src/cli/types.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { ModelEvidence } from "../../../../src/completion/completion-types.js";
import type { ModelUsage } from "../../../../src/model/model-events.js";
import {
  modelQualificationRecordSchema,
  type ModelQualificationRecordV1,
} from "../../../../src/model/model-qualification-schema.js";
import { loadRuntimePolicyRegistry } from "../../../../src/policy/policy-config-loader.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
} from "../../../../src/policy/policy-resolver.js";
import { runReportSchema, type RunReport } from "../../../../src/reports/run-report-schema.js";
import { V2SessionWriter } from "../../../../src/sessions/v2-session-writer.js";

import { Ds0ExactSmokeApprovalPrompt } from "./exact-smoke-approval.js";
import {
  DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS,
  DS0_ACTOR_MAXIMUM_REPORTED_TOKENS,
  DS0_BASE_URL,
  DS0_COMBINED_MAXIMUM_PROVIDER_REQUESTS,
  DS0_EXPERIMENT_ID,
  DS0_LIVE_CONFIRMATION_USD,
  DS0_LIVE_CONFIRMATION_USD_MICROS,
  DS0_MODEL,
  DS0_POLICY_PROFILE,
  DS0_PROVIDER,
  DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
  DS0_UNREPORTED_QUALIFICATION_REQUEST_RESERVE_TOKENS,
  ds0FixturePath,
  readDs0Contract,
  type Ds0Contract,
} from "./ds0-contract.js";
import {
  aggregateDs0Usage,
  ds0PriceBandAt,
  Ds0ProviderCapError,
  Ds0ProviderMeter,
  estimateDs0Cost,
  type Ds0UsageAggregate,
} from "./provider-meter.js";
import {
  createDs0PublicSmokeWorkspace,
  DS0_PUBLIC_SMOKE_FIXED_SHA256,
  DS0_PUBLIC_SMOKE_TARGET,
  verifyDs0PublicSmokeWorkspace,
} from "./public-smoke-workspace.js";

const QUALIFICATION_EVIDENCE_REF =
  ".bornagent/ds0/qualification-record.json" as const;
const OBSERVATION_ROOT =
  ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs" as const;

export function ds0CodingSystemInstructionSha256(): string {
  return createHash("sha256")
    .update(AGENT_SYSTEM_INSTRUCTIONS, "utf8")
    .digest("hex");
}

function ds0ActorConfiguration(
  protocolSha256: string,
): Readonly<{
  readonly actorConfigurationSha256: string;
  readonly codingSystemInstructionSha256: string;
}> {
  const codingSystemInstructionSha256 = ds0CodingSystemInstructionSha256();
  return Object.freeze({
    actorConfigurationSha256: sha256Canonical({
      codingSystemInstructionSha256,
      model: DS0_MODEL,
      policyProfile: DS0_POLICY_PROFILE,
      protocolSha256,
      provider: DS0_PROVIDER,
    }),
    codingSystemInstructionSha256,
  });
}

export interface Ds0AuthorizedRunInput {
  readonly contract: Ds0Contract;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: CliIO;
  readonly repositoryRoot: string;
}

export type Ds0AuthorizedExecutor = (
  input: Ds0AuthorizedRunInput,
) => Promise<0 | 1 | 2>;

interface MemoryIO {
  readonly io: CliIO;
  readonly readStderr: () => string;
  readonly readStdout: () => string;
}

function memoryIO(): MemoryIO {
  let stderr = "";
  let stdout = "";
  return {
    io: {
      stderr: { write: (value) => { stderr += value; } },
      stdout: { write: (value) => { stdout += value; } },
    },
    readStderr: () => stderr,
    readStdout: () => stdout,
  };
}

function jsonLine(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value)}\n`);
}

function normalizedRelativePath(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error("DS0 output escaped the repository root");
  }
  return value;
}

function isolatedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  stateRoot: string,
  apiKey: string,
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {
    APPDATA: join(stateRoot, "appdata"),
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    DEEPSEEK_API_KEY: apiKey,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LOCALAPPDATA: join(stateRoot, "localappdata"),
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: join(stateRoot, "temp"),
    TMP: join(stateRoot, "temp"),
    USERPROFILE: join(stateRoot, "profile"),
    WINDIR: source.WINDIR,
    XDG_STATE_HOME: join(stateRoot, "xdg-state"),
  };
  return Object.freeze(environment);
}

function createDs0NodeRuntime(
  workspace: string,
  stateRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  approval: Ds0ExactSmokeApprovalPrompt,
): CliRuntime {
  return createNodeRuntime({
    approvalInput: {
      interactive: false,
      readLine: async () => null,
    },
    approvalPromptOverride: approval,
    capabilityUserStateRoot: join(stateRoot, "capabilities"),
    cwd: workspace,
    delegationUserStateRoot: join(stateRoot, "delegations"),
    env,
    execPath: process.execPath,
    killProcess: (processIdentity, signal) => process.kill(processIdentity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0-fal-ds0",
    workerUserStateRoot: join(stateRoot, "workers"),
    worktreeUserStateRoot: join(stateRoot, "worktrees"),
  });
}

async function validatePolicy(
  repositoryRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  trustedPolicyConfig: string,
): Promise<Readonly<{ readonly policyHash: string }>> {
  const registry = await loadRuntimePolicyRegistry({
    configPath: trustedPolicyConfig,
    env,
    platform: process.platform,
    workspace: repositoryRoot,
  });
  const effective = resolveEffectiveRuntimePolicy(registry, DS0_POLICY_PROFILE);
  const request = resolveProviderPolicyRequest(effective, {
    model: DS0_MODEL,
    provider: DS0_PROVIDER,
  });
  if (
    request.endpoint !== DS0_BASE_URL ||
    request.model !== DS0_MODEL ||
    request.provider !== DS0_PROVIDER ||
    request.source !== "provider_network"
  ) {
    throw new Error("DS0 remote policy did not resolve the exact actor identity");
  }
  const access = effective.entry.profile.modelAccess;
  if (
    access.kind !== "remote_explicit" ||
    access.limits.maxProviderRequestsPerRun !==
      DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS ||
    access.limits.maxOutputTokensPerRequest !== 4_096 ||
    access.limits.maxReportedTotalTokensPerRun !==
      DS0_ACTOR_MAXIMUM_REPORTED_TOKENS
  ) {
    throw new Error("DS0 remote policy ceilings drifted");
  }
  return Object.freeze({ policyHash: effective.evidence.profileSha256 });
}

async function materializeDs0Policy(
  repositoryRoot: string,
  stateRoot: string,
): Promise<string> {
  const source = await readFile(
    ds0FixturePath(repositoryRoot, "remote-policy.json"),
    "utf8",
  );
  const path = join(stateRoot, "ds0-remote-policy.json");
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

function parseQualificationRecord(stdout: string) {
  const decoded = JSON.parse(stdout) as unknown;
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    !("record" in decoded)
  ) {
    throw new Error("DS0 qualification did not return a record envelope");
  }
  return modelQualificationRecordSchema.parse(decoded.record);
}

function parseRunReport(stdout: string): RunReport | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith("{")) continue;
    const parsed = runReportSchema.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function sessionUsage(writer: V2SessionWriter): readonly ModelUsage[] {
  const usage: ModelUsage[] = [];
  for (const event of writer.events) {
    if (event.scope !== "run" || event.type !== "model.usage") continue;
    const data = event.data;
    if (!("completeness" in data)) {
      usage.push({
        cacheReadTokens: data.cached_input_tokens ?? 0,
        cacheWriteTokens: 0,
        completeness: "complete",
        inputTokens: data.input_tokens,
        outputTokens: data.output_tokens,
        totalTokens: data.total_tokens,
      });
      continue;
    }
    if (data.completeness === "partial") {
      usage.push({
        cacheReadTokens: data.cache_read_tokens,
        cacheWriteTokens: data.cache_write_tokens,
        completeness: "partial",
        inputTokens: data.input_tokens,
        outputTokens: data.output_tokens,
        totalTokens: data.total_tokens,
      });
      continue;
    }
    usage.push({
      cacheReadTokens: data.cache_read_tokens,
      cacheWriteTokens: data.cache_write_tokens,
      completeness: "complete",
      inputTokens: data.input_tokens,
      outputTokens: data.output_tokens,
      totalTokens: data.total_tokens,
    });
  }
  return Object.freeze(usage);
}

const DS0_FAILURE_CATEGORIES = new Set([
  "authentication",
  "permission",
  "auth",
  "rate_limit",
  "quota",
  "network",
  "provider",
  "timeout",
  "invalid_request",
  "model_not_found",
  "protocol",
  "cancelled",
  "storage",
  "internal",
]);

export interface Ds0TerminalRunFailure {
  readonly category: string;
  readonly code: string;
  readonly steps: number | null;
  readonly tool_calls: number | null;
}

export function extractDs0TerminalRunFailure(
  events: readonly Readonly<{
    readonly data: unknown;
    readonly scope: string;
    readonly type: string;
  }>[],
): Ds0TerminalRunFailure | null {
  const terminal = [...events].reverse().find(
    (event) => event.scope === "run" && event.type === "run.failed",
  );
  if (
    terminal === undefined ||
    terminal.data === null ||
    typeof terminal.data !== "object" ||
    Array.isArray(terminal.data)
  ) {
    return null;
  }
  const data = terminal.data as Readonly<Record<string, unknown>>;
  if (
    typeof data.category !== "string" ||
    !DS0_FAILURE_CATEGORIES.has(data.category) ||
    typeof data.code !== "string" ||
    !/^[a-z0-9_]+$/u.test(data.code)
  ) {
    throw new Error("DS0 terminal run failure is not schema-safe");
  }
  const steps = data.steps;
  const toolCalls = data.tool_calls;
  if (
    steps !== undefined &&
    (typeof steps !== "number" || !Number.isSafeInteger(steps) || steps < 0)
  ) {
    throw new Error("DS0 terminal run failure steps are invalid");
  }
  if (
    toolCalls !== undefined &&
    (typeof toolCalls !== "number" ||
      !Number.isSafeInteger(toolCalls) ||
      toolCalls < 0)
  ) {
    throw new Error("DS0 terminal run failure tool calls are invalid");
  }
  // Deliberately omit message, provider_request_id, retryable, and every
  // provider/raw field even though the decoded session contains some of them.
  return Object.freeze({
    category: data.category,
    code: data.code,
    steps: (steps as number | undefined) ?? null,
    tool_calls: (toolCalls as number | undefined) ?? null,
  });
}

function sameUsage(
  left: Ds0UsageAggregate,
  right: Ds0UsageAggregate,
): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

async function writeObservation(
  repositoryRoot: string,
  runId: string,
  observationInput: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ readonly ref: string; readonly sha256: string }>> {
  const withoutHash = Object.freeze({
    ...observationInput,
    experimentId: DS0_EXPERIMENT_ID,
    runId,
    schemaVersion: 1,
  });
  const observationSha256 = sha256Canonical(withoutHash);
  const observation = Object.freeze({ ...withoutHash, observationSha256 });
  const directory = resolve(repositoryRoot, OBSERVATION_ROOT, runId);
  const path = join(directory, "observation.json");
  await mkdir(directory, { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(observation, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    ref: normalizedRelativePath(repositoryRoot, path),
    sha256: observationSha256,
  });
}

async function writeQualificationRecord(
  repositoryRoot: string,
  runId: string,
  recordInput: ModelQualificationRecordV1,
): Promise<Readonly<{
  readonly recordSha256: string;
  readonly ref: string;
}>> {
  const record = modelQualificationRecordSchema.parse(recordInput);
  const directory = resolve(repositoryRoot, OBSERVATION_ROOT, runId);
  const path = join(directory, "qualification-record.json");
  await mkdir(directory, { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    recordSha256: sha256Canonical(record),
    ref: normalizedRelativePath(repositoryRoot, path),
  });
}

function qualificationReserveCost(
  contract: Ds0Contract,
  unreportedRequestCount: number,
): number {
  const maximumPeakRate = Math.max(
    contract.peak.cachedInput,
    contract.peak.uncachedInput,
    contract.peak.output,
  );
  return Math.round(
    unreportedRequestCount *
      DS0_UNREPORTED_QUALIFICATION_REQUEST_RESERVE_TOKENS *
      maximumPeakRate,
  );
}

export function ds0UnreportedRequestCount(
  requestCount: number,
  usage: Ds0UsageAggregate,
): number {
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) {
    throw new TypeError("DS0 provider request count is invalid");
  }
  // Partial usage does not carry enough fields for replay pricing, so only a
  // complete event discharges one request from the conservative reserve.
  return Math.max(0, requestCount - usage.completeUsageEvents);
}

function qualificationCostSnapshot(
  contract: Ds0Contract,
  meter: Ds0ProviderMeter,
): Readonly<{
  readonly peakEstimatedUsdMicros: number;
  readonly reserveUsdMicros: number;
  readonly unreportedRequestCount: number;
  readonly usage: Ds0UsageAggregate;
}> {
  const usage = meter.usage();
  const unreportedRequestCount = ds0UnreportedRequestCount(
    meter.requestCount,
    usage,
  );
  const reserveUsdMicros = qualificationReserveCost(
    contract,
    unreportedRequestCount,
  );
  return Object.freeze({
    peakEstimatedUsdMicros:
      estimateDs0Cost(usage, contract.peak).costUsdMicros + reserveUsdMicros,
    reserveUsdMicros,
    unreportedRequestCount,
    usage,
  });
}

export function ds0ActorCostSnapshot(
  contract: Ds0Contract,
  backendMeterUsage: Ds0UsageAggregate,
  requestCount: number,
  applicableRates: Readonly<{
    readonly cachedInput: number;
    readonly output: number;
    readonly uncachedInput: number;
  }>,
): Readonly<{
  readonly applicableEstimatedUsdMicros: number;
  readonly peakEstimatedUsdMicros: number;
  readonly reserveUsdMicros: number;
  readonly unreportedRequestCount: number;
}> {
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) {
    throw new TypeError("DS0 actor request count is invalid");
  }
  const unreportedRequestCount = ds0UnreportedRequestCount(
    requestCount,
    backendMeterUsage,
  );
  const reserveUsdMicros =
    unreportedRequestCount *
    contract.actorConservativePeakUpperBoundUsdMicros;
  if (!Number.isSafeInteger(reserveUsdMicros)) {
    throw new Error("DS0 actor unreported-request reserve is invalid");
  }
  return Object.freeze({
    applicableEstimatedUsdMicros:
      estimateDs0Cost(backendMeterUsage, applicableRates).costUsdMicros +
      reserveUsdMicros,
    peakEstimatedUsdMicros:
      estimateDs0Cost(backendMeterUsage, contract.peak).costUsdMicros +
      reserveUsdMicros,
    reserveUsdMicros,
    unreportedRequestCount,
  });
}

function remoteModelEvidence(
  qualificationRequestCount: number,
  qualificationEvidenceSha256: string,
): ModelEvidence {
  return Object.freeze({
    backend: "deepseek",
    baseUrl: DS0_BASE_URL,
    endpointScope: "remote_https",
    kind: "remote_live_qualified",
    model: DS0_MODEL,
    provider: DS0_PROVIDER,
    qualificationCompletedRequestCount: qualificationRequestCount,
    qualificationEvidenceKind: "model_capability_probe_suite",
    qualificationEvidenceRef: QUALIFICATION_EVIDENCE_REF,
    qualificationEvidenceSha256,
    qualificationRequestCount,
    qualificationStatus: "passed",
    qualificationUsageCapability: "complete",
    remoteBillableRequests: qualificationRequestCount,
    remoteQualificationRequests: qualificationRequestCount,
    requestCountScope: "qualification_only",
  });
}

export async function runDs0AuthorizedProduction(
  input: Ds0AuthorizedRunInput,
): Promise<0 | 1 | 2> {
  const apiKey = input.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    input.io.stderr.write("DS0 live run blocked: DEEPSEEK_API_KEY is not configured.\n");
    return 2;
  }

  const runId = `ds0-${randomUUID()}`;
  const actorConfiguration = ds0ActorConfiguration(
    input.contract.protocolSha256,
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), "fal-ds0-live-"));
  const workspace = join(temporaryRoot, "workspace");
  const stateRoot = join(temporaryRoot, "state");
  const env = isolatedEnvironment(input.env, stateRoot, apiKey);
  const approval = new Ds0ExactSmokeApprovalPrompt();
  const actorWriter = { current: null as V2SessionWriter | null };
  let observedActorMeter: Ds0ProviderMeter | null = null;
  let observedQualificationMeter: Ds0ProviderMeter | null = null;
  let failureStage:
    | "actor"
    | "fresh_verification"
    | "preflight"
    | "qualification" = "preflight";
  try {
    await Promise.all([
      mkdir(join(stateRoot, "temp"), { recursive: true }),
      mkdir(join(stateRoot, "profile"), { recursive: true }),
    ]);
    const publicWorkspace = await createDs0PublicSmokeWorkspace({
      repositoryRoot: input.repositoryRoot,
      workspace,
    });
    const trustedPolicyConfig = await materializeDs0Policy(
      input.repositoryRoot,
      stateRoot,
    );
    const policy = await validatePolicy(
      input.repositoryRoot,
      env,
      trustedPolicyConfig,
    );

    const qualificationMeter = new Ds0ProviderMeter(
      "qualification",
      DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
      null,
    );
    observedQualificationMeter = qualificationMeter;
    const qualificationBase = createDs0NodeRuntime(
      workspace,
      stateRoot,
      env,
      approval,
    );
    const qualificationRuntime: CliRuntime = {
      ...qualificationBase,
      createModelBackend: (request) =>
        qualificationMeter.wrap(qualificationBase.createModelBackend(request)),
    };
    const qualificationIO = memoryIO();
    failureStage = "qualification";
    const qualificationExit = await executeModelsQualify(
      {
        confirmRemoteRequests: String(
          DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
        ),
        json: true,
        model: DS0_MODEL,
        policyConfig: trustedPolicyConfig,
        policyProfile: DS0_POLICY_PROFILE,
        provider: DS0_PROVIDER,
      },
      qualificationRuntime,
      qualificationIO.io,
    );
    let qualificationRecord;
    try {
      qualificationRecord = parseQualificationRecord(
        qualificationIO.readStdout(),
      );
    } catch {
      const failedCost = qualificationCostSnapshot(
        input.contract,
        qualificationMeter,
      );
      const written = await writeObservation(input.repositoryRoot, runId, {
        actor: null,
        configuration: actorConfiguration,
        combinedProviderRequests: qualificationMeter.requestCount,
        cost: {
          boundaryKind: "estimated_replay_not_provider_bill_cap",
          confirmedMaximumUsdMicros: DS0_LIVE_CONFIRMATION_USD_MICROS,
          peakEstimatedUsdMicros: failedCost.peakEstimatedUsdMicros,
          qualificationUnreportedRequestReserveUsdMicros:
            failedCost.reserveUsdMicros,
        },
        protocolSha256: input.contract.protocolSha256,
        pricingSha256: input.contract.pricingSha256,
        qualification: {
          exitCode: qualificationExit,
          recordAvailable: false,
          requestCount: qualificationMeter.requestCount,
          unreportedRequestCount: failedCost.unreportedRequestCount,
          usage: failedCost.usage,
        },
        status: "qualification_failed",
      });
      jsonLine(input.io.stdout, {
        event: "ds0_live_observation_written",
        observationRef: written.ref,
        observationSha256: written.sha256,
        status: "qualification_failed",
      });
      return 2;
    }
    const qualificationUsage = qualificationMeter.usage();
    const qualificationUsageCapability = qualificationRecord.probeResults.find(
      (probe) => probe.probeId === "usage_semantics_v1",
    );
    const exactQualification =
      qualificationExit === 0 &&
      qualificationRecord.identity.provider === DS0_PROVIDER &&
      qualificationRecord.identity.model === DS0_MODEL &&
      qualificationRecord.identity.policyProfileId === DS0_POLICY_PROFILE &&
      qualificationRecord.identity.policyProfileSha256 === policy.policyHash &&
      qualificationRecord.totalRequestCount === qualificationMeter.requestCount &&
      qualificationRecord.totalRequestCount > 0 &&
      qualificationRecord.totalRequestCount <=
        DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS &&
      qualificationRecord.qualifiedModes.includes("build") &&
      qualificationUsageCapability?.status === "passed" &&
      qualificationUsageCapability.observed.availability === "complete" &&
      qualificationUsage.partialUsageEvents === 0;
    if (!exactQualification) {
      const failedCost = qualificationCostSnapshot(
        input.contract,
        qualificationMeter,
      );
      const written = await writeObservation(input.repositoryRoot, runId, {
        actor: null,
        configuration: actorConfiguration,
        combinedProviderRequests: qualificationMeter.requestCount,
        cost: {
          boundaryKind: "estimated_replay_not_provider_bill_cap",
          confirmedMaximumUsdMicros: DS0_LIVE_CONFIRMATION_USD_MICROS,
          peakEstimatedUsdMicros: failedCost.peakEstimatedUsdMicros,
          qualificationUnreportedRequestReserveUsdMicros:
            failedCost.reserveUsdMicros,
        },
        protocolSha256: input.contract.protocolSha256,
        pricingSha256: input.contract.pricingSha256,
        qualification: {
          evidenceSha256: qualificationRecord.evidenceSha256,
          exitCode: qualificationExit,
          qualifiedModes: qualificationRecord.qualifiedModes,
          requestCount: qualificationMeter.requestCount,
          unreportedRequestCount: failedCost.unreportedRequestCount,
          usage: qualificationUsage,
        },
        status: "qualification_failed",
      });
      jsonLine(input.io.stdout, {
        event: "ds0_live_observation_written",
        observationRef: written.ref,
        observationSha256: written.sha256,
        status: "qualification_failed",
      });
      return 2;
    }

    const gate = qualificationRuntime.modelQualificationGate;
    if (gate === undefined) {
      throw new Error("DS0 production qualification gate is unavailable");
    }
    const gateEvidence = await gate.requireQualified({
      endpoint: DS0_BASE_URL,
      mode: "build",
      model: DS0_MODEL,
      policyHash: policy.policyHash,
      policyProfileId: DS0_POLICY_PROFILE,
      provider: DS0_PROVIDER,
      source: "provider_network",
    });
    if (gateEvidence.evidenceSha256 !== qualificationRecord.evidenceSha256) {
      throw new Error("DS0 persisted qualification gate returned different evidence");
    }
    const persistentQualification = await writeQualificationRecord(
      input.repositoryRoot,
      runId,
      qualificationRecord,
    );

    const qualificationUnreportedRequests = ds0UnreportedRequestCount(
      qualificationMeter.requestCount,
      qualificationUsage,
    );
    const qualificationReserveUsdMicros = qualificationReserveCost(
      input.contract,
      qualificationUnreportedRequests,
    );
    const qualificationPeak = estimateDs0Cost(
      qualificationUsage,
      input.contract.peak,
    );
    const preActorPeakBoundUsdMicros =
      qualificationPeak.costUsdMicros +
      qualificationReserveUsdMicros +
      input.contract.actorConservativePeakUpperBoundUsdMicros;
    if (
      preActorPeakBoundUsdMicros > DS0_LIVE_CONFIRMATION_USD_MICROS ||
      qualificationMeter.requestCount + DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS >
        DS0_COMBINED_MAXIMUM_PROVIDER_REQUESTS
    ) {
      const written = await writeObservation(input.repositoryRoot, runId, {
        actor: null,
        configuration: actorConfiguration,
        combinedProviderRequests: qualificationMeter.requestCount,
        cost: {
          boundaryKind: "estimated_replay_not_provider_bill_cap",
          confirmedMaximumUsdMicros: DS0_LIVE_CONFIRMATION_USD_MICROS,
          isAbsoluteProviderBillingCap: false,
          preActorPeakBoundUsdMicros,
          qualificationReserveUsdMicros,
        },
        protocolSha256: input.contract.protocolSha256,
        pricingSha256: input.contract.pricingSha256,
        qualification: {
          evidenceSha256: qualificationRecord.evidenceSha256,
          requestCount: qualificationMeter.requestCount,
          usage: qualificationUsage,
        },
        status: "pre_actor_cost_cap_blocked",
      });
      jsonLine(input.io.stdout, {
        event: "ds0_live_observation_written",
        observationRef: written.ref,
        observationSha256: written.sha256,
        status: "pre_actor_cost_cap_blocked",
      });
      return 2;
    }

    const qualificationPath = join(
      workspace,
      ...QUALIFICATION_EVIDENCE_REF.split("/"),
    );
    await mkdir(dirname(qualificationPath), { recursive: true });
    await writeFile(
      qualificationPath,
      `${JSON.stringify(qualificationRecord)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const actorMeter = new Ds0ProviderMeter(
      "actor",
      DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS,
      DS0_ACTOR_MAXIMUM_REPORTED_TOKENS,
    );
    observedActorMeter = actorMeter;
    const actorBase = createDs0NodeRuntime(workspace, stateRoot, env, approval);
    const modelEvidence = remoteModelEvidence(
      qualificationRecord.totalRequestCount,
      qualificationRecord.evidenceSha256,
    );
    const actorRuntime: CliRuntime = {
      ...actorBase,
      agentModelEvidence: (provider) =>
        provider === DS0_PROVIDER ? modelEvidence : null,
      createModelBackend: (request) =>
        actorMeter.wrap(actorBase.createModelBackend(request)),
      createSessionWriter: async (sessionWorkspace, sessionId) => {
        const writer = await V2SessionWriter.createNew(
          sessionWorkspace,
          sessionId,
        );
        actorWriter.current = writer;
        return writer;
      },
    };
    const actorIO = memoryIO();
    failureStage = "actor";
    const actorExit = await executeAgent(
      {
        artifactCaptureBytes: undefined,
        commandApproval: "ask",
        commandTimeoutMs: "120000",
        completionPolicy: "verified",
        contextCompactionThreshold: undefined,
        contextReserveOutputTokens: undefined,
        contextWindowTokens: undefined,
        dockerArtifactExecution: undefined,
        dockerImage: undefined,
        editApproval: "ask",
        executor: "local",
        maxCommandOutputBytes: "65536",
        maxDurationMs: "600000",
        maxSteps: String(DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS),
        maxTokens: String(DS0_ACTOR_MAXIMUM_REPORTED_TOKENS),
        maxToolOutputBytes: "262144",
        mcpPromptArgumentsJson: undefined,
        mcpPromptSelection: undefined,
        mcpServerIds: [],
        memoryMode: "off",
        mode: undefined,
        model: DS0_MODEL,
        policyConfig: trustedPolicyConfig,
        policyProfile: DS0_POLICY_PROFILE,
        provider: DS0_PROVIDER,
        providerSource: "provider_network",
        reportFormat: "json",
        requestTimeoutMs: "120000",
        requireVerification: "auto",
        sandboxCpus: undefined,
        sandboxMemoryMiB: undefined,
        sandboxPids: undefined,
        sandboxTmpMiB: undefined,
        skillArguments: undefined,
        skillSelections: [],
        task: [
          "Repair the checked-in public Phase 7 clamp fixture.",
          `Inspect ${DS0_PUBLIC_SMOKE_TARGET}, apply only the minimal clamp-bound fix,`,
          "run node verify.mjs with cwd fixtures/phase-07-fix-and-verify,",
          "and call finish_task with status completed only after that exact verifier succeeds.",
          "Do not change any other file.",
        ].join(" "),
        taskProfile: "coding",
        verbose: false,
      },
      actorRuntime,
      actorIO.io,
    );
    const report = parseRunReport(actorIO.readStdout());
    const writer = actorWriter.current;
    const actorSessionUsage =
      writer === null ? aggregateDs0Usage([]) : aggregateDs0Usage(sessionUsage(writer));
    const actorMeterUsage = actorMeter.usage();
    const terminalRunFailed =
      writer === null ? null : extractDs0TerminalRunFailure(writer.events);
    let freshVerification = null;
    try {
      failureStage = "fresh_verification";
      freshVerification = await verifyDs0PublicSmokeWorkspace(workspace);
    } catch {
      freshVerification = null;
    }
    const actorUsageComplete =
      actorSessionUsage.partialUsageEvents === 0 &&
      actorSessionUsage.completeUsageEvents === actorMeter.requestCount &&
      actorMeterUsage.partialUsageEvents === 0 &&
      actorMeterUsage.completeUsageEvents === actorMeter.requestCount &&
      sameUsage(actorSessionUsage, actorMeterUsage) &&
      actorSessionUsage.totalTokens <= DS0_ACTOR_MAXIMUM_REPORTED_TOKENS;
    const reportExact =
      report?.status === "completed" &&
      report.model_evidence.kind === "remote_live_qualified" &&
      report.model_evidence.qualification_evidence_sha256 ===
        qualificationRecord.evidenceSha256 &&
      report.changed.length === 1 &&
      report.changed[0]?.path === DS0_PUBLIC_SMOKE_TARGET;
    const passed =
      actorExit === 0 &&
      reportExact &&
      actorMeter.requestCount > 0 &&
      actorMeter.requestCount <= DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS &&
      qualificationMeter.requestCount + actorMeter.requestCount <=
        DS0_COMBINED_MAXIMUM_PROVIDER_REQUESTS &&
      actorUsageComplete &&
      freshVerification?.finalTargetSha256 === DS0_PUBLIC_SMOKE_FIXED_SHA256;

    const band = ds0PriceBandAt(input.contract, new Date());
    const qualificationApplicable = estimateDs0Cost(
      qualificationUsage,
      band.rates,
    );
    const actorCost = ds0ActorCostSnapshot(
      input.contract,
      actorMeterUsage,
      actorMeter.requestCount,
      band.rates,
    );
    const combinedApplicableUsdMicros =
      qualificationApplicable.costUsdMicros +
      qualificationReserveUsdMicros +
      actorCost.applicableEstimatedUsdMicros;
    const combinedPeakUsdMicros =
      qualificationPeak.costUsdMicros +
      qualificationReserveUsdMicros +
      actorCost.peakEstimatedUsdMicros;
    const written = await writeObservation(input.repositoryRoot, runId, {
      actor: {
        approvalDecisions: approval.observations,
        exitCode: actorExit,
        freshVerification:
          freshVerification === null
            ? null
            : {
                changedPaths: freshVerification.changedPaths,
                finalTargetSha256: freshVerification.finalTargetSha256,
                verifierExitCode: freshVerification.verifierExitCode,
              },
        reportHash: report?.report_hash ?? null,
        reportStatus: report?.status ?? null,
        requestCount: actorMeter.requestCount,
        backendMeterUsage: actorMeterUsage,
        sessionUsage: actorSessionUsage,
        terminalRunFailed,
        unreportedRequestCount: actorCost.unreportedRequestCount,
        unreportedRequestReserveUsdMicros: actorCost.reserveUsdMicros,
        usage: actorSessionUsage,
        usageCrossCheckedAgainstBackendMeter: sameUsage(
          actorSessionUsage,
          actorMeterUsage,
        ),
      },
      combinedProviderRequests:
        qualificationMeter.requestCount + actorMeter.requestCount,
      configuration: actorConfiguration,
      cost: {
        applicableBand: band.id,
        boundaryKind: "estimated_replay_not_provider_bill_cap",
        combinedApplicableEstimatedUsdMicros: combinedApplicableUsdMicros,
        combinedPeakEstimatedUsdMicros: combinedPeakUsdMicros,
        confirmedMaximumUsdMicros: DS0_LIVE_CONFIRMATION_USD_MICROS,
        isProviderInvoice: false,
        preActorPeakBoundUsdMicros,
        actorUnreportedRequestReserveUsdMicros: actorCost.reserveUsdMicros,
        qualificationUnreportedRequestReserveUsdMicros:
          qualificationReserveUsdMicros,
      },
      privacy: {
        absolutePathsPersisted: false,
        apiKeyPersisted: false,
        rawProviderReasoningPersisted: false,
        rawProviderResponsePersisted: false,
      },
      protocolSha256: input.contract.protocolSha256,
      pricingSha256: input.contract.pricingSha256,
      qualification: {
        evidenceSha256: qualificationRecord.evidenceSha256,
        qualifiedModes: qualificationRecord.qualifiedModes,
        requestCount: qualificationMeter.requestCount,
        unreportedRequestCount: qualificationUnreportedRequests,
        usage: qualificationUsage,
      },
      qualificationDescriptor: passed
        ? {
            baseUrl: DS0_BASE_URL,
            completedCount: qualificationRecord.totalRequestCount,
            evidenceSha256: qualificationRecord.evidenceSha256,
            kind: "model_capability_probe_suite",
            model: DS0_MODEL,
            provider: DS0_PROVIDER,
            recordSha256: persistentQualification.recordSha256,
            ref: persistentQualification.ref,
            requestCount: qualificationRecord.totalRequestCount,
            schemaVersion: 1,
            status: "passed",
            usageCapability: "complete",
          }
        : null,
      publicWorkspace: {
        baselineCommit: publicWorkspace.baselineCommit,
        target: DS0_PUBLIC_SMOKE_TARGET,
      },
      status: passed ? "passed" : "actor_failed",
    });
    jsonLine(input.io.stdout, {
      combinedEstimatedCostUsd:
        (combinedApplicableUsdMicros / 1_000_000).toFixed(6),
      combinedProviderRequests:
        qualificationMeter.requestCount + actorMeter.requestCount,
      event: "ds0_live_observation_written",
      observationRef: written.ref,
      observationSha256: written.sha256,
      status: passed ? "passed" : "actor_failed",
    });
    return passed ? 0 : 1;
  } catch (error) {
    const qualificationMeter = observedQualificationMeter;
    const actorMeter = observedActorMeter;
    let qualificationUsage = aggregateDs0Usage([]);
    let actorBackendMeterUsage = aggregateDs0Usage([]);
    try {
      qualificationUsage = qualificationMeter?.usage() ?? qualificationUsage;
    } catch {
      // Invalid usage remains unreported and is covered by the reserve below.
    }
    try {
      actorBackendMeterUsage = actorMeter?.usage() ?? actorBackendMeterUsage;
    } catch {
      // Invalid usage remains unreported and is covered by the reserve below.
    }
    let actorSessionUsage = aggregateDs0Usage([]);
    let terminalRunFailed: Ds0TerminalRunFailure | null = null;
    try {
      if (actorWriter.current !== null) {
        actorSessionUsage = aggregateDs0Usage(sessionUsage(actorWriter.current));
        terminalRunFailed = extractDs0TerminalRunFailure(
          actorWriter.current.events,
        );
      }
    } catch {
      // The sanitized failure receipt still records backend counts and reserve.
    }
    const qualificationUnreportedRequests = ds0UnreportedRequestCount(
      qualificationMeter?.requestCount ?? 0,
      qualificationUsage,
    );
    const qualificationReserveUsdMicros = qualificationReserveCost(
      input.contract,
      qualificationUnreportedRequests,
    );
    const actorCost = ds0ActorCostSnapshot(
      input.contract,
      actorBackendMeterUsage,
      actorMeter?.requestCount ?? 0,
      input.contract.peak,
    );
    const peakEstimatedUsdMicros =
      estimateDs0Cost(qualificationUsage, input.contract.peak).costUsdMicros +
      qualificationReserveUsdMicros +
      actorCost.peakEstimatedUsdMicros;
    try {
      const written = await writeObservation(input.repositoryRoot, runId, {
        actor: {
          backendMeterUsage: actorBackendMeterUsage,
          requestCount: actorMeter?.requestCount ?? 0,
          sessionUsage: actorSessionUsage,
          terminalRunFailed,
          unreportedRequestCount: actorCost.unreportedRequestCount,
          unreportedRequestReserveUsdMicros: actorCost.reserveUsdMicros,
        },
        combinedProviderRequests:
          (qualificationMeter?.requestCount ?? 0) +
          (actorMeter?.requestCount ?? 0),
        configuration: actorConfiguration,
        cost: {
          boundaryKind: "estimated_replay_not_provider_bill_cap",
          confirmedMaximumUsdMicros: DS0_LIVE_CONFIRMATION_USD_MICROS,
          isAbsoluteProviderBillingCap: false,
          peakEstimatedUsdMicros,
          actorUnreportedRequestReserveUsdMicros: actorCost.reserveUsdMicros,
          qualificationUnreportedRequestReserveUsdMicros:
            qualificationReserveUsdMicros,
        },
        errorClass:
          error instanceof Ds0ProviderCapError
            ? "local_provider_cap_error"
            : `${failureStage}_orchestration_error`,
        failureStage,
        privacy: {
          absolutePathsPersisted: false,
          apiKeyPersisted: false,
          errorMessagePersisted: false,
          rawProviderReasoningPersisted: false,
          rawProviderResponsePersisted: false,
        },
        protocolSha256: input.contract.protocolSha256,
        pricingSha256: input.contract.pricingSha256,
        qualification: {
          requestCount: qualificationMeter?.requestCount ?? 0,
          unreportedRequestCount: qualificationUnreportedRequests,
          usage: qualificationUsage,
        },
        qualificationDescriptor: null,
        status: "orchestration_failed",
      });
      jsonLine(input.io.stdout, {
        combinedProviderRequests:
          (qualificationMeter?.requestCount ?? 0) +
          (actorMeter?.requestCount ?? 0),
        event: "ds0_live_observation_written",
        observationRef: written.ref,
        observationSha256: written.sha256,
        status: "orchestration_failed",
      });
    } catch {
      input.io.stderr.write(
        "DS0 live run failed and its sanitized observation could not be written.\n",
      );
    }
    return 1;
  } finally {
    await actorWriter.current?.close().catch(() => undefined);
    await rm(temporaryRoot, { force: true, recursive: true }).catch(() => undefined);
  }
}

interface ParsedCliAuthorization {
  readonly authorizeRemote: boolean;
  readonly confirmMaximumUsd?: string;
  readonly confirmPricingSha256?: string;
  readonly help: boolean;
}

function parseCliArguments(args: readonly string[]): ParsedCliAuthorization {
  let authorizeRemote = false;
  let confirmMaximumUsd: string | undefined;
  let confirmPricingSha256: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--authorize-remote") {
      if (authorizeRemote) throw new TypeError("duplicate --authorize-remote");
      authorizeRemote = true;
      continue;
    }
    if (argument === "--confirm-max-usd") {
      if (confirmMaximumUsd !== undefined) {
        throw new TypeError("duplicate --confirm-max-usd");
      }
      confirmMaximumUsd = args[index + 1];
      if (confirmMaximumUsd === undefined) {
        throw new TypeError("--confirm-max-usd requires a value");
      }
      index += 1;
      continue;
    }
    if (argument === "--confirm-pricing-sha256") {
      if (confirmPricingSha256 !== undefined) {
        throw new TypeError("duplicate --confirm-pricing-sha256");
      }
      confirmPricingSha256 = args[index + 1];
      if (confirmPricingSha256 === undefined) {
        throw new TypeError("--confirm-pricing-sha256 requires a value");
      }
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new TypeError(`unknown DS0 argument: ${argument}`);
  }
  return Object.freeze({
    authorizeRemote,
    ...(confirmMaximumUsd === undefined ? {} : { confirmMaximumUsd }),
    ...(confirmPricingSha256 === undefined ? {} : { confirmPricingSha256 }),
    help,
  });
}

function usageText(): string {
  return [
    "Usage: pnpm lab:ds0",
    "  Dry-run is the default and makes zero provider requests.",
    "  Live: --authorize-remote --confirm-max-usd 0.12",
    "        --confirm-pricing-sha256 <current frozen pricing sha256>",
  ].join("\n");
}

export async function runDs0Cli(
  args: readonly string[],
  input: Readonly<{
    readonly authorizedExecutor?: Ds0AuthorizedExecutor;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly io: CliIO;
    readonly repositoryRoot: string;
  }>,
): Promise<0 | 1 | 2> {
  let parsed: ParsedCliAuthorization;
  try {
    parsed = parseCliArguments(args);
  } catch {
    input.io.stderr.write(`${usageText()}\n`);
    return 2;
  }
  if (parsed.help) {
    input.io.stdout.write(`${usageText()}\n`);
    return 0;
  }
  let contract: Ds0Contract;
  let policyValidationRoot: string | null = null;
  try {
    contract = await readDs0Contract(input.repositoryRoot);
    policyValidationRoot = await mkdtemp(join(tmpdir(), "fal-ds0-policy-"));
    const trustedPolicyConfig = await materializeDs0Policy(
      input.repositoryRoot,
      policyValidationRoot,
    );
    await validatePolicy(
      input.repositoryRoot,
      input.env ?? process.env,
      trustedPolicyConfig,
    );
  } catch {
    input.io.stderr.write("DS0 offline contract validation failed.\n");
    return 1;
  } finally {
    if (policyValidationRoot !== null) {
      await rm(policyValidationRoot, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }
  const anyLiveConfirmation =
    parsed.authorizeRemote ||
    parsed.confirmMaximumUsd !== undefined ||
    parsed.confirmPricingSha256 !== undefined;
  if (!anyLiveConfirmation) {
    jsonLine(input.io.stdout, {
      actorMaximumProviderRequests: DS0_ACTOR_MAXIMUM_PROVIDER_REQUESTS,
      actorMaximumReportedTokens: DS0_ACTOR_MAXIMUM_REPORTED_TOKENS,
      combinedMaximumProviderRequests: DS0_COMBINED_MAXIMUM_PROVIDER_REQUESTS,
      event: "ds0_dry_run_ready",
      maximumConfirmedCostUsd: DS0_LIVE_CONFIRMATION_USD,
      pricingSha256: contract.pricingSha256,
      protocolSha256: contract.protocolSha256,
      providerRequests: 0,
      qualificationMaximumProviderRequests:
        DS0_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
      remoteCallsAuthorized: false,
    });
    return 0;
  }
  if (
    !parsed.authorizeRemote ||
    parsed.confirmMaximumUsd !== DS0_LIVE_CONFIRMATION_USD ||
    parsed.confirmPricingSha256 !== contract.pricingSha256
  ) {
    input.io.stderr.write(
      "DS0 live run blocked: exact remote, USD-cap, and pricing confirmations are all required.\n",
    );
    return 2;
  }
  return (input.authorizedExecutor ?? runDs0AuthorizedProduction)({
    contract,
    env: input.env ?? process.env,
    io: input.io,
    repositoryRoot: input.repositoryRoot,
  });
}
