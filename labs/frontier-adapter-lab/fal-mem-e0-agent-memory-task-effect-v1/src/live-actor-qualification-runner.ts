import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { RemoteLiveQualifiedModelEvidence } from "../../../../src/completion/completion-types.js";
import { modelQualificationRecordSchema } from "../../../../src/model/model-qualification-schema.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  createMemE0ActorQualificationFreeze,
  createMemE0ActorQualificationReceipt,
  createNotRunMemE0ActorQualificationReceipt,
  memE0ActorQualificationFreezeSchema,
  memE0ActorQualificationSourceSchema,
  memE0ActorQualificationTaskSchema,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  MEM_E0_ACTOR_QUALIFICATION_MODEL,
  MEM_E0_ACTOR_QUALIFICATION_PROVIDER,
  type MemE0ActorQualificationReceipt,
} from "./actor-qualification.js";
import {
  loadMemE0ActorQualificationFixture,
  MEM_E0_ACTOR_QUALIFICATION_ID,
  type MemE0LoadedActorQualificationFixture,
} from "./actor-qualification-fixture.js";
import {
  loadMemE0ActorQualificationModelEvidence,
  type MemE0ActorQualificationModelEvidence,
} from "./actor-qualification-model-evidence.js";
import {
  observeMemE0ActorQualificationSource,
  type MemE0ActorQualificationSourceSnapshot,
} from "./actor-qualification-source.js";
import {
  memE0ActorQualificationAdapterConfigSha256,
  parseMemE0LiveActorQualificationOutput,
  type MemE0LiveActorQualificationInput,
  type MemE0LiveActorQualificationOutput,
} from "./live-actor-qualification-executor.js";
import { createMemE0LivePricingSnapshot } from "./live-preflight.js";
import { inspectMemE0QualificationHostState } from "./qualification-host-state.js";
import { createMemE0SanitizedBoundaryError } from "./sanitized-failure.js";
import {
  createMemE0Workspace,
  memE0VerifierEnvironment,
  observeMemE0WorkspaceAfter,
  type MemE0WorkspaceAfter,
  type MemE0WorkspaceBefore,
} from "./workspace.js";

const execFileAsync = promisify(execFile);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const LOCAL_QUALIFICATION_RECORD_REF =
  ".bornagent/mem-e0/model-qualification-record.json" as const;
const ACTOR_CHILD_RELATIVE_PATH =
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-actor-qualification-child.ts" as const;
const PRODUCTION_PI_RUNTIME_RELATIVE_PATH =
  "src/providers/pi/production-pi-runtime-port.ts" as const;

const ds0BindingSchema = z.object({
  evidenceSha256: sha256Schema,
  identitySha256: sha256Schema,
  observationReferenceSha256: sha256Schema,
  observationSha256: sha256Schema,
  pricingSha256: sha256Schema,
  protocolSha256: sha256Schema,
  recordSha256: sha256Schema,
}).strict();

const planContentSchema = z.object({
  authorizationSemantics: z.object({
    apiKeyPresenceIsAuthorization: z.literal(false),
    defaultOutcome: z.literal("not_run"),
    remoteCallsAuthorizedByPlan: z.literal(false),
    requiresExactSelfHashedAuthorization: z.literal(true),
  }).strict(),
  cost: z.object({
    isProviderInvoice: z.literal(false),
    maximumAuthorizedCostUsdMicros: z.literal(
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
    ),
    qualificationOnly: z.literal(true),
  }).strict(),
  ds0: ds0BindingSchema,
  freeze: memE0ActorQualificationFreezeSchema,
  model: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
  planType: z.literal("mem-e0-deepseek-tool-actor-qualification-plan-v1"),
  provider: z.literal(MEM_E0_ACTOR_QUALIFICATION_PROVIDER),
  qualificationId: z.literal(MEM_E0_ACTOR_QUALIFICATION_ID),
  schemaVersion: z.literal(1),
  source: memE0ActorQualificationSourceSchema,
  task: memE0ActorQualificationTaskSchema,
}).strict().superRefine((value, context) => {
  if (
    value.ds0.evidenceSha256 !==
      value.freeze.modelQualificationEvidenceSha256 ||
    value.ds0.identitySha256 !==
      value.freeze.modelQualificationIdentitySha256 ||
    value.ds0.observationSha256 !==
      value.freeze.modelQualificationObservationSha256 ||
    value.ds0.pricingSha256 !==
      value.freeze.modelQualificationPricingSha256 ||
    value.ds0.protocolSha256 !==
      value.freeze.modelQualificationProtocolSha256 ||
    value.ds0.recordSha256 !==
      value.freeze.modelQualificationRecordSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "MEM-E0 qualification plan DS0 binding drifted from actor freeze",
      path: ["ds0"],
    });
  }
});

