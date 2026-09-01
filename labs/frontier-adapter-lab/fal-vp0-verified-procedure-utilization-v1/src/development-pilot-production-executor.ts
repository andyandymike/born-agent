import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentCommandOptions } from "../../../../src/agent/agent-types.js";
import type { ApprovalLineReader } from "../../../../src/approvals/approval-types.js";
import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import type { CliIO, CliRuntime } from "../../../../src/cli/types.js";
import { executeAgent } from "../../../../src/commands/agent.js";
import type { ModelEvidence } from "../../../../src/completion/completion-types.js";
import { ModelQualificationError } from "../../../../src/model/model-qualification-gate.js";
import { V2SessionWriter } from "../../../../src/sessions/v2-session-writer.js";
import { RestrictedToolRegistry } from "../../../../src/tools/restricted-tool-registry.js";
import { DevelopmentPilotExactApprovalPrompt } from "./development-pilot-approval.js";
import type {
  DevelopmentPilotFixture,
  DevelopmentPilotCase,
  DevelopmentPilotQualificationDescriptor,
} from "./development-pilot-fixture.js";
import { VP0_DEVELOPMENT_PILOT_PROFILE } from "./development-pilot-fixture.js";
import type { DevelopmentPilotAttemptWorkspace } from "./development-pilot-workspace.js";
import {
  DevelopmentPilotProviderMeter,
  type DevelopmentPilotCapExceeded,
} from "./development-pilot-provider-meter.js";

export interface DevelopmentPilotUsageObservation {
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly completeness: "complete" | "partial" | "none";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface DevelopmentPilotToolCallObservation {
  readonly argumentShape?: readonly Readonly<{
    readonly field: string;
    readonly valueKind: "array" | "boolean" | "null" | "number" | "object" | "string";
  }>[] | null;
  readonly argumentsSha256?: string;
  readonly errorCategory?: string | null;
  readonly errorCode?: string | null;
  readonly retryable?: boolean | null;
  readonly status: "error" | "requested_without_completion" | "success";
  readonly step: number;
  readonly toolName: string;
}

export interface DevelopmentPilotAgentObservation {
  readonly approvalDecisions: Readonly<{
    readonly approved: number;
    readonly cancelled: number;
    readonly denied: number;
  }>;
  readonly completionEvidenceSha256: string | null;
  readonly completionReportSha256: string | null;
  readonly capExceeded: DevelopmentPilotCapExceeded | null;
  readonly exitCode: number;
  readonly orchestrationFailure: boolean;
  readonly providerRequestsCompleted: number;
  readonly providerRequestsStarted: number;
  readonly sessionEventLogSha256: string | null;
  readonly terminal:
    | "budget_exceeded"
    | "cap_exceeded"
    | "cancelled"
    | "completed"
    | "failed"
    | "incomplete"
    | "not_started";
  readonly terminalCode: string | null;
  readonly terminalFailureCategory: string | null;
  readonly toolCalls: readonly DevelopmentPilotToolCallObservation[];
  readonly usage: DevelopmentPilotUsageObservation;
  readonly usageCrossCheckedAgainstSession: boolean;
}

export interface DevelopmentPilotAttemptExecutor {
  execute(input: Readonly<{
    readonly attempt: DevelopmentPilotAttemptWorkspace;
    readonly case: DevelopmentPilotCase;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly fixture: DevelopmentPilotFixture;
    readonly qualification: DevelopmentPilotQualificationDescriptor;
  }>): Promise<DevelopmentPilotAgentObservation>;
}

class HashOnlyWriter {
  readonly #hash = createHash("sha256");
  #digested = false;
  #bytes = 0;

