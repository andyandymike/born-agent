import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  ApprovalDecision,
  ApprovalLineReader,
  ApprovalPreview,
  ApprovalPrompt,
} from "../../../../src/approvals/approval-types.js";
import type { AgentCommandOptions } from "../../../../src/agent/agent-types.js";
import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import type { CliIO, CliRuntime } from "../../../../src/cli/types.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { RemoteLiveQualifiedModelEvidence } from "../../../../src/completion/completion-types.js";
import {
  disposeApplicationHostForStateRoot,
  executeAgentThroughApplicationService,
} from "../../../../src/control-plane/adapters/agent-cli-adapter.js";
import type { BackendCreationRequest } from "../../../../src/model/backend-factory.js";
import { ModelQualificationError } from "../../../../src/model/model-qualification-gate.js";
import {
  modelQualificationRecordSchema,
} from "../../../../src/model/model-qualification-schema.js";
import { modelQualificationIdentitySha256 } from "../../../../src/model/model-qualification-identity.js";
import { V2SessionWriter } from "../../../../src/sessions/v2-session-writer.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { RestrictedToolRegistry } from "../../../../src/tools/restricted-tool-registry.js";
import {
  createMemE0ActorQualificationFreeze,
  memE0ActorQualificationFreezeSchema,
  memE0ActorQualificationProviderUsageSchema,
  memE0ActorQualificationRunSchema,
  MEM_E0_ACTOR_QUALIFICATION_ENDPOINT,
  MEM_E0_ACTOR_QUALIFICATION_MODEL,
  MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  MEM_E0_ACTOR_QUALIFICATION_PROVIDER,
  MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE,
  type MemE0ActorQualificationFreeze,
} from "./actor-qualification.js";
import {
  loadMemE0ActorQualificationFixture,
  MEM_E0_ACTOR_QUALIFICATION_POLICY_PROFILE_ID,
  type MemE0LoadedActorQualificationFixture,
} from "./actor-qualification-fixture.js";
import {
  MemE0ActorQualificationProviderMeter,
} from "./actor-qualification-provider-meter.js";
import {
  observeMemE0ActorQualificationSource,
} from "./actor-qualification-source.js";
import {
  MemoryEffectApprovalBinding,
} from "./deterministic-memory-effect-backend.js";
import {
  createMemE0EffectToolRegistry,
  MEM_E0_PUBLIC_VERIFIER,
  validateMemE0ActualEffectBinding,
} from "./production-memory-effect-actor.js";
import { createMemE0LivePricingSnapshot } from "./live-preflight.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const LOCAL_QUALIFICATION_RECORD_REF =
  ".bornagent/mem-e0/model-qualification-record.json" as const;

const remoteModelEvidenceSchema = z.object({
  backend: z.literal("deepseek"),
  baseUrl: z.literal(MEM_E0_ACTOR_QUALIFICATION_ENDPOINT),
  endpointScope: z.literal("remote_https"),
  kind: z.literal("remote_live_qualified"),
  model: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
  provider: z.literal(MEM_E0_ACTOR_QUALIFICATION_PROVIDER),
  qualificationCompletedRequestCount: z.number().int().min(1).max(6),
  qualificationEvidenceKind: z.literal("model_capability_probe_suite"),
  qualificationEvidenceRef: z.literal(LOCAL_QUALIFICATION_RECORD_REF),
  qualificationEvidenceSha256: z.string().regex(SHA256),
  qualificationRequestCount: z.number().int().min(1).max(6),
  qualificationStatus: z.literal("passed"),
  qualificationUsageCapability: z.literal("complete"),
  remoteBillableRequests: z.number().int().min(1).max(6),
  remoteQualificationRequests: z.number().int().min(1).max(6),
  requestCountScope: z.literal("qualification_only"),
}).strict().superRefine((value, context) => {
  if (
    value.qualificationCompletedRequestCount !== value.qualificationRequestCount ||
    value.remoteBillableRequests !== value.qualificationRequestCount ||
    value.remoteQualificationRequests !== value.qualificationRequestCount
  ) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 generic qualification request counts drifted",
    });
  }
});

const sourceInputSchema = z.object({
  commit: z.string().regex(COMMIT),
  implementationSha256s: z.array(z.string().regex(SHA256)).min(1).max(128),
  protectedPathsClean: z.literal(true),
  protectedTreeSha256: z.string().regex(SHA256),
}).strict();

