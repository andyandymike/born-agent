import type { AgentCapabilityRequirement } from "../model/backend-factory.js";
import { BackendPreflightError } from "../model/backend-factory.js";
import { ModelQualificationLockError, ModelQualificationLock } from "../model/model-qualification-lock.js";
import { ModelQualificationRunner } from "../model/model-qualification-runner.js";
import {
  modelQualificationIdentitySha256,
} from "../model/model-qualification-identity.js";
import {
  MODEL_QUALIFICATION_LIMITS,
} from "../model/model-qualification-suite.js";
import { resolvePiModelQualificationTarget } from "../model/model-qualification-target.js";
import {
  ModelQualificationStore,
  ModelQualificationStoreError,
} from "../model/model-qualification-store.js";
import { assertModeDeclared } from "../model/model-capability-declaration.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type EffectiveRuntimePolicy,
  type ResolvedProviderPolicyRequest,
} from "../policy/policy-resolver.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import type { ModelQualificationRecordV1 } from "../model/model-qualification-schema.js";

export type ModelQualificationCommandExit = 0 | 1 | 2 | 4 | 5 | 6 | 130;

interface CommonQualificationOptions {
  readonly json: boolean;
  readonly model: string;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly provider: string;
}

export interface ModelsQualifyOptions extends CommonQualificationOptions {
  readonly confirmRemoteRequests?: string | undefined;
}

export type ModelsQualificationShowOptions = CommonQualificationOptions;

export interface ModelsQualificationRemoveOptions {
  readonly identitySha256: string;
  readonly json: boolean;
  readonly yes: boolean;
}

interface QualificationPreflight {
  readonly policy: EffectiveRuntimePolicy;
  readonly request: ResolvedProviderPolicyRequest;
  readonly target: Awaited<ReturnType<typeof resolvePiModelQualificationTarget>>;
}

const QUALIFICATION_REQUIREMENT: AgentCapabilityRequirement = Object.freeze({
  cancellation: true,
  completeUsageForReportedTokenCeiling: false,
  streaming: true,
  tools: true,
});

async function preflight(
  options: CommonQualificationOptions,
  runtime: CliRuntime,
): Promise<QualificationPreflight> {
  const policy = resolveEffectiveRuntimePolicy(
    await loadRuntimePolicyRegistry({
      ...(options.policyConfig === undefined
        ? {}
        : { configPath: options.policyConfig }),
      env: runtime.env,
      platform: runtime.platform,
      workspace: runtime.cwd,
    }),
    options.policyProfile,
  );
  const request = resolveProviderPolicyRequest(policy, {
    endpoint:
      options.provider.trim().toLowerCase() === "ollama"
        ? runtime.env.BORN_OLLAMA_BASE_URL
        : undefined,
    model: options.model,
    provider: options.provider,
  });
  const target = await resolvePiModelQualificationTarget({
    endpoint: request.endpoint,
    model: request.model,
    policyProfileId: policy.entry.profile.id,
    policyProfileSha256: policy.evidence.profileSha256,
    provider: request.provider,
    refreshLocalModelCatalog: runtime.refreshLocalModelCatalog,
  });
  assertModeDeclared(target.declaration, "plan");
  if (target.declaration.supports.sequentialToolCalls) {
    assertModeDeclared(target.declaration, "build");
  }
  return Object.freeze({ policy, request, target });
}

function writeRecord(
  io: CliIO,
  record: ModelQualificationRecordV1,
  json: boolean,
  label: "qualified" | "stored",
): void {
  if (json) {
    io.stdout.write(`${JSON.stringify({ record, schemaVersion: 1 }, null, 2)}\n`);
    return;
  }
  io.stdout.write(
    `${label} identity=${record.identitySha256} modes=${record.qualifiedModes.join(",") || "none"} requests=${String(record.totalRequestCount)} evidence=${record.evidenceSha256}\n`,
  );
  for (const probe of record.probeResults) {
    io.stdout.write(
      `probe ${probe.probeId} status=${probe.status} code=${probe.code} requests=${String(probe.requestCount)}\n`,
    );
  }
}

function qualificationResultExit(
  record: ModelQualificationRecordV1,
  requireBuild: boolean,
): ModelQualificationCommandExit {
  const nonCancellationCancelled = record.probeResults.some(
    (probe) => probe.probeId !== "cancellation_v1" && probe.status === "cancelled",
  );
  if (nonCancellationCancelled) return 130;
  if (record.probeResults.some((probe) => probe.status === "timeout")) return 6;
  if (
    record.probeResults.some(
      (probe) =>
        probe.code === "provider_authentication" ||
        probe.code === "provider_permission",
    )
  ) {
    return 4;
  }
  if (
    record.probeResults.some((probe) =>
      ["provider_network", "provider_rate_limit", "provider_quota"].includes(
        probe.code,
      ),
    )
  ) {
    return 5;
  }
  return record.qualifiedModes.includes("plan") &&
    (!requireBuild || record.qualifiedModes.includes("build"))
    ? 0
    : 2;
}

