import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  ApprovalDecision,
  ApprovalLineReader,
  ApprovalPreview,
  ApprovalPrompt,
} from "../../../../src/approvals/approval-types.js";
import type { AgentCommandOptions, AgentExitCode } from "../../../../src/agent/agent-types.js";
import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import { runCli } from "../../../../src/cli/run-cli.js";
import type { CliIO, CliRuntime } from "../../../../src/cli/types.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type {
  PreparedVerificationClassification,
} from "../../../../src/completion/phase7-completion-runtime.js";
import {
  disposeApplicationHostForStateRoot,
  executeAgentThroughApplicationService,
} from "../../../../src/control-plane/adapters/agent-cli-adapter.js";
import {
  explicitMemoryRecordV1Schema,
  normalizeExplicitMemoryText,
  type ExplicitMemoryRecordV1,
} from "../../../../src/memory/core/memory-record-v1.js";
import { ExecutionPreparer } from "../../../../src/execution/execution-preparer.js";
import { createDefaultExecutableRegistry } from "../../../../src/execution/executable-registry.js";
import {
  createNodeSpawnAdapter,
  LocalExecutor,
} from "../../../../src/execution/local-executor.js";
import {
  createTaskkillArgvRunner,
  NodeProcessTreeCleanup,
} from "../../../../src/execution/process-tree-cleanup.js";
import type { PreparedExecution } from "../../../../src/execution/execution-types.js";
import {
  OFFLINE_NODE_GUARD_IDENTITY,
  OFFLINE_NODE_GUARD_SHA256,
} from "../../../../src/execution/environment-filter.js";
import { evaluateHardDeny } from "../../../../src/permissions/default-policy.js";
import { PermissionEngine } from "../../../../src/permissions/permission-engine.js";
import type {
  CommandActionIdentity,
  NormalizedAction,
  PermissionContext,
  PermissionPolicy,
  PolicyDecision,
} from "../../../../src/permissions/permission-types.js";
import {
  isTrustedLocalFreeEnvironmentPolicy,
} from "../../../../src/permissions/trusted-local-fixture-manifest.js";
import { redactSensitiveText } from "../../../../src/security/redact.js";
import {
  createAgentToolRegistry as createProductionAgentToolRegistry,
  type AgentToolRegistryOptions,
} from "../../../../src/tools/create-agent-tool-registry.js";
import { RestrictedToolRegistry } from "../../../../src/tools/restricted-tool-registry.js";
import {
  DeterministicMemoryEffectBackend,
  MemoryEffectApprovalBinding,
  type MemoryEffectBackendObservationV1,
  type MemoryEffectPhase,
} from "./deterministic-memory-effect-backend.js";

export const MEM_E0_PROVIDER = "ollama" as const;
export const MEM_E0_MODEL = "qwen3:1.7b" as const;
export const MEM_E0_PROVIDER_SOURCE = "in_process_test" as const;
export const MEM_E0_PUBLIC_VERIFIER = "verify.mjs" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/u;

interface ProductionMemoryEffectActorInputBaseV1 {
  readonly schemaVersion: 1;
  readonly stateRoot: string;
  readonly task: string;
  readonly workspace: string;
}

export interface ProductionMemoryEffectBindingV1 {
  readonly publicVerifierRawSha256: string;
  readonly targetRelativePath: string;
}

export type ProductionMemoryEffectActorInputV1 =
  | Readonly<ProductionMemoryEffectActorInputBaseV1 & {
      readonly effectBinding: null;
      readonly memoryKind: "constraint" | "decision";
      readonly memoryMode: "local";
      readonly phase: "seed";
    }>
  | Readonly<ProductionMemoryEffectActorInputBaseV1 & {
      readonly effectBinding: Readonly<ProductionMemoryEffectBindingV1>;
      readonly memoryKind: null;
      readonly memoryMode: "local" | "off";
      readonly phase: "effect";
    }>;

