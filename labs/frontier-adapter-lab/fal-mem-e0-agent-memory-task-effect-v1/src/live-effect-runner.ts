import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { memoryRecordSourceReferenceSha256 } from "../../../../src/memory/core/memory-record-v1.js";
import { renderHistoricalMemoryExcerptV1 } from "../../../../src/memory/recall/automatic-memory-recall-service.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { loadMemE0ActorQualificationFixture } from "./actor-qualification-fixture.js";
import { loadMemE0ActorQualificationModelEvidence } from "./actor-qualification-model-evidence.js";
import { observeMemE0ActorQualificationSource } from "./actor-qualification-source.js";
import { parseMemE0ActorQualificationReceipt } from "./actor-qualification.js";
import { loadMemE0Fixture, memE0RawSha256, type MemE0LoadedCase } from "./fixture.js";
import { assertMemE0EffectAuthorization, type MemE0EffectChildInput } from "./live-effect-actor.js";
import {
  createMemE0LiveEffectReceipt, memE0EffectActorObservationSchema, memE0EffectAuthorizationSchema,
  memE0EffectSeedSchema, memE0PreparedEffectPlanSchema, scoreMemE0LiveEffect, sealMemE0PreparedEffectPlan,
  type MemE0EffectArmEvidence, type MemE0PreparedEffectArm, type MemE0PreparedEffectPlan,
} from "./live-effect-contract.js";
import {
  listWorkspaceFiles, planMemE0LiveActorQualification, productionStageQualificationRecord, productionVerifierProcess,
} from "./live-actor-qualification-runner.js";
import { createMemE0LivePlan } from "./live-preflight.js";
import { inspectMemE0QualificationHostState } from "./qualification-host-state.js";
import {
  createMemE0Workspace, memE0VerifierEnvironment, observeMemE0WorkspaceAfter, type MemE0WorkspaceBefore,
} from "./workspace.js";

const execFileAsync = promisify(execFile);
const NIL = sha256Canonical(null);
const ROOT_PREFIX = "bornagent-mem-e0-live-";
const CHILD = "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-live-effect-child.ts";
const GRANT = "src/memory/recall/public-synthetic-remote-memory-grant.ts";
const MODEL_RECORD = ".bornagent/mem-e0/model-qualification-record.json";
const NAV_KEYS = [".bornagent/cache/repository-intelligence/navigation-integrity.key", ".bornagent/cache/repository-intelligence/v1/navigation-integrity.key"];

export const memE0EffectPreparedEnvelopeSchema = z.object({
  ds0ObservationPath: z.string().min(1).max(2_048),
  plan: memE0PreparedEffectPlanSchema,
  preparedRoot: z.string().min(1).max(2_048),
  schemaVersion: z.literal(1),
}).strict();
export type MemE0EffectPreparedEnvelope = z.infer<typeof memE0EffectPreparedEnvelopeSchema>;

function failureHash(error: unknown): string {
  return memE0RawSha256(error instanceof Error ? `${error.name}:${error.message}` : "non_error_throw");
}
async function writeExclusiveJson(path: string, value: unknown): Promise<string> {
  const raw = `${JSON.stringify(value)}\n`;
  await writeFile(path, raw, { flag: "wx" });
  return memE0RawSha256(raw);
}
async function readBoundJson(path: string, expected: string): Promise<unknown> {
  const raw = await readFile(path);
  if (raw.length > 512 * 1_024 || memE0RawSha256(raw) !== expected) throw new Error("prepared effect artifact changed");
  return parseStrictJson(raw.toString("utf8"));
}
async function manifest(workspace: string) {
  return await Promise.all((await listWorkspaceFiles(workspace)).map(async (path) => ({
    path, rawSha256: memE0RawSha256(await readFile(join(workspace, path))),
  })));
}
function pairInvariant(loadedCase: MemE0LoadedCase, plan: MemE0PreparedEffectPlan["preflight"]): string {
  return sha256Canonical({ actorFreezeSha256: plan.bindings.actorFreezeSha256, caseSha256: loadedCase.definition.caseSha256,
    fixtureSha256: plan.bindings.fixtureSha256, policySha256: plan.bindings.disclosurePolicySha256,
    pricingSha256: plan.pricing.pricingSha256, caps: plan.caps, memoryTreatmentExcluded: true });
}
async function assertCurrentSource(repositoryRoot: string, plan: MemE0PreparedEffectPlan): Promise<void> {
  const source = await observeMemE0ActorQualificationSource({ repositoryRoot });
  if (!source.protectedPathsClean || sha256Canonical(source) !== sha256Canonical(plan.qualification.source)) {
    throw new Error("effect source differs from the exact clean qualified commit");
  }
}
async function assertPreparedRoot(envelope: MemE0EffectPreparedEnvelope): Promise<void> {
  const root = resolve(envelope.preparedRoot);
  const canonical = await realpath(root);
  const temp = await realpath(tmpdir());
  const nested = relative(temp, canonical);
  if (!isAbsolute(envelope.preparedRoot) || nested.startsWith("..") || isAbsolute(nested) ||
    relative(root, canonical) !== "" || !basename(root).startsWith(ROOT_PREFIX) ||
    (await readFile(join(root, "batch-id.txt"), "utf8")) !== envelope.plan.batchId) {
    throw new Error("effect prepared root identity is not the original task-owned directory");
  }
}

