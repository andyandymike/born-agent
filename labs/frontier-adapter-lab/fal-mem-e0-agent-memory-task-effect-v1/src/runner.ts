import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { observeMemE0ArmContract } from "./arm-contract.js";
import {
  loadMemE0Fixture,
  type MemE0LoadedCase,
} from "./fixture.js";
import type {
  ProductionMemoryEffectActorInputV1,
  ProductionMemoryEffectActorObservationV1,
} from "./production-memory-effect-actor.js";
import {
  createMemE0MechanicsReceipt,
  type MemE0MechanicsArmEvidenceInput,
  type MemE0MechanicsPairInput,
  type MemE0MechanicsReceipt,
} from "./receipt.js";
import { createMemE0SanitizedBoundaryError } from "./sanitized-failure.js";
import {
  createMemE0Workspace,
  observeMemE0WorkspaceAfter,
  runMemE0HiddenVerifier,
  runMemE0PublicVerifier,
  type MemE0WorkspaceBefore,
} from "./workspace.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const PRODUCT_ENTRY_SHA256 = rawSha256("executeAgentThroughApplicationService");
const TOOL_NAMES = new Set(["apply_patch", "finish_task", "read_file", "run_command"]);
const OBSERVATION_KEYS = Object.freeze([
  "agentExitCode",
  "approvalObservationSha256s",
  "backendCreatedCount",
  "backendObservationSha256",
  "canonicalContextSha256s",
  "childPid",
  "decisionCounts",
  "explicitMemoryLogicalSha256",
  "explicitMemoryRecordIdSha256",
  "explicitMemoryRecordSha256",
  "explicitRememberExitCode",
  "explicitRememberStatus",
  "historicalItemCounts",
  "memoryMode",
  "memoryRecordIdSha256s",
  "memoryValueSha256s",
  "orchestrationFailure",
  "phase",
  "productEntrySha256",
  "providerNetworkRequests",
  "providerSelectionSha256",
  "providerSourcePropagation",
  "providerSourceRequestedSha256",
  "schemaVersion",
  "stateRootIdentitySha256",
  "stderrBytes",
  "stderrSha256",
  "stdoutBytes",
  "stdoutSha256",
  "taskSha256",
  "toolArgumentSha256s",
  "toolCatalogSha256",
  "toolNames",
  "toolRegistryCreatedCount",
  "workspaceIdentitySha256",
] as const);
const IMPLEMENTATION_RELATIVE_PATHS = Object.freeze([
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/arm-contract.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/deterministic-memory-effect-backend.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/fixture.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/production-memory-effect-actor.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/receipt.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/runner.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/sanitized-failure.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/workspace.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-child.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-mechanics.ts",
] as const);

type ArmName = "off" | "on";

interface ChildRun {
  readonly observation: ProductionMemoryEffectActorObservationV1;
  readonly observationSha256: string;
}

interface ArmRun {
  readonly before: MemE0WorkspaceBefore;
  readonly effectChildPid: number;
  readonly receipt: MemE0MechanicsArmEvidenceInput;
  readonly seedChildPid: number;
  readonly seedObservationSha256: string;
  readonly effectObservationSha256: string;
}

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExitCode(value: unknown): boolean {
  return typeof value === "number" && [0, 1, 2, 3, 4, 5, 6, 7, 8, 130].includes(value);
}

function isNullableSha256(value: unknown): boolean {
  return value === null || (typeof value === "string" && SHA256.test(value));
}

function isSha256List(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && SHA256.test(entry));
}