export const memE0LiveActorQualificationPlanSchema = planContentSchema
  .extend({ planSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { planSha256, ...content } = value;
    if (planSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "MEM-E0 actor qualification plan canonical self-hash mismatch",
        path: ["planSha256"],
      });
    }
  });

const authorizationContentSchema = z.object({
  actorFreezeSha256Confirmation: sha256Schema,
  authorizeRemote: z.literal(true),
  ds0ObservationReferenceSha256Confirmation: sha256Schema,
  ds0ObservationSha256Confirmation: sha256Schema,
  maximumAuthorizedCostUsdMicros: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  ),
  modelQualificationRecordSha256Confirmation: sha256Schema,
  planSha256Confirmation: sha256Schema,
  protectedTreeSha256Confirmation: sha256Schema,
  schemaVersion: z.literal(1),
  sourceCommitConfirmation: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

export const memE0LiveActorQualificationAuthorizationSchema =
  authorizationContentSchema.extend({ authorizationSha256: sha256Schema })
    .strict()
    .superRefine((value, context) => {
      const { authorizationSha256, ...content } = value;
      if (authorizationSha256 !== sha256Canonical(content)) {
        context.addIssue({
          code: "custom",
          message: "MEM-E0 actor qualification authorization self-hash mismatch",
          path: ["authorizationSha256"],
        });
      }
    });

export type MemE0LiveActorQualificationPlan = Readonly<
  z.infer<typeof memE0LiveActorQualificationPlanSchema>
>;
export type MemE0LiveActorQualificationAuthorization = Readonly<
  z.infer<typeof memE0LiveActorQualificationAuthorizationSchema>
>;

export interface MemE0LiveActorQualificationPlanResult {
  readonly plan: MemE0LiveActorQualificationPlan;
  readonly receipt: MemE0ActorQualificationReceipt;
}

export interface MemE0LiveActorQualificationPlanInput {
  readonly ds0ObservationPath: string;
  readonly repositoryRoot: string;
}

export interface MemE0LiveActorQualificationRunInput
  extends MemE0LiveActorQualificationPlanInput {
  readonly authorization?: unknown;
  readonly plan: unknown;
}

interface PreparedPlan {
  readonly actorFixture: MemE0LoadedActorQualificationFixture;
  readonly modelEvidence: MemE0ActorQualificationModelEvidence;
  readonly plan: MemE0LiveActorQualificationPlan;
  readonly recordSourceReference: string;
}

interface StagedQualificationRecord {
  readonly localModelEvidence: RemoteLiveQualifiedModelEvidence & Readonly<{
    readonly qualificationEvidenceRef: typeof LOCAL_QUALIFICATION_RECORD_REF;
    readonly qualificationUsageCapability: "complete";
  }>;
  readonly recordRawSha256: string;
}

interface VerifierProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executable: string;
}

interface VerifierProcessObservation {
  readonly exitCode: number | null;
  readonly processId: number;
  readonly stderrSha256: string;
  readonly stdoutSha256: string;
}

interface WorkspaceManifestObservation {
  readonly exactFileSet: boolean;
  readonly finalManifestSha256: string;
  readonly supportRecordUnchanged: boolean;
  readonly unchangedPublicFilesStable: boolean;
}

interface RunnerDependencies {
  readonly inspectWorkspaceHostState: typeof inspectMemE0QualificationHostState;
  readonly authorizedChildEnvironment: () => Readonly<
    Record<string, string | undefined>
  >;
  readonly cleanupTemporaryRoot: (path: string) => Promise<void>;
  readonly createTemporaryRoot: () => Promise<string>;
  readonly loadActorFixture: (
    repositoryRoot: string,
  ) => Promise<MemE0LoadedActorQualificationFixture>;
  readonly loadModelEvidence: (
    repositoryRoot: string,
    ds0ObservationPath: string,
    actorFixture: MemE0LoadedActorQualificationFixture,
  ) => Promise<MemE0ActorQualificationModelEvidence>;
  readonly observeSource: (
    repositoryRoot: string,
  ) => Promise<MemE0ActorQualificationSourceSnapshot>;
  readonly productionPiRuntimeImplementationSha256: (
    repositoryRoot: string,
  ) => Promise<string>;
  readonly runVerifierProcess: (
    request: VerifierProcessRequest,
  ) => Promise<VerifierProcessObservation>;
  readonly spawnActor: (input: Readonly<{
    readonly actorInput: MemE0LiveActorQualificationInput;
    readonly childEnvironment: Readonly<Record<string, string | undefined>>;
    readonly repositoryRoot: string;
    readonly temporaryRoot: string;
  }>) => Promise<MemE0LiveActorQualificationOutput>;
  readonly stageQualificationRecord: (input: Readonly<{
    readonly actorFixture: MemE0LoadedActorQualificationFixture;
    readonly freeze: MemE0LiveActorQualificationPlan["freeze"];
    readonly modelEvidence: MemE0ActorQualificationModelEvidence;
    readonly recordSourceReference: string;
    readonly repositoryRoot: string;
    readonly workspace: string;
  }>) => Promise<StagedQualificationRecord>;
}