const actorInputSchema = z.object({
  freeze: memE0ActorQualificationFreezeSchema,
  modelEvidence: remoteModelEvidenceSchema,
  repositoryRoot: z.string().min(1).max(2_048),
  schemaVersion: z.literal(1),
  source: sourceInputSchema,
  stateRoot: z.string().min(1).max(2_048),
  workspace: z.string().min(1).max(2_048),
}).strict();

const actorOutputSchema = z.object({
  actorProcessId: z.number().int().positive(),
  providerUsage: memE0ActorQualificationProviderUsageSchema,
  run: memE0ActorQualificationRunSchema,
  schemaVersion: z.literal(1),
}).strict();

export type MemE0LiveActorQualificationInput = Readonly<
  z.infer<typeof actorInputSchema>
>;
export type MemE0LiveActorQualificationOutput = Readonly<
  z.infer<typeof actorOutputSchema>
>;

interface ApprovalObservation {
  readonly actionKind: ApprovalPreview["actionKind"];
  readonly decision: ApprovalDecision;
  readonly previewSha256: string;
}

class HashOnlyWriter {
  readonly #hash = createHash("sha256");
  #bytes = 0;
  #sealed = false;

  write(value: string): void {
    if (this.#sealed) throw new Error("qualification output hash is sealed");
    this.#hash.update(value, "utf8");
    this.#bytes += Buffer.byteLength(value, "utf8");
  }

  digest(): Readonly<{ readonly bytes: number; readonly sha256: string }> {
    if (this.#sealed) throw new Error("qualification output hash can be sealed once");
    this.#sealed = true;
    return Object.freeze({
      bytes: this.#bytes,
      sha256: this.#hash.digest("hex"),
    });
  }
}

class MemE0LiveExactApprovalPrompt implements ApprovalPrompt {
  readonly #observations: ApprovalObservation[] = [];

  constructor(
    private readonly binding: MemoryEffectApprovalBinding,
    private readonly targetRelativePath: string,
  ) {
    binding.bindCommand({
      args: [MEM_E0_PUBLIC_VERIFIER],
      cwd: ".",
      executable: "node",
      purpose: "verify",
    });
  }

  observations(): readonly ApprovalObservation[] {
    return Object.freeze(this.#observations.map((value) => Object.freeze({
      ...value,
    })));
  }

  async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    let matches = false;
    if (preview.actionKind === "apply_patch") {
      matches =
        preview.paths.length === 1 &&
        preview.paths[0]?.kind === "modify" &&
        preview.paths[0].path === this.targetRelativePath &&
        preview.addedLines >= 1 &&
        preview.addedLines <= 8 &&
        preview.removedLines >= 1 &&
        preview.removedLines <= 8 &&
        !preview.previewTruncated;
      if (matches) {
        this.binding.bindPatch({
          addedLines: preview.addedLines,
          patchSha256: sha256Canonical(preview),
          removedLines: preview.removedLines,
          targetRelativePath: this.targetRelativePath,
        });
      }
    } else if (preview.actionKind === "run_command") {
      matches =
        preview.executable === "node" &&
        preview.args.length === 1 &&
        preview.args[0] === MEM_E0_PUBLIC_VERIFIER &&
        preview.cwd === "." &&
        preview.executor === "local" &&
        preview.purpose === "verify";
    }
    const decision: ApprovalDecision = signal.aborted
      ? "cancelled"
      : matches
        ? "approved"
        : "denied";
    this.#observations.push(Object.freeze({
      actionKind: preview.actionKind,
      decision,
      previewSha256: sha256Canonical(preview),
    }));
    return decision;
  }
}

const noninteractiveApprovalInput: ApprovalLineReader = Object.freeze({
  interactive: false,
  readLine: async () => null,
});

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function pathNested(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function isolatedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  stateRoot: string,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    APPDATA: join(stateRoot, "appdata"),
    BORN_CONTROL_STATE_ROOT: stateRoot,
    BORN_HOOK_SUPPRESSED: "1",
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LOCALAPPDATA: join(stateRoot, "localappdata"),
    NO_COLOR: "1",
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: join(stateRoot, "temp"),
    TMP: join(stateRoot, "temp"),
    USERPROFILE: join(stateRoot, "profile"),
    WINDIR: source.WINDIR,
    XDG_STATE_HOME: join(stateRoot, "xdg-state"),
  });
}

