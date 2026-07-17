import { createHash } from "node:crypto";
import path from "node:path";

import type {
  BinaryFingerprint,
  CommandActionIdentity,
  DockerCommandEnvironmentIdentity,
  EnvironmentPolicyIdentity,
  ExecutionInputFingerprints,
  LifecycleScriptFingerprints,
  NormalizedCommandAction,
  PackageManagerIdentity,
  RunnerConfigFingerprint,
  Sha256Hex,
} from "./permission-types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/u;

type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function sha256Utf8(value: string): Sha256Hex {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalizeWorkspaceRelativePath(value: string): string {
  assertPlainString(value, "workspace-relative path");
  const withForwardSlashes = value.replaceAll("\\", "/");

  if (
    withForwardSlashes.startsWith("/") ||
    withForwardSlashes.startsWith("//") ||
    WINDOWS_DRIVE_PATTERN.test(withForwardSlashes) ||
    path.win32.isAbsolute(value)
  ) {
    throw new TypeError("workspace-relative path must not be absolute");
  }

  const normalized = path.posix.normalize(withForwardSlashes || ".");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError("workspace-relative path must not escape the workspace");
  }

  return normalized === "" ? "." : normalized;
}

export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const objectValue = value as Readonly<Record<string, CanonicalJsonValue>>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`)
    .join(",")}}`;
}

export function computeExecutionInputsSha256(
  action: NormalizedCommandAction,
): Sha256Hex {
  return sha256Utf8(
    canonicalJson({
      binary: binaryForDigest(action.binary),
      executionInputs: executionInputsForDigest(action.executionInputs),
      lifecycleScripts: lifecycleForDigest(action.lifecycleScripts),
      packageManager: packageManagerForDigest(action.packageManager),
    }),
  );
}

export function computeActionSha256(
  action: NormalizedCommandAction,
): Sha256Hex {
  const executionInputsSha256 = computeExecutionInputsSha256(action);

  // PHASE6: Human-readable command text is intentionally absent. Authorization binds
  // exact structured inputs and executable fingerprints, never a lossy display string.
  return sha256Utf8(
    canonicalJson({
      actionKind: action.actionKind,
      argv: [...action.argv],
      canonicalCwd: action.canonicalCwd,
      environmentPolicy: environmentPolicyForDigest(action.environmentPolicy),
      ...(action.executionEnvironment === undefined
        ? {}
        : {
            executionEnvironment: dockerEnvironmentForDigest(
              action.executionEnvironment,
            ),
          }),
      executionInputsSha256,
      logicalExecutable: action.logicalExecutable,
      outputLimitBytes: action.outputLimitBytes,
      purpose: action.purpose,
      timeoutMs: action.timeoutMs,
    }),
  );
}

export function createCommandActionIdentity(
  input: NormalizedCommandAction,
): CommandActionIdentity {
  if (input.actionKind !== "command") {
    throw new TypeError("actionKind must be command");
  }

  const logicalExecutable = normalizeLogicalExecutable(input.logicalExecutable);
  const argv = Object.freeze(
    input.argv.map((argument, index) => {
      assertArgument(argument, index);
      return argument;
    }),
  );
  const canonicalCwd = canonicalizeWorkspaceRelativePath(input.canonicalCwd);
  const environmentPolicy = normalizeEnvironmentPolicy(input.environmentPolicy);
  const binary = normalizeBinary(input.binary, "binary");
  const packageManager = normalizePackageManager(input.packageManager);
  const lifecycleScripts = normalizeLifecycle(input.lifecycleScripts);
  const executionInputs = normalizeExecutionInputs(input.executionInputs);
  const executionEnvironment =
    input.executionEnvironment === undefined
      ? undefined
      : normalizeDockerEnvironment(input.executionEnvironment);

  if (lifecycleScripts !== null && packageManager === null) {
    throw new TypeError(
      "lifecycle script fingerprints require a package manager identity",
    );
  }

  const normalized: NormalizedCommandAction = Object.freeze({
    actionKind: "command",
    argv,
    binary,
    canonicalCwd,
    environmentPolicy,
    ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
    executionInputs,
    lifecycleScripts,
    logicalExecutable,
    outputLimitBytes: assertPositiveInteger(
      input.outputLimitBytes,
      "outputLimitBytes",
    ),
    packageManager,
    purpose: input.purpose,
    timeoutMs: assertPositiveInteger(input.timeoutMs, "timeoutMs"),
  });

  if (normalized.purpose !== "inspect" && normalized.purpose !== "verify") {
    throw new TypeError("purpose must be inspect or verify");
  }

  const executionInputsSha256 = computeExecutionInputsSha256(normalized);
  const actionSha256 = computeActionSha256(normalized);

  return Object.freeze({
    ...normalized,
    actionSha256,
    executionInputsSha256,
  });
}