export type MemE0ActorQualificationRunnerTestOverrides = Partial<
  RunnerDependencies
>;

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nestedPath(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" ||
    (!nested.startsWith("..") && !isAbsolute(nested));
}

function repositoryRelativeReferenceSha256(
  repositoryRoot: string,
  path: string,
): string {
  if (!isAbsolute(path)) {
    throw new TypeError("DS0 observation path must be explicit and absolute");
  }
  const normalizedRoot = resolve(repositoryRoot);
  const normalizedPath = resolve(path);
  if (!nestedPath(normalizedRoot, normalizedPath)) {
    throw new Error("DS0 observation path is outside the repository");
  }
  const reference = relative(normalizedRoot, normalizedPath)
    .split(sep).join("/");
  return rawSha256(reference);
}

function taskFromFixture(
  fixture: MemE0LoadedActorQualificationFixture,
): z.infer<typeof memE0ActorQualificationTaskSchema> {
  return memE0ActorQualificationTaskSchema.parse({
    allowedChangedPaths: fixture.config.fixture.case.allowedChangedPaths,
    disclosureClass: "public_synthetic",
    hiddenVerifierSha256:
      fixture.config.fixture.case.hiddenVerifierImplementationRawSha256,
    initialTargetSha256:
      fixture.config.fixture.case.initialTargetRawSha256,
    initialWorkspaceManifestSha256:
      fixture.config.fixture.case.publicWorkspaceManifestSha256,
    memoryMode: "off",
    publicVerifierSha256:
      fixture.config.fixture.case.publicVerifierRawSha256,
    targetRelativePath: fixture.config.fixture.case.targetRelativePath,
    taskSha256: fixture.config.fixture.case.taskSha256,
  });
}

export function createMemE0LiveActorQualificationPlan(value: unknown):
  MemE0LiveActorQualificationPlan {
  const input = z.object({
    ds0: ds0BindingSchema,
    freeze: memE0ActorQualificationFreezeSchema,
    source: memE0ActorQualificationSourceSchema,
    task: memE0ActorQualificationTaskSchema,
  }).strict().parse(value);
  const content = planContentSchema.parse({
    authorizationSemantics: {
      apiKeyPresenceIsAuthorization: false,
      defaultOutcome: "not_run",
      remoteCallsAuthorizedByPlan: false,
      requiresExactSelfHashedAuthorization: true,
    },
    cost: {
      isProviderInvoice: false,
      maximumAuthorizedCostUsdMicros:
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
      qualificationOnly: true,
    },
    ds0: input.ds0,
    freeze: input.freeze,
    model: MEM_E0_ACTOR_QUALIFICATION_MODEL,
    planType: "mem-e0-deepseek-tool-actor-qualification-plan-v1",
    provider: MEM_E0_ACTOR_QUALIFICATION_PROVIDER,
    qualificationId: MEM_E0_ACTOR_QUALIFICATION_ID,
    schemaVersion: 1,
    source: input.source,
    task: input.task,
  });
  return Object.freeze(memE0LiveActorQualificationPlanSchema.parse({
    ...content,
    planSha256: sha256Canonical(content),
  }));
}

export function parseMemE0LiveActorQualificationPlan(
  value: unknown,
): MemE0LiveActorQualificationPlan {
  return Object.freeze(memE0LiveActorQualificationPlanSchema.parse(value));
}

export function createMemE0LiveActorQualificationAuthorization(
  value: unknown,
): MemE0LiveActorQualificationAuthorization {
  const content = authorizationContentSchema.parse(value);
  return Object.freeze(
    memE0LiveActorQualificationAuthorizationSchema.parse({
      ...content,
      authorizationSha256: sha256Canonical(content),
    }),
  );
}

export function parseMemE0LiveActorQualificationAuthorization(
  value: unknown,
): MemE0LiveActorQualificationAuthorization {
  return Object.freeze(
    memE0LiveActorQualificationAuthorizationSchema.parse(value),
  );
}

