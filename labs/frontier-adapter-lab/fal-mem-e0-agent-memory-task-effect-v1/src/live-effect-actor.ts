import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { disposeApplicationHostForStateRoot, planeForRuntime } from "../../../../src/control-plane/adapters/agent-cli-adapter.js";
import { memoryRecordSourceReferenceSha256 } from "../../../../src/memory/core/memory-record-v1.js";
import { renderHistoricalMemoryExcerptV1 } from "../../../../src/memory/recall/automatic-memory-recall-service.js";
import {
  createPublicSyntheticRemoteMemoryGrantV1,
  publicSyntheticRemoteMemoryTaskSha256,
} from "../../../../src/memory/recall/public-synthetic-remote-memory-grant.js";
import { SqliteEpisodeStore } from "../../../../src/memory/store/sqlite-episode-store.js";
import { MEM_E0_CASE_IDS, loadMemE0Fixture, memE0RawSha256 } from "./fixture.js";
import {
  memE0ActorQualificationEnvironment, parseMemE0LiveActorQualificationInput,
  runMemE0ProductionActor, type MemE0LiveActorQualificationInput,
} from "./live-actor-qualification-executor.js";
import {
  memE0EffectActorObservationSchema, memE0EffectAuthorizationSchema,
  memE0EffectRecallSchema, memE0EffectSeedSchema, memE0PreparedEffectPlanSchema,
  type MemE0EffectAuthorization, type MemE0PreparedEffectPlan,
} from "./live-effect-contract.js";
import { evaluateMemE0LivePreflight } from "./live-preflight.js";
import { runProductionMemoryEffectActor } from "./production-memory-effect-actor.js";

const location = z.string().min(1).max(2_048).refine(isAbsolute);
const seedInput = z.object({
  caseId: z.enum(MEM_E0_CASE_IDS), phase: z.literal("seed"), repositoryRoot: location,
  stateRoot: location, workspace: location,
}).strict();
const effectInput = z.object({
  actorInput: z.unknown(), arm: z.enum(["off", "on"]), authorization: memE0EffectAuthorizationSchema,
  caseId: z.enum(MEM_E0_CASE_IDS), phase: z.literal("effect"), plan: memE0PreparedEffectPlanSchema,
  seed: memE0EffectSeedSchema,
}).strict();
export type MemE0EffectChildInput = z.infer<typeof seedInput> | (Omit<z.infer<typeof effectInput>, "actorInput"> & {
  actorInput: MemE0LiveActorQualificationInput;
});

export function assertMemE0EffectAuthorization(plan: MemE0PreparedEffectPlan, authorization: MemE0EffectAuthorization): void {
  if (authorization.planSha256Confirmation !== plan.planSha256) throw new Error("effect authorization does not bind this prepared batch");
  const old = plan.preflight;
  const decision = evaluateMemE0LivePreflight(old, plan.qualification, {
    authorizeRemote: true,
    actorQualificationReceiptSha256Confirmation: old.bindings.actorQualificationReceiptSha256,
    disclosurePolicySha256Confirmation: old.bindings.disclosurePolicySha256,
    fixtureSha256Confirmation: old.bindings.fixtureSha256,
    maximumEstimatedCostUsdMicros: authorization.maximumEstimatedCostUsdMicros,
    pricingSnapshotSha256Confirmation: old.pricing.pricingSha256,
    protectedTreeSha256Confirmation: old.bindings.protectedTreeSha256,
    protocolSha256Confirmation: old.bindings.protocolSha256,
    sourceCommitConfirmation: old.bindings.sourceCommit,
  });
  if (!decision.providerCallsAuthorized) throw new Error("effect batch requires a passed exact-source actor qualification and separate authorization");
}

function assertDisjoint(repositoryRoot: string, workspace: string, stateRoot: string): void {
  const paths = [repositoryRoot, workspace, stateRoot].map((path) => resolve(path));
  for (let i = 0; i < paths.length; i += 1) for (let j = 0; j < paths.length; j += 1) {
    if (i === j) continue;
    const nested = relative(paths[i]!, paths[j]!);
    if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) throw new Error("effect roots must be disjoint");
  }
}