export interface ProductionMemoryEffectActorObservationV1 {
  readonly agentExitCode: AgentExitCode;
  readonly approvalObservationSha256s: readonly string[];
  readonly backendCreatedCount: number;
  readonly backendObservationSha256: string;
  readonly canonicalContextSha256s: readonly string[];
  readonly childPid: number;
  readonly decisionCounts: Readonly<Record<string, number>>;
  readonly explicitMemoryLogicalSha256: string | null;
  readonly explicitMemoryRecordIdSha256: string | null;
  readonly explicitMemoryRecordSha256: string | null;
  readonly explicitRememberExitCode: AgentExitCode | null;
  readonly explicitRememberStatus: "added" | "failed" | "not_run";
  readonly historicalItemCounts: readonly number[];
  readonly memoryMode: "local" | "off";
  readonly memoryRecordIdSha256s: readonly string[];
  readonly memoryValueSha256s: readonly string[];
  readonly orchestrationFailure: boolean;
  readonly phase: MemoryEffectPhase;
  readonly productEntrySha256: string;
  readonly providerNetworkRequests: 0;
  readonly providerSelectionSha256: string;
  readonly providerSourcePropagation: "requested_but_application_payload_not_observed";
  readonly providerSourceRequestedSha256: string;
  readonly schemaVersion: 1;
  readonly stateRootIdentitySha256: string;
  readonly stderrBytes: number;
  readonly stderrSha256: string;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly taskSha256: string;
  readonly toolCatalogSha256: string | null;
  readonly toolArgumentSha256s: readonly string[];
  readonly toolNames: readonly ("apply_patch" | "finish_task" | "read_file" | "run_command")[];
  readonly toolRegistryCreatedCount: number;
  readonly workspaceIdentitySha256: string;
}

interface ApprovalObservation {
  readonly actionKind: ApprovalPreview["actionKind"];
  readonly decision: ApprovalDecision;
  readonly previewSha256: string;
}

class HashOnlyWriter {
  readonly #hash = createHash("sha256");
  #bytes = 0;
  #digested = false;

  write(value: string): void {
    if (this.#digested) throw new TypeError("MEM-E0 output hash was already finalized");
    this.#hash.update(value, "utf8");
    this.#bytes += Buffer.byteLength(value, "utf8");
  }

  digest(): Readonly<{ readonly bytes: number; readonly sha256: string }> {
    if (this.#digested) throw new TypeError("MEM-E0 output hash can only be finalized once");
    this.#digested = true;
    return Object.freeze({ bytes: this.#bytes, sha256: this.#hash.digest("hex") });
  }
}

class BoundedCaptureWriter {
  #value = "";

  constructor(private readonly maximumBytes: number) {}

  write(value: string): void {
    if (Buffer.byteLength(this.#value, "utf8") + Buffer.byteLength(value, "utf8") > this.maximumBytes) {
      throw new TypeError("MEM-E0 bounded command output exceeded its byte limit");
    }
    this.#value += value;
  }

  value(): string {
    return this.#value;
  }
}

class MemoryEffectExactApprovalPrompt implements ApprovalPrompt {
  readonly #observations: ApprovalObservation[] = [];

  constructor(private readonly binding: MemoryEffectApprovalBinding) {}

  observations(): readonly ApprovalObservation[] {
    return Object.freeze(this.#observations.map((observation) => Object.freeze({ ...observation })));
  }

  async request(preview: ApprovalPreview, signal: AbortSignal): Promise<ApprovalDecision> {
    const decision = signal.aborted
      ? "cancelled"
      : this.#matches(preview)
        ? "approved"
        : "denied";
    this.#observations.push(Object.freeze({
      actionKind: preview.actionKind,
      decision,
      previewSha256: sha256Canonical(preview),
    }));
    return decision;
  }

  #matches(preview: ApprovalPreview): boolean {
    if (preview.actionKind === "apply_patch") {
      const expected = this.binding.patch();
      return expected !== null &&
        preview.paths.length === 1 &&
        preview.paths[0]?.kind === "modify" &&
        preview.paths[0].path === expected.targetRelativePath &&
        preview.addedLines === expected.addedLines &&
        preview.removedLines === expected.removedLines &&
        !preview.previewTruncated;
    }
    if (preview.actionKind === "run_command") {
      const expected = this.binding.command();
      return expected !== null &&
        preview.executable === expected.executable &&
        preview.args.length === 1 &&
        preview.args[0] === expected.args[0] &&
        preview.cwd === expected.cwd &&
        preview.executor === "local" &&
        preview.purpose === expected.purpose;
    }
    return false;
  }
}

const noninteractiveApprovalInput: ApprovalLineReader = Object.freeze({
  interactive: false,
  readLine: async () => null,
});

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uniqueSorted(values: readonly (string | null)[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value): value is string => value !== null))].sort());
}