async function preparePlan(
  input: MemE0LiveActorQualificationPlanInput,
  dependencies: RunnerDependencies,
): Promise<PreparedPlan> {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (!isAbsolute(input.repositoryRoot)) {
    throw new TypeError("MEM-E0 qualification repository root must be absolute");
  }
  const actorFixture = await dependencies.loadActorFixture(repositoryRoot);
  const [modelEvidence, source, productionImplementationSha256] =
    await Promise.all([
      dependencies.loadModelEvidence(
        repositoryRoot,
        input.ds0ObservationPath,
        actorFixture,
      ),
      dependencies.observeSource(repositoryRoot),
      dependencies.productionPiRuntimeImplementationSha256(repositoryRoot),
    ]);
  const pricing = createMemE0LivePricingSnapshot();
  const freeze = createMemE0ActorQualificationFreeze({
    adapterConfigSha256:
      memE0ActorQualificationAdapterConfigSha256(actorFixture),
    modelQualificationEvidenceSha256:
      modelEvidence.modelQualificationEvidenceSha256,
    modelQualificationIdentitySha256:
      modelEvidence.modelQualificationIdentitySha256,
    modelQualificationObservationSha256:
      modelEvidence.modelQualificationObservationSha256,
    modelQualificationPricingSha256:
      modelEvidence.modelQualificationPricingSha256,
    modelQualificationProtocolSha256:
      modelEvidence.modelQualificationProtocolSha256,
    modelQualificationRecordSha256:
      modelEvidence.modelQualificationRecordSha256,
    policySha256: actorFixture.config.remotePolicy.profileSha256,
    pricingSha256: pricing.pricingSha256,
    productionPiRuntimeImplementationSha256:
      productionImplementationSha256,
    qualificationFixtureSha256:
      actorFixture.config.fixture.fixtureBindingSha256,
    qualificationProtocolSha256: actorFixture.config.configSha256,
    systemInstructionSha256: rawSha256(AGENT_SYSTEM_INSTRUCTIONS),
    toolCatalogSha256: actorFixture.config.actor.toolCatalogSha256,
  });
  const plan = createMemE0LiveActorQualificationPlan({
    ds0: {
      evidenceSha256: modelEvidence.modelQualificationEvidenceSha256,
      identitySha256: modelEvidence.modelQualificationIdentitySha256,
      observationReferenceSha256: repositoryRelativeReferenceSha256(
        repositoryRoot,
        input.ds0ObservationPath,
      ),
      observationSha256:
        modelEvidence.modelQualificationObservationSha256,
      pricingSha256: modelEvidence.modelQualificationPricingSha256,
      protocolSha256: modelEvidence.modelQualificationProtocolSha256,
      recordSha256: modelEvidence.modelQualificationRecordSha256,
    },
    freeze,
    source,
    task: taskFromFixture(actorFixture),
  });
  return Object.freeze({
    actorFixture,
    modelEvidence,
    plan,
    recordSourceReference:
      modelEvidence.descriptor.qualificationEvidenceRef,
  });
}

function notRunReceipt(
  plan: MemE0LiveActorQualificationPlan,
): MemE0ActorQualificationReceipt {
  return createNotRunMemE0ActorQualificationReceipt({
    freeze: plan.freeze,
    source: plan.source,
    task: plan.task,
  });
}

function assertAuthorization(
  plan: MemE0LiveActorQualificationPlan,
  authorization: MemE0LiveActorQualificationAuthorization,
): void {
  if (
    authorization.planSha256Confirmation !== plan.planSha256 ||
    authorization.sourceCommitConfirmation !== plan.source.commit ||
    authorization.protectedTreeSha256Confirmation !==
      plan.source.protectedTreeSha256 ||
    authorization.actorFreezeSha256Confirmation !==
      plan.freeze.actorFreezeSha256 ||
    authorization.ds0ObservationReferenceSha256Confirmation !==
      plan.ds0.observationReferenceSha256 ||
    authorization.ds0ObservationSha256Confirmation !==
      plan.ds0.observationSha256 ||
    authorization.modelQualificationRecordSha256Confirmation !==
      plan.ds0.recordSha256 ||
    authorization.maximumAuthorizedCostUsdMicros !==
      plan.cost.maximumAuthorizedCostUsdMicros
  ) {
    throw new Error("MEM-E0 actor qualification authorization mismatched plan");
  }
}

async function productionImplementationSha256(
  repositoryRoot: string,
): Promise<string> {
  return rawSha256(await readFile(join(
    repositoryRoot,
    ...PRODUCTION_PI_RUNTIME_RELATIVE_PATH.split("/"),
  )));
}