export function memE0ActorQualificationAdapterConfigSha256(
  fixture: MemE0LoadedActorQualificationFixture,
): string {
  return sha256Canonical({
    applicationServiceEntry:
      fixture.config.actor.applicationServiceEntry,
    command: {
      commandApproval: "ask",
      commandTimeoutMs: 30_000,
      completionPolicy: "verified",
      editApproval: "ask",
      executor: "local",
      maxCommandOutputBytes: 16_384,
      maxDurationMs: 300_000,
      maxSteps: fixture.config.budgets.maximumProviderRequests,
      maxTokens: fixture.config.budgets.maximumReportedTotalTokens,
      maxToolOutputBytes: 65_536,
      memoryMode: "off",
      mcpServerIds: [],
      requireVerification: "auto",
      taskProfile: "coding",
    },
    policyProfileId: fixture.config.remotePolicy.profileId,
    policyProfileSha256: fixture.config.remotePolicy.profileSha256,
    policyRawSha256: fixture.policyRawSha256,
    provider: fixture.config.provider,
    qualificationConfigSha256: fixture.config.configSha256,
    taskSha256: fixture.config.fixture.case.taskSha256,
    toolAllowlistSha256: fixture.config.actor.toolAllowlistSha256,
    toolCatalogSha256: fixture.config.actor.toolCatalogSha256,
  });
}

function commandOptions(
  fixture: MemE0LoadedActorQualificationFixture,
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
    maxDurationMs: "300000",
    maxSteps: String(fixture.config.budgets.maximumProviderRequests),
    maxTokens: String(fixture.config.budgets.maximumReportedTotalTokens),
    maxToolOutputBytes: "65536",
    mcpPromptArgumentsJson: undefined,
    mcpPromptSelection: undefined,
    mcpServerIds: [],
    memoryMode: "off",
    mode: undefined,
    model: fixture.config.provider.model,
    policyConfig: fixture.policyPath,
    policyProfile: MEM_E0_ACTOR_QUALIFICATION_POLICY_PROFILE_ID,
    provider: fixture.config.provider.provider,
    providerSource: "provider_network",
    reportFormat: "json",
    requestTimeoutMs: "90000",
    requireVerification: "auto",
    sandboxCpus: undefined,
    sandboxMemoryMiB: undefined,
    sandboxPids: undefined,
    sandboxTmpMiB: undefined,
    skillArguments: undefined,
    skillSelections: [],
    task: fixture.case.definition.task.text,
    taskProfile: "coding",
    verbose: false,
  });
}

async function productionRuntimeImplementationSha256(
  repositoryRoot: string,
): Promise<string> {
  return rawSha256(await readFile(join(
    repositoryRoot,
    "src",
    "providers",
    "pi",
    "production-pi-runtime-port.ts",
  )));
}

async function validateLocalQualificationRecord(input: Readonly<{
  readonly fixture: MemE0LoadedActorQualificationFixture;
  readonly freeze: MemE0ActorQualificationFreeze;
  readonly modelEvidence: RemoteLiveQualifiedModelEvidence;
  readonly workspace: string;
}>): Promise<void> {
  const recordPath = resolve(
    input.workspace,
    ...input.modelEvidence.qualificationEvidenceRef.split("/"),
  );
  if (!pathNested(input.workspace, recordPath)) {
    throw new Error("qualification record escaped the actor workspace");
  }
  const metadata = await lstat(recordPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("qualification record is not a regular file");
  }
  const [canonicalWorkspace, canonicalRecord, raw] = await Promise.all([
    realpath(input.workspace),
    realpath(recordPath),
    readFile(recordPath, "utf8"),
  ]);
  if (!pathNested(canonicalWorkspace, canonicalRecord)) {
    throw new Error("qualification record canonical path escaped the workspace");
  }
  const record = modelQualificationRecordSchema.parse(parseStrictJson(raw));
  const usage = record.probeResults.find((entry) =>
    entry.probeId === "usage_semantics_v1");
  if (
    sha256Canonical(record.identity) !==
      sha256Canonical(input.fixture.config.genericModelQualification.expectedIdentity) ||
    modelQualificationIdentitySha256(record.identity) !==
      input.freeze.modelQualificationIdentitySha256 ||
    sha256Canonical(record) !== input.freeze.modelQualificationRecordSha256 ||
    record.evidenceSha256 !== input.freeze.modelQualificationEvidenceSha256 ||
    record.evidenceSha256 !== input.modelEvidence.qualificationEvidenceSha256 ||
    record.totalRequestCount !== input.modelEvidence.qualificationRequestCount ||
    !record.qualifiedModes.includes("build") ||
    usage?.status !== "passed" ||
    usage.observed.availability !== "complete"
  ) {
    throw new Error("generic qualification record drifted from its frozen evidence");
  }
}