function uniqueSortedNumbers(values: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function pathNested(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function validatePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute path`);
  }
  return resolve(value);
}

function parseEffectBinding(value: unknown): Readonly<ProductionMemoryEffectBindingV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MEM-E0 effect binding must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    sha256Canonical(Object.keys(record).sort()) !==
      sha256Canonical(["publicVerifierRawSha256", "targetRelativePath"])
  ) {
    throw new TypeError("MEM-E0 effect binding has unknown or missing fields");
  }
  if (typeof record.publicVerifierRawSha256 !== "string" || !SHA256.test(record.publicVerifierRawSha256)) {
    throw new TypeError("MEM-E0 public verifier hash is invalid");
  }
  if (
    typeof record.targetRelativePath !== "string" ||
    !RELATIVE_PATH.test(record.targetRelativePath) ||
    record.targetRelativePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("MEM-E0 target path is invalid");
  }
  return Object.freeze({
    publicVerifierRawSha256: record.publicVerifierRawSha256,
    targetRelativePath: record.targetRelativePath,
  });
}

export function parseProductionMemoryEffectActorInput(value: unknown): ProductionMemoryEffectActorInputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MEM-E0 child input must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "effectBinding",
    "memoryKind",
    "memoryMode",
    "phase",
    "schemaVersion",
    "stateRoot",
    "task",
    "workspace",
  ];
  if (sha256Canonical(keys) !== sha256Canonical(expectedKeys)) {
    throw new TypeError("MEM-E0 child input has unknown or missing fields");
  }
  if (record.schemaVersion !== 1) throw new TypeError("MEM-E0 child schema version is unsupported");
  if (record.phase !== "seed" && record.phase !== "effect") {
    throw new TypeError("MEM-E0 child phase is invalid");
  }
  if (record.memoryMode !== "local" && record.memoryMode !== "off") {
    throw new TypeError("MEM-E0 child memory mode is invalid");
  }
  if (record.phase === "seed") {
    if (
      record.effectBinding !== null ||
      record.memoryMode !== "local" ||
      (record.memoryKind !== "decision" && record.memoryKind !== "constraint")
    ) {
      throw new TypeError("MEM-E0 seed requires local admission and a decision or constraint kind");
    }
  } else if (record.memoryKind !== null) {
    throw new TypeError("MEM-E0 effect does not admit a memory kind");
  }
  if (
    typeof record.task !== "string" ||
    record.task.trim().length === 0 ||
    record.task.includes("\0") ||
    Buffer.byteLength(record.task, "utf8") > 16_384
  ) {
    throw new TypeError("MEM-E0 child task is invalid");
  }
  const stateRoot = validatePath(record.stateRoot, "stateRoot");
  const workspace = validatePath(record.workspace, "workspace");
  if (pathNested(stateRoot, workspace) || pathNested(workspace, stateRoot)) {
    throw new TypeError("MEM-E0 workspace and Host state root must be disjoint");
  }
  return record.phase === "seed"
    ? Object.freeze({
        effectBinding: null,
        memoryKind: record.memoryKind as "constraint" | "decision",
        memoryMode: "local" as const,
        phase: "seed" as const,
        schemaVersion: 1 as const,
        stateRoot,
        task: record.task,
        workspace,
      })
    : Object.freeze({
        effectBinding: parseEffectBinding(record.effectBinding),
        memoryKind: null,
        memoryMode: record.memoryMode as "local" | "off",
        phase: "effect" as const,
        schemaVersion: 1 as const,
        stateRoot,
        task: record.task,
        workspace,
      });
}

function isolatedEnvironment(stateRoot: string): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {
    BORN_CONTROL_STATE_ROOT: stateRoot,
    BORN_HOOK_SUPPRESSED: "1",
    NO_COLOR: "1",
  };
  for (const key of [
    "COMSPEC",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "WINDIR",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return Object.freeze(environment);
}

function commandOptions(input: ProductionMemoryEffectActorInputV1): AgentCommandOptions {
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
    maxDurationMs: "120000",
    maxSteps: input.phase === "seed" ? "1" : "4",
    maxTokens: "128",
    maxToolOutputBytes: "65536",
    mcpPromptArgumentsJson: undefined,
    mcpPromptSelection: undefined,
    mcpServerIds: undefined,
    // Seed registration is deliberately storage-free. The explicit product
    // command below is the only admission path in the seed child.
    memoryMode: input.phase === "seed" ? "off" : input.memoryMode,
    model: MEM_E0_MODEL,
    policyConfig: undefined,
    policyProfile: "local-free-v1",
    provider: MEM_E0_PROVIDER,
    // The current Application adapter strips this internal-only field from its
    // persisted message payload. The result therefore records requested, not
    // effective, source propagation and must not claim that Host binding passed.
    providerSource: MEM_E0_PROVIDER_SOURCE,
    reportFormat: "json",
    requestTimeoutMs: "30000",
    requireVerification: "auto",
    sandboxCpus: undefined,
    sandboxMemoryMiB: undefined,
    sandboxPids: undefined,
    sandboxTmpMiB: undefined,
    skillArguments: undefined,
    skillSelections: undefined,
    task: input.task,
    taskProfile: input.phase === "seed" ? "read-only" : "coding",
    verbose: false,
  });
}

function asAgentExitCode(value: number): AgentExitCode {
  if ([0, 1, 2, 3, 4, 5, 6, 7, 8, 130].includes(value)) return value as AgentExitCode;
  throw new TypeError("MEM-E0 product command returned an unsupported exit code");
}

function parseRememberedRecord(
  output: string,
  input: Extract<ProductionMemoryEffectActorInputV1, { readonly phase: "seed" }>,
): ExplicitMemoryRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new TypeError("MEM-E0 explicit remember output was not JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("MEM-E0 explicit remember output was not an object");
  }
  const envelope = parsed as Readonly<Record<string, unknown>>;
  if (envelope.status !== "added" || envelope.schemaVersion !== 1) {
    throw new TypeError("MEM-E0 explicit remember did not add one v1 record");
  }
  const record = explicitMemoryRecordV1Schema.parse(envelope.record);
  if (record.kind !== input.memoryKind || record.text !== normalizeExplicitMemoryText(input.task)) {
    throw new TypeError("MEM-E0 explicit remember output changed the bound logical memory");
  }
  return record;
}

export async function validateMemE0ActualEffectBinding(
  input: Extract<ProductionMemoryEffectActorInputV1, { readonly phase: "effect" }>,
): Promise<Readonly<ProductionMemoryEffectBindingV1>> {
  const verifierPath = resolve(input.workspace, MEM_E0_PUBLIC_VERIFIER);
  const targetPath = resolve(input.workspace, input.effectBinding.targetRelativePath);
  if (!pathNested(input.workspace, verifierPath) || !pathNested(input.workspace, targetPath)) {
    throw new TypeError("MEM-E0 effect binding escaped the workspace");
  }
  const [verifierMetadata, targetMetadata] = await Promise.all([
    lstat(verifierPath),
    lstat(targetPath),
  ]);
  if (
    !verifierMetadata.isFile() || verifierMetadata.isSymbolicLink() ||
    !targetMetadata.isFile() || targetMetadata.isSymbolicLink()
  ) {
    throw new TypeError("MEM-E0 effect binding requires regular workspace files");
  }
  const [canonicalWorkspace, canonicalVerifier, canonicalTarget, verifierBytes] = await Promise.all([
    realpath(input.workspace),
    realpath(verifierPath),
    realpath(targetPath),
    readFile(verifierPath),
  ]);
  if (
    !pathNested(canonicalWorkspace, canonicalVerifier) ||
    !pathNested(canonicalWorkspace, canonicalTarget) ||
    verifierBytes.byteLength <= 0 ||
    verifierBytes.byteLength > 64 * 1024 ||
    createHash("sha256").update(verifierBytes).digest("hex") !==
      input.effectBinding.publicVerifierRawSha256
  ) {
    throw new TypeError("MEM-E0 actual public verifier did not match its Host binding");
  }
  return input.effectBinding;
}

function sameRunnerConfigHashes(
  action: CommandActionIdentity,
  effectBinding: Readonly<ProductionMemoryEffectBindingV1>,
): boolean {
  const expected = [
    Object.freeze({
      canonicalPath: OFFLINE_NODE_GUARD_IDENTITY,
      sha256: OFFLINE_NODE_GUARD_SHA256,
    }),
    Object.freeze({
      canonicalPath: MEM_E0_PUBLIC_VERIFIER,
      sha256: effectBinding.publicVerifierRawSha256,
    }),
  ].sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  const actual = action.executionInputs.runnerConfigHashes;
  return actual.length === expected.length && actual.every((entry, index) =>
    entry.canonicalPath === expected[index]?.canonicalPath &&
    entry.sha256 === expected[index]?.sha256
  );
}

function isExactEffectCommandAction(
  action: NormalizedAction,
  approvalBinding: MemoryEffectApprovalBinding,
  effectBinding: Readonly<ProductionMemoryEffectBindingV1>,
): action is CommandActionIdentity {
  if (action.actionKind !== "command") return false;
  const command = approvalBinding.command();
  const patch = approvalBinding.patch();
  return command !== null && patch !== null &&
    command.executable === "node" &&
    command.args.length === 1 && command.args[0] === MEM_E0_PUBLIC_VERIFIER &&
    command.cwd === "." && command.purpose === "verify" &&
    patch.targetRelativePath === effectBinding.targetRelativePath &&
    action.logicalExecutable === "node" &&
    action.argv.length === 1 && action.argv[0] === MEM_E0_PUBLIC_VERIFIER &&
    action.canonicalCwd === "." &&
    action.purpose === "verify" &&
    action.timeoutMs === 30_000 &&
    action.outputLimitBytes === 16_384 &&
    action.executionEnvironment === undefined &&
    action.packageManager === null &&
    action.lifecycleScripts === null &&
    action.executionInputs.manifestSha256 === null &&
    action.executionInputs.lockfileSha256 === null &&
    isTrustedLocalFreeEnvironmentPolicy(action.environmentPolicy) &&
    sameRunnerConfigHashes(action, effectBinding);
}

function contextReviewsAction(context: PermissionContext, actionSha256: string): boolean {
  const reviewed = context.reviewedLocalActionSha256;
  if (reviewed === undefined) return false;
  return Array.isArray(reviewed)
    ? reviewed.includes(actionSha256)
    : (reviewed as ReadonlySet<string>).has(actionSha256);
}

function memE0PermissionPolicy(
  approvalBinding: MemoryEffectApprovalBinding,
  effectBinding: Readonly<ProductionMemoryEffectBindingV1>,
): PermissionPolicy {
  return Object.freeze({
    evaluate(action: NormalizedAction, context: PermissionContext): PolicyDecision {
      if (action.actionKind !== "command") {
        return Object.freeze({
          effect: "deny" as const,
          reasonCode: "mem_e0_non_command_denied",
          ruleId: "mem-e0.deny.non-command.v1",
        });
      }
      const hardDeny = evaluateHardDeny(action);
      if (hardDeny !== null) return hardDeny;
      if (
        !isExactEffectCommandAction(action, approvalBinding, effectBinding) ||
        !contextReviewsAction(context, action.actionSha256)
      ) {
        return Object.freeze({
          effect: "deny" as const,
          reasonCode: "mem_e0_unbound_command_denied",
          ruleId: "mem-e0.deny.unbound-command.v1",
        });
      }
      return Object.freeze({
        effect: "ask" as const,
        reasonCode: "mem_e0_exact_public_verifier_requires_approval",
        ruleId: "mem-e0.ask.exact-public-verifier.v1",
      });
    },
    id: "bornagent.mem-e0-exact-public-verifier-policy",
    version: "1",
  });
}

export async function createMemE0EffectToolRegistry(input: Readonly<{
  readonly approvalBinding: MemoryEffectApprovalBinding;
  readonly effectBinding: Readonly<ProductionMemoryEffectBindingV1>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly options: AgentToolRegistryOptions;
}>) {
  const timers = Object.freeze({
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setTimeout: (listener: () => void, delayMs: number) => setTimeout(listener, delayMs),
  });
  const isProcessAlive = (processIdentity: number): boolean => {
    try {
      process.kill(processIdentity, 0);
      return true;
    } catch {
      return false;
    }
  };
  const executionPreparer = await ExecutionPreparer.create({
    hostEnvironment: input.environment,
    platform: process.platform,
    registry: createDefaultExecutableRegistry({
      execPath: process.execPath,
      hostEnvironment: input.environment,
      platform: process.platform,
    }),
    workspace: input.options.workspace,
  });
  const executor = new LocalExecutor({
    clock: { now: () => performance.now() },
    platform: process.platform,
    processTreeCleanup: new NodeProcessTreeCleanup({
      isProcessAlive,
      killProcess: (processIdentity, signal) => process.kill(processIdentity, signal),
      platform: process.platform,
      ...(process.platform === "win32"
        ? { taskkill: createTaskkillArgvRunner(spawn, input.environment) }
        : {}),
      timers,
    }),
    redact: (value) => redactSensitiveText(value, input.options.secrets ?? []),
    spawn: createNodeSpawnAdapter(spawn),
    timers,
  });
  const permissionContext = (prepared: PreparedExecution): PermissionContext =>
    isExactEffectCommandAction(
      prepared.actionIdentity,
      input.approvalBinding,
      input.effectBinding,
    )
      ? Object.freeze({
          reviewedLocalActionSha256: Object.freeze([prepared.actionIdentity.actionSha256]),
        })
      : Object.freeze({});
  const verificationClassifier = async (
    prepared: PreparedExecution,
  ): Promise<PreparedVerificationClassification | null> =>
    isExactEffectCommandAction(
      prepared.actionIdentity,
      input.approvalBinding,
      input.effectBinding,
    )
      ? Object.freeze({
          inputPaths: Object.freeze([
            MEM_E0_PUBLIC_VERIFIER,
            input.effectBinding.targetRelativePath,
          ].sort()),
          kind: "test" as const,
        })
      : null;
  return createProductionAgentToolRegistry({
    ...input.options,
    executionPreparer,
    executor,
    permissionContext,
    permissionEngine: new PermissionEngine(memE0PermissionPolicy(
      input.approvalBinding,
      input.effectBinding,
    )),
    verificationClassifier,
  });
}

function decisionCounts(
  observations: readonly MemoryEffectBackendObservationV1[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const observation of observations) {
    counts[observation.decision] = (counts[observation.decision] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )));
}

export async function runProductionMemoryEffectActor(
  rawInput: ProductionMemoryEffectActorInputV1,
): Promise<ProductionMemoryEffectActorObservationV1> {
  const input = parseProductionMemoryEffectActorInput(rawInput);
  const environment = isolatedEnvironment(input.stateRoot);
  const effectBinding = input.phase === "effect"
    ? await validateMemE0ActualEffectBinding(input)
    : null;
  const binding = new MemoryEffectApprovalBinding();
  const approvals = new MemoryEffectExactApprovalPrompt(binding);
  const stdout = new HashOnlyWriter();
  const stderr = new HashOnlyWriter();
  const io: CliIO = Object.freeze({ stdout, stderr });
  const backendObservations: MemoryEffectBackendObservationV1[] = [];
  let backendCreatedCount = 0;
  let toolCatalogSha256: string | null = null;
  let toolRegistryCreatedCount = 0;
  const base = createNodeRuntime({
    approvalInput: noninteractiveApprovalInput,
    approvalPromptOverride: approvals,
    capabilityUserStateRoot: join(input.stateRoot, "lab-host", "capabilities"),
    cwd: input.workspace,
    delegationUserStateRoot: join(input.stateRoot, "lab-host", "delegation"),
    env: environment,
    execPath: process.execPath,
    killProcess: (processIdentity, signal) => process.kill(processIdentity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0-fal-mem-e0",
    workerUserStateRoot: join(input.stateRoot, "lab-host", "workers"),
    worktreeUserStateRoot: join(input.stateRoot, "lab-host", "worktrees"),
  });
  const runtime: CliRuntime = {
    ...base,
    agentModelEvidence: (provider) => provider === MEM_E0_PROVIDER
      ? Object.freeze({
          backend: "fake" as const,
          endpointScope: "in_process" as const,
          kind: "contract_verified" as const,
          remoteBillableRequests: 0 as const,
        })
      : null,
    createAgentToolRegistry: async (options) => {
      const productionRegistry = effectBinding === null
        ? await base.createAgentToolRegistry(options)
        : await createMemE0EffectToolRegistry({
            approvalBinding: binding,
            effectBinding,
            environment,
            options,
          });
      const registry = new RestrictedToolRegistry(
        productionRegistry,
        input.phase === "seed" ? [] : ["apply_patch", "finish_task", "read_file", "run_command"],
      );
      toolRegistryCreatedCount += 1;
      toolCatalogSha256 = sha256Canonical(registry.modelDefinitions);
      return registry;
    },
    createModelBackend: (request) => {
      if (request.provider !== MEM_E0_PROVIDER || request.model !== MEM_E0_MODEL) {
        throw new TypeError("MEM-E0 model selection changed before backend creation");
      }
      backendCreatedCount += 1;
      if (backendCreatedCount !== 1) {
        throw new TypeError("MEM-E0 actor requires one backend instance per child process");
      }
      return new DeterministicMemoryEffectBackend({
        approvalBinding: binding,
        model: MEM_E0_MODEL,
        observe: (observation) => backendObservations.push(observation),
        phase: input.phase,
        provider: MEM_E0_PROVIDER,
      });
    },
  };

  let agentExitCode: AgentExitCode = 1;
  let explicitMemoryLogicalSha256: string | null = null;
  let explicitMemoryRecordIdSha256: string | null = null;
  let explicitMemoryRecordSha256: string | null = null;
  let explicitRememberExitCode: AgentExitCode | null = null;
  let explicitRememberStatus: ProductionMemoryEffectActorObservationV1["explicitRememberStatus"] = "not_run";
  let orchestrationFailure = false;
  try {
    agentExitCode = await executeAgentThroughApplicationService(
      commandOptions(input),
      runtime,
      io,
    );
    if (input.phase === "seed" && agentExitCode === 0) {
      const rememberCapture = new BoundedCaptureWriter(32_768);
      const rememberIo: CliIO = Object.freeze({
        stderr,
        stdout: Object.freeze({
          write: (value: string) => {
            stdout.write(value);
            rememberCapture.write(value);
          },
        }),
      });
      explicitRememberExitCode = asAgentExitCode(await runCli([
        "memory",
        "remember",
        input.memoryKind,
        input.task,
        "--json",
      ], rememberIo, runtime));
      if (explicitRememberExitCode === 0) {
        const record = parseRememberedRecord(rememberCapture.value(), input);
        explicitMemoryLogicalSha256 = sha256Canonical({
          disclosureClass: "public_synthetic",
          kind: record.kind,
          text: record.text,
        });
        explicitMemoryRecordIdSha256 = sha256Text(record.recordId);
        explicitMemoryRecordSha256 = record.recordSha256;
        explicitRememberStatus = "added";
      } else {
        explicitRememberStatus = "failed";
      }
    }
  } catch {
    orchestrationFailure = true;
    if (input.phase === "seed") explicitRememberStatus = "failed";
  } finally {
    try {
      await disposeApplicationHostForStateRoot(input.stateRoot);
    } catch {
      orchestrationFailure = true;
    }
  }
  const stdoutDigest = stdout.digest();
  const stderrDigest = stderr.digest();
  const approvalObservationSha256s = approvals.observations().map((observation) =>
    sha256Canonical(observation)
  );
  return Object.freeze({
    agentExitCode,
    approvalObservationSha256s: Object.freeze(approvalObservationSha256s),
    backendCreatedCount,
    backendObservationSha256: sha256Canonical(backendObservations),
    canonicalContextSha256s: uniqueSorted(
      backendObservations.map((observation) => observation.canonicalContextSha256),
    ),
    childPid: process.pid,
    decisionCounts: decisionCounts(backendObservations),
    explicitMemoryLogicalSha256,
    explicitMemoryRecordIdSha256,
    explicitMemoryRecordSha256,
    explicitRememberExitCode,
    explicitRememberStatus,
    historicalItemCounts: uniqueSortedNumbers(
      backendObservations.map((observation) => observation.historicalItemCount),
    ),
    memoryMode: input.memoryMode,
    memoryRecordIdSha256s: uniqueSorted(
      backendObservations.map((observation) => observation.memoryRecordIdSha256),
    ),
    memoryValueSha256s: uniqueSorted(
      backendObservations.map((observation) => observation.memoryValueSha256),
    ),
    orchestrationFailure,
    phase: input.phase,
    productEntrySha256: sha256Text("executeAgentThroughApplicationService"),
    providerNetworkRequests: 0,
    providerSelectionSha256: sha256Canonical({ model: MEM_E0_MODEL, provider: MEM_E0_PROVIDER }),
    providerSourcePropagation: "requested_but_application_payload_not_observed",
    providerSourceRequestedSha256: sha256Text(MEM_E0_PROVIDER_SOURCE),
    schemaVersion: 1,
    stateRootIdentitySha256: sha256Text(input.stateRoot),
    stderrBytes: stderrDigest.bytes,
    stderrSha256: stderrDigest.sha256,
    stdoutBytes: stdoutDigest.bytes,
    stdoutSha256: stdoutDigest.sha256,
    taskSha256: sha256Text(input.task),
    toolCatalogSha256,
    toolArgumentSha256s: uniqueSorted(
      backendObservations.map((observation) => observation.toolArgumentsSha256),
    ),
    toolNames: Object.freeze(backendObservations.flatMap((observation) =>
      observation.toolName === null ? [] : [observation.toolName]
    )),
    toolRegistryCreatedCount,
    workspaceIdentitySha256: sha256Text(input.workspace),
  });
}