function authorizedChildEnvironment(): Readonly<
  Record<string, string | undefined>
> {
  const source = process.env;
  return Object.freeze({
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    NO_COLOR: "1",
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

async function productionSpawnActor(input: Readonly<{
  readonly actorInput: MemE0LiveActorQualificationInput;
  readonly childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot: string;
  readonly temporaryRoot: string;
}>): Promise<MemE0LiveActorQualificationOutput> {
  const envelopePath = join(input.temporaryRoot, "actor-input.json");
  await writeFile(envelopePath, JSON.stringify(input.actorInput), {
    encoding: "utf8",
    flag: "wx",
  });
  const childEntry = join(
    input.repositoryRoot,
    ...ACTOR_CHILD_RELATIVE_PATH.split("/"),
  );
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(process.execPath, [
      "--no-warnings",
      "--import",
      import.meta.resolve("tsx"),
      childEntry,
      envelopePath,
    ], {
      cwd: input.repositoryRoot,
      encoding: "utf8",
      env: input.childEnvironment,
      maxBuffer: 256 * 1_024,
      timeout: 360_000,
      windowsHide: true,
    });
  } catch (error) {
    throw createMemE0SanitizedBoundaryError(
      "qualification_actor_failed",
      error,
    );
  }
  const stdout = typeof result.stdout === "string"
    ? result.stdout
    : result.stdout.toString("utf8");
  const stderr = typeof result.stderr === "string"
    ? result.stderr
    : result.stderr.toString("utf8");
  if (stderr.length !== 0) {
    throw createMemE0SanitizedBoundaryError(
      "qualification_actor_failed",
      Object.assign(new Error("qualification child stderr rejected"), {
        stderr,
        stdout,
      }),
    );
  }
  const lines = stdout.trimEnd().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error("qualification actor emitted an invalid output envelope");
  }
  let value: unknown;
  try {
    value = parseStrictJson(lines[0]);
  } catch (error) {
    throw createMemE0SanitizedBoundaryError(
      "qualification_actor_observation_parse_failed",
      error,
    );
  }
  return parseMemE0LiveActorQualificationOutput(value);
}

async function productionVerifierProcess(
  request: VerifierProcessRequest,
): Promise<VerifierProcessObservation> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: memE0VerifierEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = createHash("sha256");
    const stderr = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      rejectOnce(new Error("qualification verifier timed out"));
    }, 30_000);
    child.on("error", rejectOnce);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 64 * 1_024) {
        rejectOnce(new Error("qualification verifier stdout exceeded cap"));
        return;
      }
      stdout.update(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1_024) {
        rejectOnce(new Error("qualification verifier stderr exceeded cap"));
        return;
      }
      stderr.update(chunk);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const processId = child.pid;
      if (processId === undefined || processId <= 0) {
        reject(new Error("qualification verifier process identity missing"));
        return;
      }
      resolvePromise(Object.freeze({
        exitCode,
        processId,
        stderrSha256: stderr.digest("hex"),
        stdoutSha256: stdout.digest("hex"),
      }));
    });
  });
}

function resolveBoundRepositoryPath(
  repositoryRoot: string,
  reference: string,
): string {
  const root = resolve(repositoryRoot);
  const path = resolve(root, ...reference.split("/"));
  if (!nestedPath(root, path)) {
    throw new Error("qualification record escaped repository root");
  }
  return path;
}

async function productionStageQualificationRecord(input: Readonly<{
  readonly actorFixture: MemE0LoadedActorQualificationFixture;
  readonly freeze: MemE0LiveActorQualificationPlan["freeze"];
  readonly modelEvidence: MemE0ActorQualificationModelEvidence;
  readonly recordSourceReference: string;
  readonly repositoryRoot: string;
  readonly workspace: string;
}>): Promise<StagedQualificationRecord> {
  const sourcePath = resolveBoundRepositoryPath(
    input.repositoryRoot,
    input.recordSourceReference,
  );
  const raw = await readFile(sourcePath);
  const record = modelQualificationRecordSchema.parse(
    parseStrictJson(raw.toString("utf8")),
  );
  if (
    sha256Canonical(record) !== input.freeze.modelQualificationRecordSha256 ||
    record.evidenceSha256 !==
      input.freeze.modelQualificationEvidenceSha256 ||
    record.identitySha256 !==
      input.freeze.modelQualificationIdentitySha256
  ) {
    throw new Error("qualification record changed before workspace staging");
  }
  const destination = join(
    input.workspace,
    ...LOCAL_QUALIFICATION_RECORD_REF.split("/"),
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, raw, { flag: "wx" });
  const localModelEvidence = Object.freeze({
    ...input.modelEvidence.descriptor,
    qualificationEvidenceRef: LOCAL_QUALIFICATION_RECORD_REF,
    qualificationUsageCapability: "complete" as const,
  });
  return Object.freeze({
    localModelEvidence,
    recordRawSha256: rawSha256(raw),
  });
}