async function seed(input: z.infer<typeof seedInput>) {
  assertDisjoint(input.repositoryRoot, input.workspace, input.stateRoot);
  const fixture = await loadMemE0Fixture(input.repositoryRoot);
  const loadedCase = fixture.cases.find((item) => item.definition.caseId === input.caseId)!;
  const observed = await runProductionMemoryEffectActor({
    effectBinding: null, memoryKind: loadedCase.definition.memory.kind, memoryMode: "local",
    phase: "seed", schemaVersion: 1, stateRoot: input.stateRoot,
    task: loadedCase.definition.memory.recordText, workspace: input.workspace,
  });
  if (observed.agentExitCode !== 0 || observed.explicitRememberExitCode !== 0 || observed.explicitRememberStatus !== "added" ||
    observed.providerNetworkRequests !== 0 || observed.explicitMemoryLogicalSha256 !== loadedCase.definition.memory.recordLogicalSha256) {
    throw new Error("effect seed did not admit the frozen memory through the product command");
  }
  // Reopen the admitted record, never synthesize a record or write the store directly.
  const runtime = createNodeRuntime({
    approvalInput: { interactive: false, readLine: async () => null },
    cwd: input.workspace, env: memE0ActorQualificationEnvironment({
      PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    }, input.stateRoot), execPath: process.execPath,
    killProcess: (id, signal) => process.kill(id, signal),
    nodeVersion: process.versions.node, onCancel: () => () => undefined,
    platform: process.platform, version: "0.0.0-mem-e0-seed",
  });
  const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined } };
  try {
    const plane = await planeForRuntime(runtime, io);
    const preview = await plane.repositories.previewRoot(input.workspace);
    const matches = (await plane.repositories.list()).filter((item) => item.status === "active" &&
      item.canonicalRootIdentitySha256 === preview.canonicalRootIdentitySha256);
    if (matches.length !== 1) throw new Error("effect seed repository scope is ambiguous");
    const scope = { applicationRepositoryId: matches[0]!.repositoryId,
      canonicalRootIdentitySha256: preview.canonicalRootIdentitySha256, ownerPrincipalId: plane.authority.localOwner.principalId };
    const store = await SqliteEpisodeStore.create({ stateRoot: input.stateRoot });
    try {
      const page = await store.listActiveRecords({ limit: 10, scope });
      const explicit = page.items.filter((item) => item.kind !== "episode");
      if (explicit.length !== 1 || explicit[0]!.recordSha256 !== observed.explicitMemoryRecordSha256) throw new Error("effect seed readback differs from admission");
      return memE0EffectSeedSchema.parse({ observationSha256: sha256Canonical(observed), processId: process.pid,
        record: explicit[0], schemaVersion: 1 });
    } finally { store.close(); }
  } finally { await disposeApplicationHostForStateRoot(input.stateRoot); }
}