function parseChildObservation(value: unknown): ProductionMemoryEffectActorObservationV1 {
  if (!isRecord(value) || sha256Canonical(Object.keys(value).sort()) !== sha256Canonical(OBSERVATION_KEYS)) {
    throw new TypeError("MEM-E0 child observation has unknown or missing fields");
  }
  const nonnegativeIntegers = [
    value.backendCreatedCount,
    value.stderrBytes,
    value.stdoutBytes,
    value.toolRegistryCreatedCount,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
  const hashes = [
    value.backendObservationSha256,
    value.productEntrySha256,
    value.providerSelectionSha256,
    value.providerSourceRequestedSha256,
    value.stateRootIdentitySha256,
    value.stderrSha256,
    value.stdoutSha256,
    value.taskSha256,
    value.workspaceIdentitySha256,
  ].every((entry) => typeof entry === "string" && SHA256.test(entry));
  const decisionCountsValid = isRecord(value.decisionCounts) &&
    Object.entries(value.decisionCounts).every(([key, count]) =>
      /^[a-z][a-z0-9_]{0,95}$/u.test(key) && Number.isSafeInteger(count) && Number(count) >= 0
    );
  const historicalCountsValid = Array.isArray(value.historicalItemCounts) &&
    value.historicalItemCounts.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= 8);
  const toolNamesValid = Array.isArray(value.toolNames) &&
    value.toolNames.every((entry) => typeof entry === "string" && TOOL_NAMES.has(entry));
  if (
    value.schemaVersion !== 1 ||
    !isExitCode(value.agentExitCode) ||
    !(value.explicitRememberExitCode === null || isExitCode(value.explicitRememberExitCode)) ||
    !["added", "failed", "not_run"].includes(String(value.explicitRememberStatus)) ||
    !["effect", "seed"].includes(String(value.phase)) ||
    !["local", "off"].includes(String(value.memoryMode)) ||
    value.providerNetworkRequests !== 0 ||
    value.providerSourcePropagation !== "requested_but_application_payload_not_observed" ||
    typeof value.childPid !== "number" || !Number.isSafeInteger(value.childPid) || value.childPid <= 0 ||
    typeof value.orchestrationFailure !== "boolean" ||
    !nonnegativeIntegers || !hashes || !decisionCountsValid || !historicalCountsValid || !toolNamesValid ||
    !isSha256List(value.approvalObservationSha256s) ||
    !isSha256List(value.canonicalContextSha256s) ||
    !isSha256List(value.memoryRecordIdSha256s) ||
    !isSha256List(value.memoryValueSha256s) ||
    !isSha256List(value.toolArgumentSha256s) ||
    !isNullableSha256(value.explicitMemoryLogicalSha256) ||
    !isNullableSha256(value.explicitMemoryRecordIdSha256) ||
    !isNullableSha256(value.explicitMemoryRecordSha256) ||
    !isNullableSha256(value.toolCatalogSha256)
  ) {
    throw new TypeError("MEM-E0 child observation failed its hash-only contract");
  }
  return Object.freeze(value as unknown as ProductionMemoryEffectActorObservationV1);
}

function workerEnvironment(): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = { NO_COLOR: "1" };
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

async function runChild(input: ProductionMemoryEffectActorInputV1, root: string): Promise<ChildRun> {
  const inputPath = join(root, `${input.phase}-input.json`);
  await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", flag: "wx" });
  const childEntry = resolve(
    "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-child.ts",
  );
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(process.execPath, [
      "--no-warnings",
      "--import",
      import.meta.resolve("tsx"),
      childEntry,
      inputPath,
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      env: workerEnvironment(),
      maxBuffer: 128 * 1_024,
      timeout: 180_000,
      windowsHide: true,
    });
  } catch (error) {
    throw createMemE0SanitizedBoundaryError("child_process_failed", error);
  }
  const childStdout = typeof result.stdout === "string"
    ? result.stdout
    : result.stdout.toString("utf8");
  const childStderr = typeof result.stderr === "string"
    ? result.stderr
    : result.stderr.toString("utf8");
  if (childStderr.length !== 0) {
    throw createMemE0SanitizedBoundaryError(
      "child_stderr_rejected",
      Object.assign(new Error("MEM-E0 child stderr rejected"), {
        stderr: childStderr,
        stdout: "",
      }),
    );
  }
  const lines = childStdout.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error("MEM-E0 child did not emit exactly one observation");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(lines[0]);
  } catch (error) {
    throw createMemE0SanitizedBoundaryError("child_observation_parse_failed", error);
  }
  const observation = parseChildObservation(decoded);
  if (
    observation.phase !== input.phase ||
    observation.memoryMode !== input.memoryMode ||
    observation.taskSha256 !== rawSha256(input.task) ||
    observation.stateRootIdentitySha256 !== rawSha256(input.stateRoot) ||
    observation.workspaceIdentitySha256 !== rawSha256(input.workspace) ||
    observation.productEntrySha256 !== PRODUCT_ENTRY_SHA256
  ) {
    throw new Error("MEM-E0 child observation is not bound to its exact launch input");
  }
  return Object.freeze({ observation, observationSha256: sha256Canonical(observation) });
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function oneHistoricalCount(observation: ProductionMemoryEffectActorObservationV1): 0 | 1 {
  if (
    observation.historicalItemCounts.length !== 1 ||
    (observation.historicalItemCounts[0] !== 0 && observation.historicalItemCounts[0] !== 1)
  ) {
    throw new Error("MEM-E0 effect child did not expose one bounded historical count");
  }
  return observation.historicalItemCounts[0];
}