async function validateInitialPublicWorkspace(input: Readonly<{
  readonly fixture: MemE0LoadedActorQualificationFixture;
  readonly workspace: string;
}>): Promise<string> {
  const canonicalWorkspace = await realpath(input.workspace);
  const entries = await Promise.all(input.fixture.case.publicFiles.map(
    async (file) => {
      const path = resolve(input.workspace, ...file.path.split("/"));
      if (!pathNested(input.workspace, path)) {
        throw new Error("qualification public file escaped the actor workspace");
      }
      const [metadata, canonicalPath, bytes] = await Promise.all([
        lstat(path),
        realpath(path),
        readFile(path),
      ]);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        !pathNested(canonicalWorkspace, canonicalPath) ||
        rawSha256(bytes) !== file.rawSha256
      ) {
        throw new Error("qualification public workspace changed before actor start");
      }
      return Object.freeze({
        byteLength: bytes.byteLength,
        path: file.path,
        rawSha256: rawSha256(bytes),
      });
    },
  ));
  const manifestSha256 = sha256Canonical(entries);
  const initialTarget = entries.find((entry) =>
    entry.path === input.fixture.config.fixture.case.targetRelativePath);
  if (
    manifestSha256 !==
      input.fixture.config.fixture.case.publicWorkspaceManifestSha256 ||
    initialTarget?.rawSha256 !==
      input.fixture.config.fixture.case.initialTargetRawSha256 ||
    (await changedPaths(input.workspace)).length !== 0
  ) {
    throw new Error("qualification initial workspace did not match its freeze");
  }
  return manifestSha256;
}

function assertExactBackendRequest(
  request: BackendCreationRequest,
  fixture: MemE0LoadedActorQualificationFixture,
): void {
  if (
    request.provider !== MEM_E0_ACTOR_QUALIFICATION_PROVIDER ||
    request.model !== MEM_E0_ACTOR_QUALIFICATION_MODEL ||
    request.endpoint !== MEM_E0_ACTOR_QUALIFICATION_ENDPOINT ||
    request.transportScope !== "provider_network" ||
    request.runtimePolicy?.entry.profile.id !==
      MEM_E0_ACTOR_QUALIFICATION_POLICY_PROFILE_ID ||
    request.runtimePolicy.evidence.profileSha256 !==
      fixture.config.remotePolicy.profileSha256
  ) {
    throw new Error("qualification backend request drifted from remote policy");
  }
}

async function changedPaths(workspace: string): Promise<readonly string[]> {
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "HEAD", "--"], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    }),
  ]);
  return Object.freeze([
    ...new Set(`${tracked.stdout}\n${untracked.stdout}`
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/"))),
  ].sort((left, right) => left.localeCompare(right, "en")));
}

type StoredRunEvent = Readonly<{
  readonly data: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly runId: string;
  readonly scope: "run";
  readonly type: string;
}>;