async function listWorkspaceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        throw new Error("qualification workspace contains a non-file entry");
      }
    }
  };
  await visit(root);
  return Object.freeze(files.sort((left, right) =>
    left.localeCompare(right, "en")));
}

export async function inspectMemE0QualificationWorkspaceManifest(input: Readonly<{
  readonly actorFixture: MemE0LoadedActorQualificationFixture;
  readonly before: MemE0WorkspaceBefore;
  readonly recordRawSha256: string;
  readonly expectedSessionEventSpanSha256: string;
}>, inspectHostState = inspectMemE0QualificationHostState): Promise<WorkspaceManifestObservation> {
  const files = await listWorkspaceFiles(input.before.workspace);
  const hostState = await inspectHostState({
    expectedSessionEventSpanSha256: input.expectedSessionEventSpanSha256,
    files,
    workspace: input.before.workspace,
  });
  const expected = Object.freeze([
    ...input.before.publicFilePaths,
    LOCAL_QUALIFICATION_RECORD_REF,
    ...hostState.filePaths,
  ].sort((left, right) => left.localeCompare(right, "en")));
  const entries = await Promise.all(files.map(async (path) => {
    const bytes = await readFile(join(
      input.before.workspace,
      ...path.split("/"),
    ));
    return Object.freeze({
      byteLength: bytes.byteLength,
      path,
      rawSha256: rawSha256(bytes),
    });
  }));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const target = input.actorFixture.config.fixture.case.targetRelativePath;
  const unchangedPublicFilesStable =
    input.actorFixture.case.publicFiles.every((file) =>
      file.path === target || byPath.get(file.path)?.rawSha256 === file.rawSha256
    );
  return Object.freeze({
    exactFileSet: hostState.valid && sha256Canonical(files) === sha256Canonical(expected),
    finalManifestSha256: sha256Canonical(entries),
    supportRecordUnchanged:
      byPath.get(LOCAL_QUALIFICATION_RECORD_REF)?.rawSha256 ===
        input.recordRawSha256,
    unchangedPublicFilesStable,
  });
}

function productionDependencies(): RunnerDependencies {
  const dependencies: RunnerDependencies = {
    inspectWorkspaceHostState: inspectMemE0QualificationHostState,
    authorizedChildEnvironment,
    cleanupTemporaryRoot: async (path: string) => {
      await rm(path, { force: true, recursive: true });
    },
    createTemporaryRoot: async () =>
      await mkdtemp(join(tmpdir(), "bornagent-fal-mem-e0-qualification-")),
    loadActorFixture: loadMemE0ActorQualificationFixture,
    loadModelEvidence: async (
      repositoryRoot: string,
      ds0ObservationPath: string,
      actorFixture: MemE0LoadedActorQualificationFixture,
    ) => await loadMemE0ActorQualificationModelEvidence({
      actorFixture,
      ds0ObservationPath,
      repositoryRoot,
    }),
    observeSource: async (repositoryRoot: string) =>
      await observeMemE0ActorQualificationSource({ repositoryRoot }),
    productionPiRuntimeImplementationSha256:
      productionImplementationSha256,
    runVerifierProcess: productionVerifierProcess,
    spawnActor: productionSpawnActor,
    stageQualificationRecord: productionStageQualificationRecord,
  };
  return Object.freeze(dependencies);
}

async function planUnsafe(
  input: MemE0LiveActorQualificationPlanInput,
  dependencies: RunnerDependencies,
): Promise<MemE0LiveActorQualificationPlanResult> {
  const prepared = await preparePlan(input, dependencies);
  return Object.freeze({
    plan: prepared.plan,
    receipt: notRunReceipt(prepared.plan),
  });
}