  write(value: string): void {
    if (this.#digested) throw new Error("development pilot output hash is already finalized");
    this.#hash.update(value, "utf8");
    this.#bytes += Buffer.byteLength(value, "utf8");
  }

  digest(): Readonly<{ readonly bytes: number; readonly sha256: string }> {
    if (this.#digested) throw new Error("development pilot output hash can be finalized once");
    this.#digested = true;
    return Object.freeze({ bytes: this.#bytes, sha256: this.#hash.digest("hex") });
  }
}

const noninteractiveApprovalInput: ApprovalLineReader = Object.freeze({
  interactive: false,
  readLine: async () => null,
});

export function developmentPilotCommandOptions(
  fixture: DevelopmentPilotFixture,
  attempt: DevelopmentPilotAttemptWorkspace,
  caseInput: DevelopmentPilotCase,
): AgentCommandOptions {
  return Object.freeze({
    artifactCaptureBytes: undefined,
    commandApproval: "ask",
    commandTimeoutMs: "30000",
    completionPolicy: "verified",
    contextCompactionThreshold: undefined,
    contextReserveOutputTokens: undefined,
    contextWindowTokens: undefined,
    dockerArtifactExecution: undefined,
    dockerImage: undefined,
    editApproval: "ask",
    executor: "local",
    inputSurface: "cli",
    maxCommandOutputBytes: "16384",
    maxDurationMs: String(fixture.protocol.perAttemptCaps.maximumWallTimeMs),
    maxSteps: String(fixture.protocol.perAttemptCaps.maximumProviderRequests),
    maxTokens: String(fixture.protocol.perAttemptCaps.runtimeReportedTokenCeiling),
    maxToolOutputBytes: "65536",
    mcpPromptArgumentsJson: undefined,
    mcpPromptSelection: undefined,
    mcpServerIds: undefined,
    memoryMode: "off",
    model: fixture.protocol.model,
    policyConfig: fixture.policyPath,
    policyProfile: VP0_DEVELOPMENT_PILOT_PROFILE,
    provider: fixture.protocol.provider,
    providerSource: "provider_network",
    reportFormat: "json",
    requestTimeoutMs: "90000",
    requireVerification: "auto",
    sandboxCpus: undefined,
    sandboxMemoryMiB: undefined,
    sandboxPids: undefined,
    sandboxTmpMiB: undefined,
    skillArguments: undefined,
    skillSelections: attempt.capability.skillSelections,
    task: caseInput.task,
    taskProfile: "coding",
    verbose: false,
  });
}

function modelEvidence(
  qualification: DevelopmentPilotQualificationDescriptor,
): ModelEvidence {
  return Object.freeze({
    backend: "deepseek",
    baseUrl: qualification.baseUrl,
    endpointScope: "remote_https",
    kind: "remote_live_qualified",
    model: qualification.model,
    provider: qualification.provider,
    qualificationCompletedRequestCount: qualification.qualificationCompletedRequestCount,
    qualificationEvidenceKind: qualification.qualificationEvidenceKind,
    qualificationEvidenceRef: qualification.qualificationEvidenceRef,
    qualificationEvidenceSha256: qualification.qualificationEvidenceSha256,
    qualificationRequestCount: qualification.qualificationRequestCount,
    qualificationStatus: qualification.qualificationStatus,
    qualificationUsageCapability: qualification.qualificationUsageCapability,
    remoteBillableRequests: qualification.qualificationRequestCount,
    remoteQualificationRequests: qualification.qualificationRequestCount,
    requestCountScope: "qualification_only",
  });
}

function terminalType(events: readonly Readonly<{ readonly type: string }>[]): DevelopmentPilotAgentObservation["terminal"] {
  const terminal = [...events].reverse().find((event) => [
    "run.budget_exceeded",
    "run.cancelled",
    "run.completed",
    "run.failed",
    "run.incomplete",
  ].includes(event.type));
  switch (terminal?.type) {
    case "run.budget_exceeded": return "budget_exceeded";
    case "run.cancelled": return "cancelled";
    case "run.completed": return "completed";
    case "run.failed": return "failed";
    case "run.incomplete": return "incomplete";
    default: return "not_started";
  }
}

function terminalCode(events: V2SessionWriter["events"]): string | null {
  const terminal = [...events].reverse().find((event) =>
    event.scope === "run" && [
      "run.budget_exceeded",
      "run.cancelled",
      "run.completed",
      "run.failed",
      "run.incomplete",
    ].includes(event.type));
  if (terminal?.scope !== "run") return null;
  if (terminal.type === "run.failed") return terminal.data.code;
  if (terminal.type === "run.budget_exceeded") return terminal.data.reason;
  if (terminal.type === "run.incomplete") return terminal.data.reason;
  return null;
}

function terminalFailureCategory(events: V2SessionWriter["events"]): string | null {
  const failed = [...events].reverse().find((event) =>
    event.scope === "run" && event.type === "run.failed");
  return failed?.scope === "run" && failed.type === "run.failed"
    ? failed.data.category
    : null;
}

function usageObservation(
  events: V2SessionWriter["events"],
): DevelopmentPilotUsageObservation {
  const started = events.filter((event) => event.scope === "run" && event.type === "agent.step.started").length;
  const usageEvents = events.filter((event) => event.scope === "run" && event.type === "model.usage");
  if (usageEvents.length === 0) {
    return Object.freeze({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      completeness: "none",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  }
  const complete = usageEvents.every((event) =>
    "completeness" in event.data &&
    event.data.completeness === "complete" &&
    typeof event.data.input_tokens === "number" &&
    typeof event.data.output_tokens === "number" &&
    typeof event.data.total_tokens === "number");
  const values = usageEvents.map((event) => event.data);
  const sum = (key: "input_tokens" | "output_tokens" | "total_tokens"): number | null =>
    values.every((value) => typeof value[key] === "number")
      ? values.reduce((total, value) => total + (value[key] as number), 0)
      : null;
  const nullableSum = (key: "cache_read_tokens" | "cache_write_tokens"): number | null => {
    const selected = values.map((value) => {
      const record = value as unknown as Readonly<Record<string, unknown>>;
      return typeof record[key] === "number" ? record[key] as number : null;
    });
    return selected.every((value) => value !== null)
      ? selected.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null;
  };
  return Object.freeze({
    cacheReadTokens: nullableSum("cache_read_tokens"),
    cacheWriteTokens: nullableSum("cache_write_tokens"),
    completeness: complete && usageEvents.length === started ? "complete" : "partial",
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    totalTokens: sum("total_tokens"),
  });
}

function sameUsage(
  left: DevelopmentPilotUsageObservation,
  right: DevelopmentPilotUsageObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toolCallObservations(
  events: V2SessionWriter["events"],
): readonly DevelopmentPilotToolCallObservation[] {
  const argumentShape = (
    argumentsJson: string,
  ): Exclude<DevelopmentPilotToolCallObservation["argumentShape"], undefined> => {
    let value: unknown;
    try {
      value = JSON.parse(argumentsJson);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return Object.freeze(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([field, entry]) => Object.freeze({
        field,
        valueKind: entry === null
          ? "null" as const
          : Array.isArray(entry)
            ? "array" as const
            : typeof entry as "boolean" | "number" | "object" | "string",
      })));
  };
  const completed = new Map(events
    .filter((event) => event.scope === "run" && event.type === "tool.call.completed")
    .map((event) => [event.data.call_id, event] as const));
  return Object.freeze(events
    .filter((event) => event.scope === "run" && event.type === "tool.call.requested")
    .map((event) => {
      const result = completed.get(event.data.call_id);
      return Object.freeze({
        argumentShape: argumentShape(event.data.arguments_json),
        argumentsSha256: createHash("sha256")
          .update(event.data.arguments_json, "utf8")
          .digest("hex"),
        errorCategory: result?.data.error_category ?? null,
        errorCode: result?.data.error_code ?? null,
        retryable: result?.data.retryable ?? null,
        status: result === undefined
          ? "requested_without_completion" as const
          : result.data.status,
        step: event.data.step,
        toolName: event.data.tool_name,
      });
    }));
}

function completionHashes(events: V2SessionWriter["events"]): Readonly<{
  readonly evidence: string | null;
  readonly report: string | null;
}> {
  const completed = [...events].reverse().find((event) =>
    event.scope === "run" && event.type === "run.completed");
  if (completed?.scope !== "run" || completed.type !== "run.completed") {
    return Object.freeze({ evidence: null, report: null });
  }
  return Object.freeze({
    evidence: completed.data.evidence_sha256 ?? null,
    report: completed.data.report_sha256 ?? null,
  });
}

function isolatedEnvironment(input: Readonly<{
  readonly attempt: DevelopmentPilotAttemptWorkspace;
  readonly source: Readonly<Record<string, string | undefined>>;
}>): Readonly<Record<string, string | undefined>> {
  const stateRoot = join(input.attempt.root, "host-state");
  return Object.freeze({
    BORN_CONTROL_STATE_ROOT: join(stateRoot, "control"),
    COMSPEC: input.source.COMSPEC,
    DEEPSEEK_API_KEY: input.source.DEEPSEEK_API_KEY,
    PATH: input.source.PATH,
    PATHEXT: input.source.PATHEXT,
    SystemRoot: input.source.SystemRoot,
    TEMP: input.source.TEMP,
    TMP: input.source.TMP,
    WINDIR: input.source.WINDIR,
  });
}

export class ProductionDevelopmentPilotExecutor implements DevelopmentPilotAttemptExecutor {
  async execute(input: Readonly<{
    readonly attempt: DevelopmentPilotAttemptWorkspace;
    readonly case: DevelopmentPilotCase;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly fixture: DevelopmentPilotFixture;
    readonly qualification: DevelopmentPilotQualificationDescriptor;
  }>): Promise<DevelopmentPilotAgentObservation> {
    const approval = new DevelopmentPilotExactApprovalPrompt(input.case);
    const environment = isolatedEnvironment({ attempt: input.attempt, source: input.environment });
    const stdout = new HashOnlyWriter();
    const stderr = new HashOnlyWriter();
    const io: CliIO = Object.freeze({ stdout, stderr });
    let writer: V2SessionWriter | undefined;
    const meter = new DevelopmentPilotProviderMeter(
      Object.freeze({
        maximumCacheReadTokens:
          input.fixture.protocol.perAttemptCaps.maximumReportedCacheReadTokens,
        maximumOutputTokens:
          input.fixture.protocol.perAttemptCaps.maximumReportedOutputTokens,
        maximumRequests:
          input.fixture.protocol.perAttemptCaps.maximumProviderRequests,
        maximumTotalTokens:
          input.fixture.protocol.perAttemptCaps.maximumReportedTotalTokens,
        maximumUncachedInputTokens:
          input.fixture.protocol.perAttemptCaps.maximumReportedUncachedInputTokens,
      }),
    );
    const base = createNodeRuntime({
      approvalInput: noninteractiveApprovalInput,
      approvalPromptOverride: approval,
      capabilityAssetsRoot: input.attempt.capability.builtinRoot,
      capabilityUserStateRoot: input.attempt.capability.userStateRoot,
      cwd: input.attempt.workspace,
      delegationUserStateRoot: join(input.attempt.root, "host-state", "delegation"),
      env: environment,
      execPath: process.execPath,
      killProcess: (processIdentity, signal) => process.kill(processIdentity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-fal-vp0-development-pilot",
      workerUserStateRoot: join(input.attempt.root, "host-state", "worker"),
      worktreeUserStateRoot: join(input.attempt.root, "host-state", "worktree"),
    });
    const runtime: CliRuntime = {
      ...base,
      agentModelEvidence: (provider) => provider === "deepseek"
        ? modelEvidence(input.qualification)
        : null,
      createSessionWriter: async (workspace, sessionId) => {
        writer = await V2SessionWriter.create(workspace, sessionId);
        return writer;
      },
      createAgentToolRegistry: async (options) =>
        new RestrictedToolRegistry(
          await base.createAgentToolRegistry(options),
          input.fixture.protocol.toolProfile.allowedToolIds,
        ),
      createModelBackend: (request) => meter.wrap(base.createModelBackend(request)),
      // This pilot deliberately exercises the production legacy Build surface:
      // no `mode` option is supplied, so Phase 16 qualification is not entered.
      // The strictly bound DS0 passed observation supplies coding evidence. If a
      // future executeAgent change accidentally enters Phase 16, fail before a
      // provider request instead of silently consulting unrelated user state.
      modelQualificationGate: {
        requireQualified: async () => {
          throw new ModelQualificationError(
            "model_unqualified",
            "development pilot unexpectedly entered the Phase 16 qualification gate",
          );
        },
      },
    };
    let exitCode = 1;
    let orchestrationFailure = false;
    try {
      exitCode = await executeAgent(
        developmentPilotCommandOptions(input.fixture, input.attempt, input.case),
        runtime,
        io,
      );
    } catch {
      // Persist only the stable failure classification plus whatever the
      // backend meter/session already observed; never persist the thrown text.
      orchestrationFailure = true;
    }
    stdout.digest();
    stderr.digest();
    const events = writer?.events ?? [];
    let eventLogSha256: string | null = null;
    if (writer !== undefined) {
      try {
        eventLogSha256 = createHash("sha256")
          .update(await readFile(writer.path))
          .digest("hex");
      } catch {
        orchestrationFailure = true;
      }
    }
    const approvals = approval.observations.reduce(
      (counts, observation) => ({
        ...counts,
        [observation.decision]: counts[observation.decision] + 1,
      }),
      { approved: 0, cancelled: 0, denied: 0 },
    );
    const hashes = completionHashes(events);
    const sessionUsage = usageObservation(events);
    let meteredUsage: DevelopmentPilotUsageObservation;
    try {
      meteredUsage = meter.usage();
    } catch {
      orchestrationFailure = true;
      meteredUsage = Object.freeze({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        completeness: "none",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
    }
    const capExceeded = meter.capExceeded;
    return Object.freeze({
      approvalDecisions: Object.freeze(approvals),
      capExceeded,
      completionEvidenceSha256: hashes.evidence,
      completionReportSha256: hashes.report,
      exitCode,
      orchestrationFailure,
      providerRequestsCompleted: meter.usageEventCount,
      providerRequestsStarted: meter.requestCount,
      sessionEventLogSha256: eventLogSha256,
      terminal: capExceeded === null ? terminalType(events) : "cap_exceeded",
      terminalCode: capExceeded === null
        ? terminalCode(events) ??
          (orchestrationFailure ? "production_execute_agent_threw" : null)
        : `pilot_cap_${capExceeded.kind}`,
      terminalFailureCategory: capExceeded === null
        ? terminalFailureCategory(events)
        : null,
      toolCalls: toolCallObservations(events),
      usage: meteredUsage,
      usageCrossCheckedAgainstSession: sameUsage(meteredUsage, sessionUsage),
    });
  }
}