function publicVerifierSha256(loadedCase: MemE0LoadedCase): string {
  const verifier = loadedCase.publicFiles.find(
    (file) => file.path === loadedCase.definition.publicWorkspace.publicVerifierRelativePath,
  );
  if (verifier === undefined) throw new Error("MEM-E0 public verifier is absent");
  return verifier.rawSha256;
}

async function runArm(
  loadedCase: MemE0LoadedCase,
  arm: ArmName,
  armRoot: string,
): Promise<ArmRun> {
  await mkdir(armRoot, { recursive: true });
  const workspace = join(armRoot, "workspace");
  const stateRoot = join(armRoot, "state");
  const before = await createMemE0Workspace({ loadedCase, workspace });
  const seed = await runChild({
    effectBinding: null,
    memoryKind: loadedCase.definition.memory.kind,
    memoryMode: "local",
    phase: "seed",
    schemaVersion: 1,
    stateRoot,
    task: loadedCase.definition.memory.recordText,
    workspace,
  }, armRoot);
  const afterSeed = await observeMemE0WorkspaceAfter(loadedCase, before);
  if (
    afterSeed.changedPaths.length !== 0 ||
    afterSeed.finalTargetRawSha256 !== before.initialTargetRawSha256
  ) {
    throw new Error("MEM-E0 explicit-memory seed child changed the public workspace");
  }
  const effect = await runChild({
    effectBinding: {
      publicVerifierRawSha256: publicVerifierSha256(loadedCase),
      targetRelativePath: loadedCase.definition.publicWorkspace.targetRelativePath,
    },
    memoryKind: null,
    memoryMode: arm === "on" ? "local" : "off",
    phase: "effect",
    schemaVersion: 1,
    stateRoot,
    task: loadedCase.definition.task.text,
    workspace,
  }, armRoot);
  const [after, publicVerifier, hiddenVerifier] = await Promise.all([
    observeMemE0WorkspaceAfter(loadedCase, before),
    runMemE0PublicVerifier(loadedCase, workspace),
    runMemE0HiddenVerifier(loadedCase, workspace),
  ]);
  const changedPathsExact = sha256Canonical(after.changedPaths) ===
    sha256Canonical(loadedCase.definition.publicWorkspace.allowedChangedPaths);
  const freshVerifierPassed =
    changedPathsExact && publicVerifier.passed && hiddenVerifier.passed;
  const historicalItemCount = oneHistoricalCount(effect.observation);
  if (
    seed.observation.agentExitCode !== 0 ||
    seed.observation.explicitRememberExitCode !== 0 ||
    seed.observation.explicitRememberStatus !== "added" ||
    seed.observation.explicitMemoryLogicalSha256 !== loadedCase.definition.memory.recordLogicalSha256 ||
    seed.observation.explicitMemoryRecordIdSha256 === null ||
    seed.observation.explicitMemoryRecordSha256 === null
  ) {
    throw new Error("MEM-E0 seed child did not admit the exact explicit product memory");
  }
  const admittedRecordIdSha256 = seed.observation.explicitMemoryRecordIdSha256;
  const selectedRecordBound = historicalItemCount === 0
    ? effect.observation.memoryRecordIdSha256s.length === 0 &&
      effect.observation.memoryValueSha256s.length === 0
    : effect.observation.memoryRecordIdSha256s.length === 1 &&
      effect.observation.memoryRecordIdSha256s[0] === admittedRecordIdSha256 &&
      effect.observation.memoryValueSha256s.length === 1;
  const expectsSuccessfulEffect =
    arm === "on" || loadedCase.definition.caseClass === "harm_control";
  const armContractObserved = observeMemE0ArmContract({
    changedPathsExact,
    expectsSuccessfulEffect,
    hiddenVerifierPassed: hiddenVerifier.passed,
    observation: effect.observation,
    publicVerifierPassed: publicVerifier.passed,
    workspaceUnchanged:
      after.changedPaths.length === 0 &&
      after.finalTargetRawSha256 === before.initialTargetRawSha256,
  });
  const productPathObserved =
    !seed.observation.orchestrationFailure &&
    !effect.observation.orchestrationFailure &&
    seed.observation.backendCreatedCount === 1 &&
    effect.observation.backendCreatedCount === 1 &&
    seed.observation.toolRegistryCreatedCount === 1 &&
    effect.observation.toolRegistryCreatedCount === 1 &&
    seed.observation.providerNetworkRequests === 0 &&
    effect.observation.providerNetworkRequests === 0 &&
    selectedRecordBound &&
    afterSeed.changedPaths.length === 0;
  const observationSha256s = sortedUnique([
    seed.observationSha256,
    effect.observationSha256,
    sha256Canonical(afterSeed),
    sha256Canonical(after),
    sha256Canonical(publicVerifier),
    sha256Canonical(hiddenVerifier),
  ]);
  return Object.freeze({
    before,
    effectChildPid: effect.observation.childPid,
    effectObservationSha256: effect.observationSha256,
    receipt: Object.freeze({
      admittedRecordIdSha256,
      admittedRecordLogicalSha256: seed.observation.explicitMemoryLogicalSha256,
      armContractObserved,
      freshVerifierPassed,
      historicalItemCount,
      observationSha256s,
      productPathObserved,
      selectedMemoryValueSha256s: sortedUnique(effect.observation.memoryValueSha256s),
      selectedRecordIdSha256s: sortedUnique(effect.observation.memoryRecordIdSha256s),
      toolArgumentSha256s: sortedUnique(effect.observation.toolArgumentSha256s),
      toolNames: sortedUnique(effect.observation.toolNames) as MemE0MechanicsArmEvidenceInput["toolNames"],
    }),
    seedChildPid: seed.observation.childPid,
    seedObservationSha256: seed.observationSha256,
  });
}