async function runFreshVerifiers(input: Readonly<{
  readonly actorFixture: MemE0LoadedActorQualificationFixture;
  readonly dependencies: RunnerDependencies;
  readonly workspace: string;
}>): Promise<Readonly<{
  readonly hidden: VerifierProcessObservation;
  readonly public: VerifierProcessObservation;
}>> {
  const publicArgv =
    input.actorFixture.case.definition.publicWorkspace.publicVerifierArgv;
  const [publicResult, hiddenResult] = await Promise.all([
    input.dependencies.runVerifierProcess({
      args: [publicArgv[1]],
      cwd: input.workspace,
      executable: publicArgv[0],
    }),
    input.dependencies.runVerifierProcess({
      args: [input.actorFixture.case.hiddenVerifierPath, input.workspace],
      cwd: input.actorFixture.case.directory,
      executable: process.execPath,
    }),
  ]);
  return Object.freeze({ hidden: hiddenResult, public: publicResult });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

async function completedReceipt(input: Readonly<{
  readonly actor: MemE0LiveActorQualificationOutput;
  readonly after: MemE0WorkspaceAfter;
  readonly before: MemE0WorkspaceBefore;
  readonly manifest: WorkspaceManifestObservation;
  readonly plan: MemE0LiveActorQualificationPlan;
  readonly prepared: PreparedPlan;
  readonly sourceAfter: MemE0ActorQualificationSourceSnapshot;
  readonly verifiers: Readonly<{
    readonly hidden: VerifierProcessObservation;
    readonly public: VerifierProcessObservation;
  }>;
}>): Promise<MemE0ActorQualificationReceipt> {
  const expectedPaths = input.plan.task.allowedChangedPaths;
  const sourceStable = sameCanonical(input.sourceAfter, input.plan.source);
  const changedPathsExact = sameCanonical(input.after.changedPaths, expectedPaths);
  const actorChangedPathsExact = sameCanonical(
    input.actor.run.changedPaths,
    input.after.changedPaths,
  );
  const publicPassed = input.verifiers.public.exitCode === 0;
  const hiddenPassed =
    input.verifiers.hidden.exitCode ===
      input.prepared.actorFixture.case.definition.hiddenVerifier.successExitCode &&
    input.verifiers.hidden.stdoutSha256 ===
      input.prepared.actorFixture.case.definition.hiddenVerifier.successStdoutSha256;
  const distinctProcesses = new Set([
    input.actor.actorProcessId,
    input.verifiers.public.processId,
    input.verifiers.hidden.processId,
  ]).size === 3 &&
    input.actor.actorProcessId !== process.pid &&
    input.verifiers.public.processId !== process.pid &&
    input.verifiers.hidden.processId !== process.pid;
  const hiddenOutsideWorkspace = !nestedPath(
    resolve(input.before.workspace),
    resolve(input.prepared.actorFixture.case.hiddenVerifierPath),
  );
  const parentChecksPassed =
    sourceStable &&
    changedPathsExact &&
    actorChangedPathsExact &&
    input.manifest.exactFileSet &&
    input.manifest.supportRecordUnchanged &&
    input.manifest.unchangedPublicFilesStable &&
    input.after.finalTargetRawSha256 !== input.before.initialTargetRawSha256 &&
    publicPassed &&
    hiddenPassed &&
    distinctProcesses &&
    hiddenOutsideWorkspace;
  return createMemE0ActorQualificationReceipt({
    freeze: input.plan.freeze,
    providerUsage: input.actor.providerUsage,
    run: input.actor.run,
    source: input.plan.source,
    task: input.plan.task,
    verifier: {
      agentExitedBeforeVerifier: true,
      argvSha256:
        input.prepared.actorFixture.case.definition.hiddenVerifier.argvIdentitySha256,
      distinctOsProcesses: distinctProcesses,
      exitCode: input.verifiers.hidden.exitCode,
      finalTargetSha256: input.after.finalTargetRawSha256,
      finalWorkspaceManifestSha256: input.manifest.finalManifestSha256,
      hiddenVerifierOutsideWorkspace: hiddenOutsideWorkspace,
      implementationSha256:
        input.prepared.actorFixture.case.definition.hiddenVerifier.implementationRawSha256,
      passed: parentChecksPassed,
      stderrSha256: input.verifiers.hidden.stderrSha256,
      stdoutSha256: input.verifiers.hidden.stdoutSha256,
    },
  });
}

async function runUnsafe(
  rawInput: MemE0LiveActorQualificationRunInput,
  dependencies: RunnerDependencies,
): Promise<MemE0ActorQualificationReceipt> {
  const plan = parseMemE0LiveActorQualificationPlan(rawInput.plan);
  if (rawInput.authorization === undefined) return notRunReceipt(plan);
  const authorization = parseMemE0LiveActorQualificationAuthorization(
    rawInput.authorization,
  );
  assertAuthorization(plan, authorization);

  // This re-observation is still offline. No credential access, temporary
  // workspace, or child process occurs until the exact plan is reproduced.
  const prepared = await preparePlan(rawInput, dependencies);
  if (prepared.plan.planSha256 !== plan.planSha256) {
    throw new Error("MEM-E0 actor qualification plan changed before launch");
  }
  if (!prepared.plan.source.protectedPathsClean) {
    throw new Error("MEM-E0 actor qualification source is not clean");
  }
  const cleanSource = Object.freeze({
    ...plan.source,
    protectedPathsClean: true as const,
  });

  // This is the first credential-bearing operation and is strictly below all
  // plan/authorization/source gates.
  const childEnvironment = dependencies.authorizedChildEnvironment();
  if (
    typeof childEnvironment.DEEPSEEK_API_KEY !== "string" ||
    childEnvironment.DEEPSEEK_API_KEY.trim().length === 0
  ) {
    throw new Error("MEM-E0 actor qualification credential is unavailable");
  }
  const temporaryRoot = await dependencies.createTemporaryRoot();
  try {
    const workspace = join(temporaryRoot, "workspace");
    const stateRoot = join(temporaryRoot, "state");
    await mkdir(stateRoot, { recursive: false });
    const before = await createMemE0Workspace({
      loadedCase: prepared.actorFixture.case,
      workspace,
    });
    const staged = await dependencies.stageQualificationRecord({
      actorFixture: prepared.actorFixture,
      freeze: plan.freeze,
      modelEvidence: prepared.modelEvidence,
      recordSourceReference: prepared.recordSourceReference,
      repositoryRoot: resolve(rawInput.repositoryRoot),
      workspace,
    });
    const actor = await dependencies.spawnActor({
      actorInput: {
        freeze: plan.freeze,
        modelEvidence: staged.localModelEvidence,
        repositoryRoot: resolve(rawInput.repositoryRoot),
        schemaVersion: 1,
        source: cleanSource,
        stateRoot,
        workspace,
      },
      childEnvironment,
      repositoryRoot: resolve(rawInput.repositoryRoot),
      temporaryRoot,
    });

    // Both verifiers are launched only after the actor child has exited.
    const [after, manifest, sourceAfter, verifiers] = await Promise.all([
      observeMemE0WorkspaceAfter(prepared.actorFixture.case, before),
      inspectMemE0QualificationWorkspaceManifest({
        actorFixture: prepared.actorFixture,
        before,
        recordRawSha256: staged.recordRawSha256,
        expectedSessionEventSpanSha256: actor.run.sessionEventSpanSha256,
      }, dependencies.inspectWorkspaceHostState),
      dependencies.observeSource(resolve(rawInput.repositoryRoot)),
      runFreshVerifiers({
        actorFixture: prepared.actorFixture,
        dependencies,
        workspace,
      }),
    ]);
    return await completedReceipt({
      actor,
      after,
      before,
      manifest,
      plan,
      prepared,
      sourceAfter,
      verifiers,
    });
  } finally {
    await dependencies.cleanupTemporaryRoot(temporaryRoot);
  }
}

async function sanitized<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw createMemE0SanitizedBoundaryError(
      "qualification_actor_failed",
      error,
    );
  }
}