interface RunnerDependencies {
  readonly child: (input: MemE0EffectChildInput, root: string, env: Readonly<Record<string, string | undefined>>) => Promise<unknown>;
  readonly credential: () => string | undefined;
}
async function productionChild(input: MemE0EffectChildInput, root: string, environment: Readonly<Record<string, string | undefined>>): Promise<unknown> {
  const repositoryRoot = input.phase === "seed" ? input.repositoryRoot : input.actorInput.repositoryRoot;
  const inputPath = join(root, `${input.phase}-input.json`);
  await writeExclusiveJson(inputPath, input);
  try {
    const result = await execFileAsync(process.execPath, ["--no-warnings", "--import", import.meta.resolve("tsx"), join(repositoryRoot, CHILD), inputPath], {
      cwd: repositoryRoot, env: environment, encoding: "utf8", maxBuffer: 512 * 1_024, timeout: 360_000, windowsHide: true,
    });
    if (result.stderr.length !== 0 || result.stdout.trim().split(/\r?\n/u).length !== 1) throw new Error("effect child emitted an invalid envelope");
    return parseStrictJson(result.stdout.trim());
  } catch (error) {
    throw new Error(`effect_child_failed:${failureHash(error)}`, { cause: error });
  }
}
const productionDependencies = (): RunnerDependencies => ({ child: productionChild, credential: () => process.env.DEEPSEEK_API_KEY });