async function runPair(
  loadedCase: MemE0LoadedCase,
  caseRoot: string,
  onFirst: boolean,
): Promise<MemE0MechanicsPairInput> {
  const arms = new Map<ArmName, ArmRun>();
  for (const arm of onFirst ? ["on", "off"] as const : ["off", "on"] as const) {
    arms.set(arm, await runArm(loadedCase, arm, join(caseRoot, arm)));
  }
  const off = arms.get("off")!;
  const on = arms.get("on")!;
  if (
    off.before.publicManifestSha256 !== on.before.publicManifestSha256 ||
    off.before.initialTargetRawSha256 !== on.before.initialTargetRawSha256 ||
    off.before.baselineCommit !== on.before.baselineCommit
  ) {
    throw new Error("MEM-E0 paired arms did not start from identical public workspaces");
  }
  const distinctOsProcesses = new Set([
    off.seedChildPid,
    off.effectChildPid,
    on.seedChildPid,
    on.effectChildPid,
  ]).size === 4;
  const processBoundaryObservationSha256 = sha256Canonical({
    caseId: loadedCase.definition.caseId,
    off: {
      effectObservationSha256: off.effectObservationSha256,
      seedExitedBeforeEffect: true,
      seedObservationSha256: off.seedObservationSha256,
    },
    on: {
      effectObservationSha256: on.effectObservationSha256,
      seedExitedBeforeEffect: true,
      seedObservationSha256: on.seedObservationSha256,
    },
    schemaVersion: 1,
  });
  return Object.freeze({
    caseClass: loadedCase.definition.caseClass,
    caseId: loadedCase.definition.caseId,
    distinctOsProcesses,
    off: off.receipt,
    on: on.receipt,
    processBoundaryObservationSha256,
  });
}

async function implementationSha256s(repositoryRoot: string): Promise<readonly string[]> {
  const hashes = await Promise.all(IMPLEMENTATION_RELATIVE_PATHS.map(async (relativePath) =>
    rawSha256(await readFile(join(repositoryRoot, ...relativePath.split("/"))))
  ));
  return sortedUnique(hashes);
}

async function runMemE0OfflineMechanicsUnsafe(
  repositoryRoot: string,
): Promise<MemE0MechanicsReceipt> {
  if (!isAbsolute(repositoryRoot)) throw new TypeError("MEM-E0 repository root must be absolute");
  const resolvedRoot = resolve(repositoryRoot);
  const fixture = await loadMemE0Fixture(resolvedRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-fal-mem-e0-"));
  try {
    const pairs: MemE0MechanicsPairInput[] = [];
    for (const [index, loadedCase] of fixture.cases.entries()) {
      pairs.push(await runPair(
        loadedCase,
        join(temporaryRoot, loadedCase.definition.caseId),
        index % 2 === 1,
      ));
    }
    return createMemE0MechanicsReceipt({
      implementationSha256s: await implementationSha256s(resolvedRoot),
      pairs,
      protocolSha256: fixture.protocol.protocolSha256,
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function runMemE0OfflineMechanics(
  repositoryRoot: string,
): Promise<MemE0MechanicsReceipt> {
  try {
    return await runMemE0OfflineMechanicsUnsafe(repositoryRoot);
  } catch (error) {
    throw createMemE0SanitizedBoundaryError("offline_mechanics_failed", error);
  }
}