export async function planMemE0LiveActorQualification(
  input: MemE0LiveActorQualificationPlanInput,
): Promise<MemE0LiveActorQualificationPlanResult> {
  const dependencies = productionDependencies();
  return await sanitized(async () => await planUnsafe(input, dependencies));
}

export async function runMemE0LiveActorQualificationRunner(
  input: MemE0LiveActorQualificationRunInput,
): Promise<MemE0ActorQualificationReceipt> {
  const dependencies = productionDependencies();
  return await sanitized(async () => await runUnsafe(input, dependencies));
}

/**
 * Test-only seam. Production entrypoints above always construct their own
 * frozen dependency set, so a caller cannot inject source or actor evidence
 * into a production qualification receipt.
 */
export function createMemE0ActorQualificationRunnerForTesting(
  overrides: MemE0ActorQualificationRunnerTestOverrides,
): Readonly<{
  readonly plan: (
    input: MemE0LiveActorQualificationPlanInput,
  ) => Promise<MemE0LiveActorQualificationPlanResult>;
  readonly run: (
    input: MemE0LiveActorQualificationRunInput,
  ) => Promise<MemE0ActorQualificationReceipt>;
}> {
  const dependencies = Object.freeze({
    ...productionDependencies(),
    ...overrides,
  });
  return Object.freeze({
    plan: async (input) =>
      await sanitized(async () => await planUnsafe(input, dependencies)),
    run: async (input) =>
      await sanitized(async () => await runUnsafe(input, dependencies)),
  });
}