export async function prepareMemE0LiveEffect(input: Readonly<{
  repositoryRoot: string; ds0ObservationPath: string; qualificationReceipt: unknown;
}>): Promise<MemE0EffectPreparedEnvelope> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const qualification = parseMemE0ActorQualificationReceipt(input.qualificationReceipt);
  const current = await planMemE0LiveActorQualification({ repositoryRoot, ds0ObservationPath: input.ds0ObservationPath });
  if (!current.plan.source.protectedPathsClean || sha256Canonical(current.plan.source) !== sha256Canonical(qualification.source) ||
    current.plan.freeze.actorFreezeSha256 !== qualification.freeze.actorFreezeSha256) {
    throw new Error("effect preparation requires the exact clean qualification source and freeze");
  }
  const fixture = await loadMemE0Fixture(repositoryRoot);
  const actorFixture = await loadMemE0ActorQualificationFixture(repositoryRoot);
  const modelEvidence = await loadMemE0ActorQualificationModelEvidence({ repositoryRoot, ds0ObservationPath: input.ds0ObservationPath, actorFixture });
  const preflight = createMemE0LivePlan({ actorQualificationReceipt: qualification,
    disclosurePolicySha256: memE0RawSha256(await readFile(join(repositoryRoot, GRANT))),
    fixtureSha256: sha256Canonical(fixture.cases.map((item) => item.definition.caseSha256)), protocolSha256: fixture.protocol.protocolSha256 });
  const preparedRoot = await mkdtemp(join(tmpdir(), ROOT_PREFIX));
  const batchId = randomUUID();
  await writeFile(join(preparedRoot, "batch-id.txt"), batchId, { flag: "wx" });
  const arms: MemE0PreparedEffectArm[] = [];
  for (const loadedCase of fixture.cases) for (const arm of ["off", "on"] as const) {
    const armRoot = join(preparedRoot, `${loadedCase.definition.caseId}-${arm}`);
    const workspace = join(armRoot, "workspace");
    const stateRoot = join(armRoot, "state");
    await mkdir(join(stateRoot, "temp"), { recursive: true });
    const before = await createMemE0Workspace({ loadedCase, workspace });
    const beforeStateRawSha256 = await writeExclusiveJson(join(armRoot, "before.json"), before);
    const seed = memE0EffectSeedSchema.parse(await productionChild({
      caseId: loadedCase.definition.caseId, phase: "seed", repositoryRoot, workspace, stateRoot,
    }, armRoot, memE0VerifierEnvironment(process.env)));
    const afterSeed = await observeMemE0WorkspaceAfter(loadedCase, before);
    if (afterSeed.changedPaths.length !== 0 || afterSeed.finalTargetRawSha256 !== before.initialTargetRawSha256) throw new Error("effect seed changed public workspace");
    const seedEnvelopeRawSha256 = await writeExclusiveJson(join(armRoot, "seed.json"), seed);
    const staged = await productionStageQualificationRecord({ actorFixture, freeze: qualification.freeze, modelEvidence,
      recordSourceReference: modelEvidence.descriptor.qualificationEvidenceRef, repositoryRoot, workspace });
    const record = seed.record;
    arms.push({ arm, beforeStateRawSha256, caseId: loadedCase.definition.caseId,
      disclosure: { disclosureClass: "public_synthetic", excerptContentSha256: memE0RawSha256(renderHistoricalMemoryExcerptV1(record)),
        recordId: record.recordId, recordSha256: record.recordSha256, sourceReferenceSha256: memoryRecordSourceReferenceSha256(record) },
      initialFiles: await manifest(workspace), initialPublicManifestSha256: before.publicManifestSha256,
      initialTargetSha256: before.initialTargetRawSha256, pairInvariantSha256: pairInvariant(loadedCase, preflight),
      targetPath: loadedCase.definition.publicWorkspace.targetRelativePath, taskSha256: loadedCase.definition.task.taskSha256,
      hiddenVerifierSha256: loadedCase.definition.hiddenVerifier.implementationRawSha256,
      hiddenVerifierStdoutSha256: loadedCase.definition.hiddenVerifier.successStdoutSha256,
      hiddenVerifierArgvSha256: loadedCase.definition.hiddenVerifier.argvIdentitySha256,
      publicVerifierSha256: loadedCase.publicFiles.find((item) => item.path === "verify.mjs")!.rawSha256,
      recordLogicalSha256: loadedCase.definition.memory.recordLogicalSha256, seedEnvelopeRawSha256,
      seedObservationSha256: seed.observationSha256, seedProcessId: seed.processId, stagedModelRecordRawSha256: staged.recordRawSha256 });
  }
  const plan = sealMemE0PreparedEffectPlan({ arms, batchId, effectClaimAllowed: false,
    planType: "mem-e0-prepared-live-effect-plan-v1", preflight, providerCalls: 0, qualification, schemaVersion: 1 });
  await assertCurrentSource(repositoryRoot, plan);
  return memE0EffectPreparedEnvelopeSchema.parse({ ds0ObservationPath: input.ds0ObservationPath, plan, preparedRoot, schemaVersion: 1 });
}

export async function inspectEffectHost(workspace: string, prepared: MemE0PreparedEffectArm, span: string) {
  const actual = await manifest(workspace);
  const initial = new Map(prepared.initialFiles.map((item) => [item.path, item.rawSha256]));
  const newPaths = actual.map((item) => item.path).filter((path) => !initial.has(path) || NAV_KEYS.includes(path));
  const host = await inspectMemE0QualificationHostState({ files: newPaths, expectedSessionEventSpanSha256: span, workspace });
  const allowed = new Set([...initial.keys(), ...host.filePaths]);
  return { actual, hostValid: host.valid && actual.length === allowed.size && actual.every((item) => allowed.has(item.path)) };
}