function diagnostic(io: CliIO, error: unknown): ModelQualificationCommandExit {
  if (error instanceof RuntimePolicyError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode === 1 ? 1 : 2;
  }
  if (error instanceof BackendPreflightError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof ModelQualificationStoreError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.code === "qualification_record_corrupt" ? 1 : 2;
  }
  if (error instanceof ModelQualificationLockError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.code === "qualification_lock_invalid" ? 1 : 2;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    io.stderr.write(`qualification_preflight_invalid: ${error.message}\n`);
    return 2;
  }
  io.stderr.write("model qualification internal error\n");
  return 1;
}

export async function executeModelsQualify(
  options: ModelsQualifyOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<ModelQualificationCommandExit> {
  let resolved: QualificationPreflight;
  try {
    resolved = await preflight(options, runtime);
    if (resolved.policy.entry.profile.mode === "remote_explicit") {
      const confirmed = Number(options.confirmRemoteRequests);
      if (
        !Number.isSafeInteger(confirmed) ||
        confirmed !== MODEL_QUALIFICATION_LIMITS.maxProviderRequests
      ) {
        throw new TypeError(
          `remote qualification requires --confirm-remote-requests ${String(MODEL_QUALIFICATION_LIMITS.maxProviderRequests)}`,
        );
      }
      const access = resolved.policy.entry.profile.modelAccess;
      if (
        access.kind !== "remote_explicit" ||
        access.limits.maxProviderRequestsPerRun <
          MODEL_QUALIFICATION_LIMITS.maxProviderRequests ||
        access.limits.maxOutputTokensPerRequest <
          MODEL_QUALIFICATION_LIMITS.maxOutputTokensPerRequest
      ) {
        throw new TypeError("remote policy ceilings are below the fixed qualification suite");
      }
    }
  } catch (error) {
    return diagnostic(io, error);
  }

  const identitySha256 = modelQualificationIdentitySha256(resolved.target.identity);
  let store: ModelQualificationStore;
  let lock: ModelQualificationLock;
  try {
    store = await ModelQualificationStore.create({
      env: runtime.env,
      platform: runtime.platform,
    });
    lock = await ModelQualificationLock.acquire(store.root, identitySha256);
  } catch (error) {
    return diagnostic(io, error);
  }

  let exit: ModelQualificationCommandExit;
  try {
    const backend = runtime.createModelBackend({
      ...(resolved.request.endpoint === undefined
        ? {}
        : { endpoint: resolved.request.endpoint }),
      model: resolved.request.model,
      provider: resolved.request.provider,
      requirement: QUALIFICATION_REQUIREMENT,
      runtimePolicy: resolved.policy,
    });
    const result = await new ModelQualificationRunner().run({
      backend,
      declaration: resolved.target.declaration,
      identity: resolved.target.identity,
    });
    exit = qualificationResultExit(
      result.record,
      resolved.target.declaration.supports.sequentialToolCalls,
    );
    if (exit === 0) {
      await store.commit(result.record);
    }
    writeRecord(io, result.record, options.json, "qualified");
  } catch (error) {
    exit = diagnostic(io, error);
  }
  try {
    await lock.release();
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : "qualification lock cleanup failed"}\n`,
    );
    return 1;
  }
  return exit;
}

export async function executeModelsQualificationShow(
  options: ModelsQualificationShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<ModelQualificationCommandExit> {
  try {
    const resolved = await preflight(options, runtime);
    const store = await ModelQualificationStore.create({
      env: runtime.env,
      platform: runtime.platform,
    });
    const hash = modelQualificationIdentitySha256(resolved.target.identity);
    const record = await store.read(hash);
    if (record === null) {
      io.stderr.write(`model_unqualified: no exact qualification record for ${hash}\n`);
      return 2;
    }
    writeRecord(io, record, options.json, "stored");
    return 0;
  } catch (error) {
    return diagnostic(io, error);
  }
}

export async function executeModelsQualificationRemove(
  options: ModelsQualificationRemoveOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<ModelQualificationCommandExit> {
  if (!/^[a-f0-9]{64}$/u.test(options.identitySha256)) {
    io.stderr.write("qualification_preflight_invalid: identity hash must be lowercase SHA-256\n");
    return 2;
  }
  if (!options.yes) {
    io.stderr.write("qualification_remove_confirmation_required: pass --yes for this exact hash\n");
    return 2;
  }
  let lock: ModelQualificationLock | undefined;
  try {
    const store = await ModelQualificationStore.create({
      env: runtime.env,
      platform: runtime.platform,
    });
    const existing = await store.read(options.identitySha256);
    if (existing === null) {
      io.stderr.write("model_unqualified: qualification record does not exist\n");
      return 2;
    }
    lock = await ModelQualificationLock.acquire(store.root, options.identitySha256);
    const removed = await store.remove(options.identitySha256);
    if (!removed) throw new Error("qualification record removal was not verified");
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify({ identitySha256: options.identitySha256, removed: true, schemaVersion: 1 })}\n`,
      );
    } else {
      io.stdout.write(`removed qualification identity=${options.identitySha256}\n`);
    }
    await lock.release();
    lock = undefined;
    return 0;
  } catch (error) {
    await lock?.release().catch(() => undefined);
    return diagnostic(io, error);
  }
}