async function effect(raw: z.infer<typeof effectInput>, runActor = runMemE0ProductionActor, offlineTestOnly = false) {
  const actorInput = parseMemE0LiveActorQualificationInput(raw.actorInput);
  assertDisjoint(actorInput.repositoryRoot, actorInput.workspace, actorInput.stateRoot);
  assertMemE0EffectAuthorization(raw.plan, raw.authorization);
  if (sha256Canonical(actorInput.source) !== sha256Canonical(raw.plan.qualification.source) ||
    actorInput.freeze.actorFreezeSha256 !== raw.plan.qualification.freeze.actorFreezeSha256) {
    throw new Error("effect actor input differs from the qualified source and actor freeze");
  }
  const fixture = await loadMemE0Fixture(actorInput.repositoryRoot);
  const loadedCase = fixture.cases.find((item) => item.definition.caseId === raw.caseId)!;
  const prepared = raw.plan.arms.find((item) => item.caseId === raw.caseId && item.arm === raw.arm)!;
  const record = raw.seed.record;
  const logical = sha256Canonical({ disclosureClass: "public_synthetic", kind: record.kind, text: record.text });
  const excerpt = renderHistoricalMemoryExcerptV1(record);
  if (raw.seed.observationSha256 !== prepared.seedObservationSha256 || raw.seed.processId !== prepared.seedProcessId ||
    prepared.recordLogicalSha256 !== logical || logical !== loadedCase.definition.memory.recordLogicalSha256 ||
    prepared.disclosure.recordId !== record.recordId || prepared.disclosure.recordSha256 !== record.recordSha256 ||
    prepared.disclosure.excerptContentSha256 !== memE0RawSha256(excerpt) ||
    prepared.disclosure.sourceReferenceSha256 !== memoryRecordSourceReferenceSha256(record)) {
    throw new Error("effect disclosure changed after preparation");
  }
  const store = await SqliteEpisodeStore.create({ stateRoot: actorInput.stateRoot });
  try {
    const active = await store.getActiveRecord({ recordId: record.recordId, scope: record.scope });
    if (active?.recordSha256 !== record.recordSha256) throw new Error("prepared memory is no longer active at its exact scope");
  } finally { store.close(); }
  let grantSha256: string | null = null;
  const recall: z.infer<typeof memE0EffectRecallSchema>[] = [];
  const output = await runActor(actorInput, {
    disclosure: prepared.disclosure, loadedCase, memoryMode: raw.arm === "on" ? "local" : "off",
    pairInvariantSha256: prepared.pairInvariantSha256,
    createGrant: async (request) => {
      if (request.repositoryId !== record.scope.applicationRepositoryId ||
        request.canonicalRootIdentitySha256 !== record.scope.canonicalRootIdentitySha256 ||
        request.ownerPrincipalId !== record.scope.ownerPrincipalId || request.provider !== "deepseek" ||
        request.model !== raw.plan.preflight.model || request.task !== loadedCase.definition.task.text) {
        throw new Error("effect grant request changed repository, owner, model or task");
      }
      const grant = createPublicSyntheticRemoteMemoryGrantV1({
        allowedRecords: [prepared.disclosure], authorizationRefSha256: sha256Canonical(raw.authorization),
        canonicalRootIdentitySha256: request.canonicalRootIdentitySha256, maximumSelectedRecords: 1,
        model: request.model, ownerPrincipalId: request.ownerPrincipalId, policyProfileId: request.policyProfileId!,
        provider: "deepseek", purpose: "fal_mem_e0_public_synthetic_effect_eval", repositoryId: request.repositoryId,
        runId: request.runId, schemaVersion: 1, sessionId: request.sessionId,
        taskSha256: publicSyntheticRemoteMemoryTaskSha256(request.task), transportScope: "provider_network",
      });
      grantSha256 = grant.grantSha256;
      return grant;
    },
    observeRequest: (request) => {
      const canonical = request.canonicalContext;
      if (canonical === undefined || request.contextPlan === undefined) throw new Error("effect request has no canonical context evidence");
      const decoded = JSON.parse(canonical.text) as { items: { kind: string; metadata?: { recall_selection_sha256?: string } }[] };
      const historical = decoded.items.filter((item) => item.kind === "historical_memory");
      recall.push(memE0EffectRecallSchema.parse({ canonicalContextSha256: canonical.sha256,
        contextPlanSha256: sha256Canonical(request.contextPlan), historicalItemCount: historical.length,
        recallSelectionSha256: historical[0]?.metadata?.recall_selection_sha256 ?? null }));
    },
  });
  const { actorProcessId, providerUsage, run, schemaVersion } = output;
  return memE0EffectActorObservationSchema.parse({ actorProcessId, providerUsage, run, schemaVersion,
    actorClass: offlineTestOnly ? "offline_test" : "production_live", grantSha256, recall });
}

export async function runMemE0EffectChild(value: unknown) {
  const parsed = z.discriminatedUnion("phase", [seedInput, effectInput]).parse(value);
  return parsed.phase === "seed" ? await seed(parsed) : await effect(parsed);
}

export function createMemE0EffectActorForTesting(runActor: typeof runMemE0ProductionActor) {
  return async (value: unknown) => await effect(effectInput.parse(value), runActor, true);
}