function runEvents(writer: V2SessionWriter | null): readonly StoredRunEvent[] {
  if (writer === null) return Object.freeze([]);
  return Object.freeze(writer.events.filter((event): event is typeof event & StoredRunEvent =>
    event.scope === "run").map((event) => event as unknown as StoredRunEvent));
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function analyzeSession(input: Readonly<{
  readonly events: readonly StoredRunEvent[];
  readonly approvals: readonly ApprovalObservation[];
  readonly providerRequestHashes: readonly string[];
}>): Readonly<{
  readonly agentLoopObservationSha256: string;
  readonly agentLoopObserved: boolean;
  readonly applicationServiceObservationSha256: string;
  readonly applicationServiceObserved: boolean;
  readonly approvalDecisions: Readonly<{
    readonly approved: number;
    readonly cancelled: number;
    readonly denied: number;
  }>;
  readonly approvalObservationSha256s: readonly string[];
  readonly completionEvidenceSha256: string;
  readonly pendingEffectCount: number;
  readonly publicVerifierPassed: boolean;
  readonly sessionEventSpanSha256: string;
  readonly terminal: "bounded_stop" | "failed" | "verified_finish_task";
  readonly toolArgumentSha256s: readonly string[];
  readonly toolNames: readonly (typeof MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE)[number][];
  readonly toolSuccessCount: number;
  readonly unknownEffectCount: number;
}> {
  const started = input.events.filter((event) => event.type === "run.started");
  const backend = input.events.filter((event) => event.type === "backend.selected");
  const applicationCommit = dataRecord(started[0]?.data.application_commit);
  const applicationServiceObserved =
    started.length === 1 &&
    applicationCommit?.action_kind === "session.message.submit";
  const requested = input.events.filter((event) =>
    event.type === "tool.call.requested");
  const completed = input.events.filter((event) =>
    event.type === "tool.call.completed");
  const completedById = new Map(completed.map((event) => [
    stringValue(event.data.call_id),
    event,
  ] as const));
  const allowed = new Set<string>(MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE);
  const toolNames = requested.flatMap((event) => {
    const name = stringValue(event.data.tool_name);
    return name !== null && allowed.has(name)
      ? [name as (typeof MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE)[number]]
      : [];
  });
  const toolArgumentSha256s = requested.map((event) => rawSha256(
    stringValue(event.data.arguments_json) ?? "<invalid-tool-arguments>",
  ));
  const matchedIds = new Set<string>();
  let toolSuccessCount = 0;
  let pendingEffectCount = 0;
  let unknownEffectCount = 0;
  for (const event of requested) {
    const callId = stringValue(event.data.call_id);
    const name = stringValue(event.data.tool_name);
    if (callId === null || name === null || !allowed.has(name)) {
      unknownEffectCount += 1;
      continue;
    }
    const result = completedById.get(callId);
    if (result === undefined) {
      pendingEffectCount += 1;
      continue;
    }
    matchedIds.add(callId);
    if (
      result.data.tool_name !== undefined &&
      result.data.tool_name !== name
    ) {
      unknownEffectCount += 1;
    } else if (result.data.status === "success") {
      toolSuccessCount += 1;
    }
  }
  for (const event of completed) {
    const callId = stringValue(event.data.call_id);
    if (callId === null || !matchedIds.has(callId)) unknownEffectCount += 1;
  }
  const terminalEvents = input.events.filter((event) => [
    "run.budget_exceeded",
    "run.cancelled",
    "run.completed",
    "run.failed",
    "run.incomplete",
  ].includes(event.type));
  const terminalEvent = terminalEvents.at(-1);
  const verified =
    terminalEvents.length === 1 &&
    terminalEvent?.type === "run.completed" &&
    terminalEvent.data.completion_mode === "verified_finish_task" &&
    typeof terminalEvent.data.evidence_sha256 === "string" &&
    SHA256.test(terminalEvent.data.evidence_sha256) &&
    typeof terminalEvent.data.report_sha256 === "string" &&
    SHA256.test(terminalEvent.data.report_sha256);
  const bounded = terminalEvent?.type === "run.budget_exceeded" ||
    terminalEvent?.type === "run.incomplete";
  const stepStarted = input.events.filter((event) =>
    event.type === "agent.step.started").length;
  const stepCompleted = input.events.filter((event) =>
    event.type === "agent.step.completed").length;
  const applicationServiceObservationSha256 = sha256Canonical(
    applicationCommit ?? null,
  );
  const agentLoopObservation = {
    backendSelectedCount: backend.length,
    providerRequestHashes: input.providerRequestHashes,
    runStartedCount: started.length,
    stepCompleted,
    stepStarted,
    terminalTypes: terminalEvents.map((event) => event.type),
    toolNames,
  };
  const approvalDecisions = input.approvals.reduce((counts, value) => ({
    ...counts,
    [value.decision]: counts[value.decision] + 1,
  }), { approved: 0, cancelled: 0, denied: 0 });
  return Object.freeze({
    agentLoopObservationSha256: sha256Canonical(agentLoopObservation),
    agentLoopObserved:
      started.length === 1 &&
      backend.length === 1 &&
      stepStarted > 0 &&
      stepStarted === stepCompleted,
    applicationServiceObservationSha256,
    applicationServiceObserved,
    approvalDecisions: Object.freeze(approvalDecisions),
    approvalObservationSha256s: Object.freeze(input.approvals.map((value) =>
      sha256Canonical(value))),
    completionEvidenceSha256: verified
      ? terminalEvent.data.evidence_sha256 as string
      : sha256Canonical(null),
    pendingEffectCount,
    publicVerifierPassed: requested.some((event) => {
      const callId = stringValue(event.data.call_id);
      return event.data.tool_name === "run_command" &&
        callId !== null &&
        completedById.get(callId)?.data.status === "success";
    }),
    sessionEventSpanSha256: sha256Canonical(input.events.map((event) => ({
      dataSha256: sha256Canonical(event.data),
      eventIdSha256: rawSha256(event.eventId),
      runIdSha256: rawSha256(event.runId),
      type: event.type,
    }))),
    terminal: verified
      ? "verified_finish_task"
      : bounded
        ? "bounded_stop"
        : "failed",
    toolArgumentSha256s: Object.freeze(toolArgumentSha256s),
    toolNames: Object.freeze(toolNames),
    toolSuccessCount,
    unknownEffectCount,
  });
}

export function parseMemE0LiveActorQualificationInput(
  value: unknown,
): MemE0LiveActorQualificationInput {
  const parsed = actorInputSchema.parse(value);
  return Object.freeze({
    ...parsed,
    freeze: Object.freeze(parsed.freeze),
    modelEvidence: Object.freeze(parsed.modelEvidence),
    source: Object.freeze(parsed.source),
  });
}

export function parseMemE0LiveActorQualificationOutput(
  value: unknown,
): MemE0LiveActorQualificationOutput {
  return Object.freeze(actorOutputSchema.parse(value));
}

export async function runMemE0LiveActorQualification(
  rawInput: MemE0LiveActorQualificationInput,
): Promise<MemE0LiveActorQualificationOutput> {
  const input = parseMemE0LiveActorQualificationInput(rawInput);
  const repositoryRoot = normalizedAbsolutePath(
    input.repositoryRoot,
    "repositoryRoot",
  );
  const stateRoot = normalizedAbsolutePath(input.stateRoot, "stateRoot");
  const workspace = normalizedAbsolutePath(input.workspace, "workspace");
  if (
    pathNested(repositoryRoot, stateRoot) ||
    pathNested(repositoryRoot, workspace) ||
    pathNested(stateRoot, workspace) ||
    pathNested(workspace, stateRoot)
  ) {
    throw new Error("qualification repo, state, and workspace roots must be disjoint");
  }
  const fixture = await loadMemE0ActorQualificationFixture(repositoryRoot);
  const actualSource = await observeMemE0ActorQualificationSource({
    repositoryRoot,
  });
  if (sha256Canonical(actualSource) !== sha256Canonical(input.source)) {
    throw new Error("qualification source changed before actor start");
  }
  const productionImplementationSha256 =
    await productionRuntimeImplementationSha256(repositoryRoot);
  const pricing = createMemE0LivePricingSnapshot();
  const expectedFreeze = createMemE0ActorQualificationFreeze({
    adapterConfigSha256: memE0ActorQualificationAdapterConfigSha256(fixture),
    modelQualificationEvidenceSha256:
      input.freeze.modelQualificationEvidenceSha256,
    modelQualificationIdentitySha256:
      input.freeze.modelQualificationIdentitySha256,
    modelQualificationObservationSha256:
      input.freeze.modelQualificationObservationSha256,
    modelQualificationPricingSha256:
      input.freeze.modelQualificationPricingSha256,
    modelQualificationProtocolSha256:
      input.freeze.modelQualificationProtocolSha256,
    modelQualificationRecordSha256:
      input.freeze.modelQualificationRecordSha256,
    policySha256: fixture.config.remotePolicy.profileSha256,
    pricingSha256: pricing.pricingSha256,
    productionPiRuntimeImplementationSha256: productionImplementationSha256,
    qualificationFixtureSha256: fixture.config.fixture.fixtureBindingSha256,
    qualificationProtocolSha256: fixture.config.configSha256,
    systemInstructionSha256: rawSha256(AGENT_SYSTEM_INSTRUCTIONS),
    toolCatalogSha256: fixture.config.actor.toolCatalogSha256,
  });
  if (expectedFreeze.actorFreezeSha256 !== input.freeze.actorFreezeSha256) {
    throw new Error("qualification actor freeze changed before actor start");
  }
  await validateLocalQualificationRecord({
    fixture,
    freeze: input.freeze,
    modelEvidence: input.modelEvidence,
    workspace,
  });
  const initialWorkspaceManifestSha256 = await validateInitialPublicWorkspace({
    fixture,
    workspace,
  });
  const target = fixture.config.fixture.case.targetRelativePath;
  await validateMemE0ActualEffectBinding({
    effectBinding: {
      publicVerifierRawSha256:
        fixture.config.fixture.case.publicVerifierRawSha256,
      targetRelativePath: target,
    },
    memoryKind: null,
    memoryMode: "off",
    phase: "effect",
    schemaVersion: 1,
    stateRoot,
    task: fixture.case.definition.task.text,
    workspace,
  });
  const binding = new MemoryEffectApprovalBinding();
  const approvals = new MemE0LiveExactApprovalPrompt(binding, target);
  const stdout = new HashOnlyWriter();
  const stderr = new HashOnlyWriter();
  const io: CliIO = Object.freeze({ stdout, stderr });
  const environment = isolatedEnvironment(process.env, stateRoot);
  const meter = new MemE0ActorQualificationProviderMeter({
    frozenProductionImplementationIdentitySha256:
      productionImplementationSha256,
    pricingSha256: pricing.pricingSha256,
  });
  const base = createNodeRuntime({
    approvalInput: noninteractiveApprovalInput,
    approvalPromptOverride: approvals,
    capabilityUserStateRoot: join(stateRoot, "capabilities"),
    cwd: workspace,
    delegationUserStateRoot: join(stateRoot, "delegations"),
    env: environment,
    execPath: process.execPath,
    killProcess: (processIdentity, signal) =>
      process.kill(processIdentity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0-fal-mem-e0-qualification",
    workerUserStateRoot: join(stateRoot, "workers"),
    worktreeUserStateRoot: join(stateRoot, "worktrees"),
  });
  let writer: V2SessionWriter | null = null;
  let backendCreatedCount = 0;
  let backendRequestExact = false;
  let toolRegistryCreatedCount = 0;
  let observedToolCatalogSha256 = sha256Canonical(null);
  let remoteMemoryGrantRequestCount = 0;
  const runtime: CliRuntime = {
    ...base,
    agentModelEvidence: (provider) =>
      provider === MEM_E0_ACTOR_QUALIFICATION_PROVIDER
        ? input.modelEvidence
        : null,
    createAgentToolRegistry: async (options) => {
      const production = await createMemE0EffectToolRegistry({
        approvalBinding: binding,
        effectBinding: {
          publicVerifierRawSha256:
            fixture.config.fixture.case.publicVerifierRawSha256,
          targetRelativePath: target,
        },
        environment,
        options,
      });
      const registry = new RestrictedToolRegistry(
        production,
        MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE,
      );
      toolRegistryCreatedCount += 1;
      observedToolCatalogSha256 = sha256Canonical(registry.modelDefinitions);
      if (
        toolRegistryCreatedCount !== 1 ||
        observedToolCatalogSha256 !== fixture.config.actor.toolCatalogSha256
      ) {
        throw new Error("qualification production tool catalog drifted");
      }
      return registry;
    },
    createModelBackend: (request) => {
      assertExactBackendRequest(request, fixture);
      backendRequestExact = true;
      backendCreatedCount += 1;
      if (backendCreatedCount !== 1) {
        throw new Error("qualification requires exactly one backend instance");
      }
      const backend = base.createModelBackend(request);
      if (
        backend.identity.provider !== MEM_E0_ACTOR_QUALIFICATION_PROVIDER ||
        backend.identity.model !== MEM_E0_ACTOR_QUALIFICATION_MODEL ||
        backend.identity.adapter !== "pi-ai"
      ) {
        throw new Error("qualification production backend identity drifted");
      }
      return meter.wrap(backend);
    },
    createPublicSyntheticRemoteMemoryGrant: async () => {
      remoteMemoryGrantRequestCount += 1;
      throw new Error("memory-off qualification requested a remote memory grant");
    },
    modelQualificationGate: {
      requireQualified: async () => {
        throw new ModelQualificationError(
          "model_unqualified",
          "MEM-E0 qualification unexpectedly entered the Phase 16 gate",
        );
      },
    },
    observeSessionWriter: (observed) => {
      if (!(observed instanceof V2SessionWriter) || writer !== null) {
        throw new Error("qualification observed an unexpected session writer");
      }
      writer = observed;
    },
  };

  let exitCode = 1;
  let orchestrationFailure = false;
  try {
    exitCode = await executeAgentThroughApplicationService(
      commandOptions(fixture),
      runtime,
      io,
    );
  } catch {
    orchestrationFailure = true;
  } finally {
    try {
      await disposeApplicationHostForStateRoot(stateRoot);
    } catch {
      orchestrationFailure = true;
    }
  }
  const stdoutDigest = stdout.digest();
  const stderrDigest = stderr.digest();
  let providerObservation;
  try {
    providerObservation = meter.finalize();
  } catch {
    orchestrationFailure = true;
    providerObservation = meter.snapshot();
  }
  const events = runEvents(writer);
  const session = analyzeSession({
    approvals: approvals.observations(),
    events,
    providerRequestHashes:
      providerObservation.providerUsage.requestObservationSha256s,
  });
  const observedChangedPaths = await changedPaths(workspace).catch(() => {
    orchestrationFailure = true;
    return Object.freeze([] as string[]);
  });
  const run = memE0ActorQualificationRunSchema.parse({
    agentExitCode: exitCode,
    agentLoopObservationSha256: session.agentLoopObservationSha256,
    agentLoopObserved: session.agentLoopObserved,
    applicationServiceObservationSha256:
      session.applicationServiceObservationSha256,
    applicationServiceObserved: session.applicationServiceObserved,
    approvalDecisions: session.approvalDecisions,
    approvalObservationSha256s: session.approvalObservationSha256s,
    changedPaths: observedChangedPaths,
    completionEvidenceSha256: session.completionEvidenceSha256,
    domainHarnessUsed: runtime.domainHarness !== undefined,
    endpointScope:
      backendRequestExact && providerObservation.providerUsage.requestsStarted > 0
        ? "provider_network"
        : "in_process",
    historicalMemoryItemCount:
      providerObservation.historicalMemoryItemCount,
    memoryMode: "off",
    modelEvidenceKind: input.modelEvidence.kind,
    modelQualificationEvidenceSha256:
      input.freeze.modelQualificationEvidenceSha256,
    modelQualificationIdentitySha256:
      input.freeze.modelQualificationIdentitySha256,
    modelQualificationObservationSha256:
      input.freeze.modelQualificationObservationSha256,
    modelQualificationPricingSha256:
      input.freeze.modelQualificationPricingSha256,
    modelQualificationProtocolSha256:
      input.freeze.modelQualificationProtocolSha256,
    modelQualificationRecordSha256:
      input.freeze.modelQualificationRecordSha256,
    modelRequestObservationSha256s:
      providerObservation.providerUsage.requestObservationSha256s,
    observedActorFreezeSha256: input.freeze.actorFreezeSha256,
    observedAdapterConfigSha256:
      memE0ActorQualificationAdapterConfigSha256(fixture),
    observedInitialWorkspaceManifestSha256: initialWorkspaceManifestSha256,
    observedPolicySha256: fixture.config.remotePolicy.profileSha256,
    observedProductionPiRuntimeImplementationSha256:
      productionImplementationSha256,
    observedProtectedTreeSha256: actualSource.protectedTreeSha256,
    observedPublicVerifierSha256:
      fixture.config.fixture.case.publicVerifierRawSha256,
    observedQualificationFixtureSha256:
      fixture.config.fixture.fixtureBindingSha256,
    observedQualificationProtocolSha256: fixture.config.configSha256,
    observedSourceCommit: actualSource.commit,
    observedSystemInstructionSha256: rawSha256(AGENT_SYSTEM_INSTRUCTIONS),
    observedTaskSha256: fixture.config.fixture.case.taskSha256,
    observedToolCatalogSha256,
    orchestrationFailure,
    pendingEffectCount: session.pendingEffectCount,
    productEntrySha256: MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
    logicalProviderTurnRequestCount:
      providerObservation.providerUsage.requestsStarted,
    publicVerifierPassed: session.publicVerifierPassed,
    remoteMemoryGrantRequested: remoteMemoryGrantRequestCount > 0,
    sessionEventSpanSha256: session.sessionEventSpanSha256,
    stderrSha256: stderrDigest.sha256,
    stdoutSha256: stdoutDigest.sha256,
    terminal: session.terminal,
    toolArgumentSha256s: session.toolArgumentSha256s,
    toolNames: session.toolNames,
    toolRegistryCreatedCount,
    toolSuccessCount: session.toolSuccessCount,
    unknownEffectCount: session.unknownEffectCount,
  });
  return Object.freeze(actorOutputSchema.parse({
    actorProcessId: process.pid,
    providerUsage: providerObservation.providerUsage,
    run,
    schemaVersion: 1,
  }));
}