function normalizeDockerEnvironment(
  value: DockerCommandEnvironmentIdentity,
): DockerCommandEnvironmentIdentity {
  if (value.executor !== "docker" || value.network !== "none") {
    throw new TypeError("Docker command environment must use executor=docker and network=none");
  }
  assertSha256(value.imageDigest.replace(/^sha256:/u, ""), "executionEnvironment.imageDigest");
  if (value.imageDigest !== `sha256:${value.imageDigest.slice("sha256:".length)}`) {
    throw new TypeError("executionEnvironment.imageDigest must use sha256:<hex>");
  }
  assertNonEmpty(value.imageReference, "executionEnvironment.imageReference");
  if (!value.imageReference.endsWith(`@${value.imageDigest}`)) {
    throw new TypeError("executionEnvironment image reference must match its digest");
  }
  assertNonEmpty(value.policyVersion, "executionEnvironment.policyVersion");
  assertSha256(value.snapshotSha256, "executionEnvironment.snapshotSha256");
  assertSha256(value.sourceStateSha256, "executionEnvironment.sourceStateSha256");
  assertSha256(value.wrapperSha256, "executionEnvironment.wrapperSha256");
  const limits = value.resourceLimits;
  if (
    !Number.isFinite(limits.cpus) ||
    limits.cpus < 0.25 ||
    limits.cpus > 8 ||
    !Number.isSafeInteger(limits.memoryMiB) ||
    !Number.isSafeInteger(limits.pids) ||
    !Number.isSafeInteger(limits.tmpMiB)
  ) {
    throw new TypeError("executionEnvironment resource limits are invalid");
  }
  return Object.freeze({
    executor: "docker",
    imageDigest: value.imageDigest,
    imageReference: value.imageReference,
    network: "none",
    policyVersion: value.policyVersion,
    resourceLimits: Object.freeze({ ...limits }),
    snapshotSha256: value.snapshotSha256,
    sourceStateSha256: value.sourceStateSha256,
    wrapperSha256: value.wrapperSha256,
  });
}

function normalizeLogicalExecutable(value: string): string {
  assertPlainString(value, "logicalExecutable");
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new TypeError("logicalExecutable must not be empty");
  }
  return normalized;
}

function normalizeEnvironmentPolicy(
  value: EnvironmentPolicyIdentity,
): EnvironmentPolicyIdentity {
  assertNonEmpty(value.id, "environmentPolicy.id");
  assertNonEmpty(value.version, "environmentPolicy.version");
  const names = value.variableNames.map((name) => {
    assertNonEmpty(name, "environmentPolicy.variableNames entry");
    return name;
  });
  const uniqueNames = [...new Set(names)].sort();

  return Object.freeze({
    id: value.id,
    variableNames: Object.freeze(uniqueNames),
    version: value.version,
  });
}

function normalizeBinary(
  value: BinaryFingerprint,
  label: string,
): BinaryFingerprint {
  assertNonEmpty(value.canonicalIdentity, `${label}.canonicalIdentity`);
  assertSha256(value.bytesSha256, `${label}.bytesSha256`);
  assertNonEmpty(value.version, `${label}.version`);
  return Object.freeze({
    bytesSha256: value.bytesSha256,
    canonicalIdentity: value.canonicalIdentity,
    version: value.version,
  });
}

function normalizePackageManager(
  value: PackageManagerIdentity | null,
): PackageManagerIdentity | null {
  if (value === null) {
    return null;
  }
  if (value.logicalName !== "npm" && value.logicalName !== "pnpm") {
    throw new TypeError("packageManager.logicalName must be npm or pnpm");
  }
  assertNonEmpty(value.version, "packageManager.version");
  return Object.freeze({
    binary: normalizeBinary(value.binary, "packageManager.binary"),
    logicalName: value.logicalName,
    version: value.version,
  });
}