async function runUnsafe(input: Readonly<{ repositoryRoot: string; envelope: unknown; authorization: unknown }>, dependencies: RunnerDependencies) {
  const envelope = memE0EffectPreparedEnvelopeSchema.parse(input.envelope);
  const authorization = memE0EffectAuthorizationSchema.parse(input.authorization);
  const repositoryRoot = resolve(input.repositoryRoot);
  const plan = envelope.plan;
  // All preflight checks precede the one credential lookup and the execution claim is one-shot.
  assertMemE0EffectAuthorization(plan, authorization);
  await assertCurrentSource(repositoryRoot, plan);
  await assertPreparedRoot(envelope);
  const fixture = await loadMemE0Fixture(repositoryRoot);
  const actorFixture = await loadMemE0ActorQualificationFixture(repositoryRoot);
  const current = await planMemE0LiveActorQualification({ repositoryRoot, ds0ObservationPath: envelope.ds0ObservationPath });
  if (current.plan.freeze.actorFreezeSha256 !== plan.qualification.freeze.actorFreezeSha256 ||
    sha256Canonical(fixture.cases.map((item) => item.definition.caseSha256)) !== plan.preflight.bindings.fixtureSha256 ||
    fixture.protocol.protocolSha256 !== plan.preflight.bindings.protocolSha256 ||
    memE0RawSha256(await readFile(join(repositoryRoot, GRANT))) !== plan.preflight.bindings.disclosurePolicySha256) throw new Error("effect execution freeze drifted");
  const modelEvidence = await loadMemE0ActorQualificationModelEvidence({ repositoryRoot, ds0ObservationPath: envelope.ds0ObservationPath, actorFixture });
  for (const prepared of plan.arms) {
    const loadedCase = fixture.cases.find((item) => item.definition.caseId === prepared.caseId)!;
    const armRoot = join(envelope.preparedRoot, `${prepared.caseId}-${prepared.arm}`);
    if (prepared.pairInvariantSha256 !== pairInvariant(loadedCase, plan.preflight) ||
      sha256Canonical(await manifest(join(armRoot, "workspace"))) !== sha256Canonical(prepared.initialFiles)) throw new Error("prepared effect arm drifted before authorization use");
    await readBoundJson(join(armRoot, "before.json"), prepared.beforeStateRawSha256);
    memE0EffectSeedSchema.parse(await readBoundJson(join(armRoot, "seed.json"), prepared.seedEnvelopeRawSha256));
  }
  await writeExclusiveJson(join(envelope.preparedRoot, "execution-claim.json"), authorization);
  const credential = dependencies.credential();
  if (credential === undefined || credential.length === 0) throw new Error("authorized effect credential is unavailable");
  const environment = { ...memE0VerifierEnvironment(process.env), DEEPSEEK_API_KEY: credential };
  const evidence: MemE0EffectArmEvidence[] = [];
  let stopReason: "completed" | "invalid_arm" | "baseline_only_regression" | "execution_failed" = "completed";
  for (const prepared of plan.arms) {
    const loadedCase = fixture.cases.find((item) => item.definition.caseId === prepared.caseId)!;
    const armRoot = join(envelope.preparedRoot, `${prepared.caseId}-${prepared.arm}`);
    const workspace = join(armRoot, "workspace");
    const stateRoot = join(armRoot, "state");
    const observation: MemE0EffectArmEvidence = {
      actor: null, arm: prepared.arm, caseId: prepared.caseId, changedPaths: [], failureSha256: null,
      finalManifestSha256: NIL, finalTargetSha256: NIL, hiddenVerifier: null, hostStateValid: false,
      pairInvariantSha256: prepared.pairInvariantSha256, publicVerifier: null, seedProcessId: prepared.seedProcessId,
      sourceStable: false, targetPath: loadedCase.definition.publicWorkspace.targetRelativePath,
      expectedHiddenImplementationSha256: loadedCase.definition.hiddenVerifier.implementationRawSha256,
      expectedHiddenStdoutSha256: loadedCase.definition.hiddenVerifier.successStdoutSha256,
      expectedPublicImplementationSha256: loadedCase.publicFiles.find((item) => item.path === "verify.mjs")!.rawSha256,
      verifierAfterActorExit: false,
    };
    try {
      await assertCurrentSource(repositoryRoot, plan);
      if (sha256Canonical(await manifest(workspace)) !== sha256Canonical(prepared.initialFiles)) {
        throw new Error("prepared effect arm changed while earlier arms were running");
      }
      const before = await readBoundJson(join(armRoot, "before.json"), prepared.beforeStateRawSha256) as MemE0WorkspaceBefore;
      const seed = memE0EffectSeedSchema.parse(await readBoundJson(join(armRoot, "seed.json"), prepared.seedEnvelopeRawSha256));
      observation.actor = memE0EffectActorObservationSchema.parse(await dependencies.child({
        actorInput: { freeze: plan.qualification.freeze,
          modelEvidence: { ...modelEvidence.descriptor, qualificationEvidenceRef: MODEL_RECORD, qualificationUsageCapability: "complete" },
          repositoryRoot, schemaVersion: 1, source: { ...plan.qualification.source, protectedPathsClean: true }, stateRoot, workspace },
        arm: prepared.arm, authorization, caseId: prepared.caseId, phase: "effect", plan, seed,
      }, armRoot, environment));
      const after = await observeMemE0WorkspaceAfter(loadedCase, before);
      const host = await inspectEffectHost(workspace, prepared, observation.actor.run.sessionEventSpanSha256);
      const byPath = new Map(host.actual.map((item) => [item.path, item.rawSha256]));
      observation.hostStateValid = host.hostValid && prepared.initialFiles.every((item) =>
        item.path === observation.targetPath || byPath.get(item.path) === item.rawSha256);
      observation.finalManifestSha256 = sha256Canonical(host.actual);
      observation.changedPaths = [...after.changedPaths];
      observation.finalTargetSha256 = after.finalTargetRawSha256;
      if (!observation.hostStateValid) throw new Error("effect workspace contains changed support files or invalid Host state");
      const [publicRun, hiddenRun] = await Promise.all([
        productionVerifierProcess({ executable: process.execPath, args: ["verify.mjs"], cwd: workspace }),
        productionVerifierProcess({ executable: process.execPath, args: [loadedCase.hiddenVerifierPath, workspace], cwd: loadedCase.directory }),
      ]);
      observation.verifierAfterActorExit = observation.actor.actorProcessId !== publicRun.processId &&
        observation.actor.actorProcessId !== hiddenRun.processId && publicRun.processId !== hiddenRun.processId;
      observation.publicVerifier = { argvIdentitySha256: sha256Canonical(["node", "verify.mjs"]),
        implementationRawSha256: observation.expectedPublicImplementationSha256,
        exitCode: publicRun.exitCode, stderrSha256: publicRun.stderrSha256, stdoutSha256: publicRun.stdoutSha256 };
      observation.hiddenVerifier = { argvIdentitySha256: loadedCase.definition.hiddenVerifier.argvIdentitySha256,
        implementationRawSha256: observation.expectedHiddenImplementationSha256,
        exitCode: hiddenRun.exitCode, stderrSha256: hiddenRun.stderrSha256, stdoutSha256: hiddenRun.stdoutSha256 };
      await assertCurrentSource(repositoryRoot, plan);
      observation.sourceStable = true;
    } catch (error) { observation.failureSha256 = failureHash(error); }
    evidence.push(observation);
    await writeExclusiveJson(join(armRoot, "effect-observation.json"), observation);
    const score = scoreMemE0LiveEffect(plan, evidence);
    if (!score.arms.at(-1)!.valid) { stopReason = observation.actor === null ? "execution_failed" : "invalid_arm"; break; }
    if (score.pairs.some((item) => item.outcome === "baseline_only_regression")) { stopReason = "baseline_only_regression"; break; }
  }
  const receipt = createMemE0LiveEffectReceipt({ authorization, evidence, evidenceClass: "agent_memory_task_effect_e2e",
    experimentId: "fal-mem-e0-agent-memory-task-effect-v1", plan, receiptType: "mem-e0-live-effect-receipt-v1", schemaVersion: 1, stopReason });
  await writeExclusiveJson(join(envelope.preparedRoot, "receipt.json"), receipt);
  return receipt;
}

export async function runMemE0LiveEffect(input: Readonly<{ repositoryRoot: string; envelope: unknown; authorization: unknown }>) {
  return await runUnsafe(input, productionDependencies());
}

/** Test seam cannot replace the production entry's dependencies. Never use its result as live evidence. */
export function createMemE0LiveEffectRunnerForTesting(dependencies: RunnerDependencies) {
  return async (input: Readonly<{ repositoryRoot: string; envelope: unknown; authorization: unknown }>) =>
    await runUnsafe(input, { ...dependencies, child: async (...args) => {
      const result = memE0EffectActorObservationSchema.parse(await dependencies.child(...args));
      return { ...result, actorClass: "offline_test" };
    } });
}