function normalizeLifecycle(
  value: LifecycleScriptFingerprints | null,
): LifecycleScriptFingerprints | null {
  if (value === null) {
    return null;
  }
  assertNonEmpty(value.scriptName, "lifecycleScripts.scriptName");
  assertSha256(value.mainBodySha256, "lifecycleScripts.mainBodySha256");
  assertNullableSha256(value.preBodySha256, "lifecycleScripts.preBodySha256");
  assertNullableSha256(value.postBodySha256, "lifecycleScripts.postBodySha256");
  return Object.freeze({
    mainBodySha256: value.mainBodySha256,
    postBodySha256: value.postBodySha256,
    preBodySha256: value.preBodySha256,
    scriptName: value.scriptName,
  });
}

function normalizeExecutionInputs(
  value: ExecutionInputFingerprints,
): ExecutionInputFingerprints {
  assertNullableSha256(value.manifestSha256, "executionInputs.manifestSha256");
  assertNullableSha256(value.lockfileSha256, "executionInputs.lockfileSha256");
  const runnerConfigHashes = value.runnerConfigHashes
    .map((entry): RunnerConfigFingerprint => {
      assertSha256(entry.sha256, "runnerConfigHashes.sha256");
      return Object.freeze({
        canonicalPath: canonicalizeWorkspaceRelativePath(entry.canonicalPath),
        sha256: entry.sha256,
      });
    })
    .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));

  for (let index = 1; index < runnerConfigHashes.length; index += 1) {
    if (
      runnerConfigHashes[index - 1]?.canonicalPath ===
      runnerConfigHashes[index]?.canonicalPath
    ) {
      throw new TypeError("runner config paths must be unique");
    }
  }

  return Object.freeze({
    lockfileSha256: value.lockfileSha256,
    manifestSha256: value.manifestSha256,
    runnerConfigHashes: Object.freeze(runnerConfigHashes),
  });
}

function binaryForDigest(value: BinaryFingerprint): CanonicalJsonValue {
  return {
    bytesSha256: value.bytesSha256,
    canonicalIdentity: value.canonicalIdentity,
    version: value.version,
  };
}

function environmentPolicyForDigest(
  value: EnvironmentPolicyIdentity,
): CanonicalJsonValue {
  return {
    id: value.id,
    variableNames: [...value.variableNames],
    version: value.version,
  };
}

function dockerEnvironmentForDigest(
  value: DockerCommandEnvironmentIdentity,
): CanonicalJsonValue {
  return {
    executor: value.executor,
    imageDigest: value.imageDigest,
    imageReference: value.imageReference,
    network: value.network,
    policyVersion: value.policyVersion,
    resourceLimits: {
      cpus: value.resourceLimits.cpus,
      memoryMiB: value.resourceLimits.memoryMiB,
      pids: value.resourceLimits.pids,
      tmpMiB: value.resourceLimits.tmpMiB,
    },
    snapshotSha256: value.snapshotSha256,
    sourceStateSha256: value.sourceStateSha256,
    wrapperSha256: value.wrapperSha256,
  };
}

function packageManagerForDigest(
  value: PackageManagerIdentity | null,
): CanonicalJsonValue {
  if (value === null) {
    return null;
  }
  return {
    binary: binaryForDigest(value.binary),
    logicalName: value.logicalName,
    version: value.version,
  };
}

function lifecycleForDigest(
  value: LifecycleScriptFingerprints | null,
): CanonicalJsonValue {
  if (value === null) {
    return null;
  }
  return {
    mainBodySha256: value.mainBodySha256,
    postBodySha256: value.postBodySha256,
    preBodySha256: value.preBodySha256,
    scriptName: value.scriptName,
  };
}

function executionInputsForDigest(
  value: ExecutionInputFingerprints,
): CanonicalJsonValue {
  return {
    lockfileSha256: value.lockfileSha256,
    manifestSha256: value.manifestSha256,
    runnerConfigHashes: value.runnerConfigHashes.map((entry) => ({
      canonicalPath: entry.canonicalPath,
      sha256: entry.sha256,
    })),
  };
}

function assertArgument(value: string, index: number): void {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`argv[${index}] must be a NUL-free string`);
  }
}

function assertPlainString(value: string, label: string): void {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${label} must be a NUL-free string`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  assertPlainString(value, label);
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

function assertNullableSha256(value: string | null, label: string): void {
  if (value !== null) {
    assertSha256(value, label);
  }
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}
