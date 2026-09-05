import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { memoryRecordSourceReferenceSha256 } from "../../../../src/memory/core/memory-record-v1.js";
import { renderHistoricalMemoryExcerptV1 } from "../../../../src/memory/recall/automatic-memory-recall-service.js";
import { BackendFactory } from "../../../../src/model/backend-factory.js";
import { ProductionPiRuntimePort, type PiRuntimeDriver, type PiSdkAssistantMessage, type PiSdkToolCall } from "../../../../src/providers/pi/production-pi-runtime-port.js";
import { CredentialResolver } from "../../../../src/security/credential-resolver.js";
import { phase8NetworkActivityReport } from "../../../../tests/setup-network-tripwire.js";
import { loadMemE0ActorQualificationFixture } from "../src/actor-qualification-fixture.js";
import { observeMemE0ActorQualificationSource } from "../src/actor-qualification-source.js";
import { createMemE0ActorQualificationFreeze, createMemE0ActorQualificationReceipt } from "../src/actor-qualification.js";
import { loadMemE0Fixture, memE0RawSha256 } from "../src/fixture.js";
import { createMemE0ProductionActorForTesting, memE0ActorQualificationAdapterConfigSha256 } from "../src/live-actor-qualification-executor.js";
import { listWorkspaceFiles } from "../src/live-actor-qualification-runner.js";
import { createMemE0EffectActorForTesting } from "../src/live-effect-actor.js";
import { memE0EffectSeedSchema, sealMemE0PreparedEffectPlan, type MemE0PreparedEffectArm } from "../src/live-effect-contract.js";
import { inspectEffectHost } from "../src/live-effect-runner.js";
import {
  createMemE0LivePlan,
  createMemE0LivePricingSnapshot,
  MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
} from "../src/live-preflight.js";
import { createMemE0Workspace, memE0VerifierEnvironment, runMemE0HiddenVerifier } from "../src/workspace.js";
import { qualificationCompletedInput } from "./effect-test-fixtures.js";

const execFileAsync = promisify(execFile);
const H = "a".repeat(64);

it("runs all eight real product seed/recall/tool paths with scripted PI responses and zero transport", async () => {
  const repositoryRoot = resolve(".");
  const root = await mkdtemp(join(tmpdir(), "mem-e0-effect-flow-offline-"));
  const fixture = await loadMemE0Fixture(repositoryRoot);
  const actorFixture = await loadMemE0ActorQualificationFixture(repositoryRoot);
  const observedSource = await observeMemE0ActorQualificationSource({ repositoryRoot });
  // Only the offline seam substitutes clean-source and prior DS0 validation.
  // The production entries offer neither substitution and the result stays offline_test.
  const source = { ...observedSource, implementationSha256s: [...observedSource.implementationSha256s], protectedPathsClean: true as const };
  const pricing = createMemE0LivePricingSnapshot();
  const defaults = qualificationCompletedInput();
  const freeze = createMemE0ActorQualificationFreeze({
    modelQualificationEvidenceSha256: defaults.freeze.modelQualificationEvidenceSha256,
    modelQualificationIdentitySha256: defaults.freeze.modelQualificationIdentitySha256,
    modelQualificationObservationSha256: defaults.freeze.modelQualificationObservationSha256,
    modelQualificationPricingSha256: defaults.freeze.modelQualificationPricingSha256,
    modelQualificationProtocolSha256: defaults.freeze.modelQualificationProtocolSha256,
    modelQualificationRecordSha256: defaults.freeze.modelQualificationRecordSha256,
    adapterConfigSha256: memE0ActorQualificationAdapterConfigSha256(actorFixture),
    policySha256: actorFixture.config.remotePolicy.profileSha256, pricingSha256: pricing.pricingSha256,
    productionPiRuntimeImplementationSha256: memE0RawSha256(await readFile(join(repositoryRoot, "src/providers/pi/production-pi-runtime-port.ts"))),
    qualificationFixtureSha256: actorFixture.config.fixture.fixtureBindingSha256, qualificationProtocolSha256: actorFixture.config.configSha256,
    systemInstructionSha256: memE0RawSha256(AGENT_SYSTEM_INSTRUCTIONS), toolCatalogSha256: actorFixture.config.actor.toolCatalogSha256,
  });
  const definition = actorFixture.config.fixture.case;
  const qualification = createMemE0ActorQualificationReceipt(qualificationCompletedInput({ freeze, source,
    task: { allowedChangedPaths: [definition.targetRelativePath], disclosureClass: "public_synthetic",
      hiddenVerifierSha256: definition.hiddenVerifierImplementationRawSha256, initialTargetSha256: definition.initialTargetRawSha256,
      initialWorkspaceManifestSha256: definition.publicWorkspaceManifestSha256, memoryMode: "off",
      publicVerifierSha256: definition.publicVerifierRawSha256, targetRelativePath: definition.targetRelativePath, taskSha256: definition.taskSha256 } }));
  expect(qualification.result.status).toBe("passed");
  const preflight = createMemE0LivePlan({ actorQualificationReceipt: qualification, disclosurePolicySha256: H,
    fixtureSha256: sha256Canonical(fixture.cases.map((item) => item.definition.caseSha256)), protocolSha256: fixture.protocol.protocolSha256 });
  const arms: MemE0PreparedEffectArm[] = [];
  const seeds: ReturnType<typeof memE0EffectSeedSchema.parse>[] = [];
  try {
    for (const loaded of fixture.cases) for (const arm of ["off", "on"] as const) {
      const armRoot = join(root, `${loaded.definition.caseId}-${arm}`);
      const workspace = join(armRoot, "workspace"); const stateRoot = join(armRoot, "state");
      await mkdir(join(stateRoot, "temp"), { recursive: true });
      const before = await createMemE0Workspace({ loadedCase: loaded, workspace });
      const inputPath = join(armRoot, "seed-input.json");
      await writeFile(inputPath, JSON.stringify({ caseId: loaded.definition.caseId, phase: "seed", repositoryRoot, stateRoot, workspace }), { flag: "wx" });
      const result = await execFileAsync(process.execPath, ["--no-warnings", "--import", import.meta.resolve("tsx"),
        join(repositoryRoot, "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-live-effect-child.ts"), inputPath], {
        cwd: repositoryRoot, env: memE0VerifierEnvironment(process.env), encoding: "utf8", timeout: 60_000, windowsHide: true,
      });
      expect(result.stderr).toBe("");
      const seed = memE0EffectSeedSchema.parse(JSON.parse(result.stdout));
      expect(seed.processId).not.toBe(process.pid);
      seeds.push(seed);
      await mkdir(join(workspace, ".bornagent", "mem-e0"), { recursive: true });
      await writeFile(join(workspace, ".bornagent/mem-e0/model-qualification-record.json"), '{"offlineSentinel":true}\n', { flag: "wx" });
      const record = seed.record;
      const initialFiles = await Promise.all((await listWorkspaceFiles(workspace)).map(async (path) => ({ path, rawSha256: memE0RawSha256(await readFile(join(workspace, path))) })));
      arms.push({ arm, caseId: loaded.definition.caseId, beforeStateRawSha256: H, seedEnvelopeRawSha256: H,
        disclosure: { disclosureClass: "public_synthetic", excerptContentSha256: memE0RawSha256(renderHistoricalMemoryExcerptV1(record)), recordId: record.recordId,
          recordSha256: record.recordSha256, sourceReferenceSha256: memoryRecordSourceReferenceSha256(record) }, initialFiles,
        initialPublicManifestSha256: before.publicManifestSha256, initialTargetSha256: before.initialTargetRawSha256,
        targetPath: loaded.definition.publicWorkspace.targetRelativePath, taskSha256: loaded.definition.task.taskSha256,
        hiddenVerifierSha256: loaded.definition.hiddenVerifier.implementationRawSha256, hiddenVerifierStdoutSha256: loaded.definition.hiddenVerifier.successStdoutSha256,
        hiddenVerifierArgvSha256: loaded.definition.hiddenVerifier.argvIdentitySha256, publicVerifierSha256: loaded.publicFiles.find((file) => file.path === "verify.mjs")!.rawSha256,
        pairInvariantSha256: loaded.definition.caseSha256, recordLogicalSha256: loaded.definition.memory.recordLogicalSha256,
        seedObservationSha256: seed.observationSha256, seedProcessId: seed.processId, stagedModelRecordRawSha256: memE0RawSha256('{"offlineSentinel":true}\n') });
    }
    const plan = sealMemE0PreparedEffectPlan({ arms, batchId: "12345678-1234-4234-8234-123456789abc", effectClaimAllowed: false,
      planType: "mem-e0-prepared-live-effect-plan-v1", preflight, providerCalls: 0, qualification, schemaVersion: 1 });
    vi.stubEnv("DEEPSEEK_API_KEY", "mem-e0-offline-test-not-a-real-key");
    const outcomes: boolean[] = [];
    for (const [index, prepared] of plan.arms.entries()) {
      const loaded = fixture.cases.find((item) => item.definition.caseId === prepared.caseId)!;
      const workspace = join(root, `${prepared.caseId}-${prepared.arm}`, "workspace");
      const stateRoot = join(root, `${prepared.caseId}-${prepared.arm}`, "state");
      const target = prepared.targetPath;
      const pass = prepared.arm === "on" || prepared.caseId === "mem-e0-harm-control";
      const lines = loaded.publicFiles.find((file) => file.path === target)!.content.trimEnd().split(/\r?\n/u);
      const value = loaded.definition.memory.requiredAcceptanceValue;
      const replacement = prepared.caseId === "mem-e0-retry-schedule" ? `  return Object.freeze([${value}]);` : `  return ${JSON.stringify(prepared.caseId === "mem-e0-harm-control" ? "HARM_PUBLIC_214" : value)};`;
      const calls: PiSdkToolCall[] = [{ type: "toolCall", id: "read", name: "read_file", arguments: { path: target, start_line: null, end_line: null } }];
      if (pass) calls.push(
        { type: "toolCall", id: "patch", name: "apply_patch", arguments: { patch: [`diff --git a/${target} b/${target}`, `--- a/${target}`, `+++ b/${target}`, "@@ -1,3 +1,3 @@", ` ${lines[0]}`, `-${lines[1]}`, `+${replacement}`, ` ${lines[2]}`, ""].join("\n") } },
        { type: "toolCall", id: "verify", name: "run_command", arguments: { executable: "node", args: ["verify.mjs"], cwd: ".", purpose: "verify", timeout_ms: 30_000 } },
      );
      calls.push({ type: "toolCall", id: "finish", name: "finish_task", arguments: { status: pass ? "completed" : "incomplete", summary: pass ? "Public smoke passed." : "The saved decision is unavailable." } });
      let turns = 0;
      let toolResults: unknown[] = [];
      const driver: PiRuntimeDriver = {
        model: { api: "openai-completions", baseUrl: "https://api.deepseek.com", contextWindow: 1_000_000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }, id: actorFixture.config.provider.model, input: ["text"], maxTokens: 2_048,
          name: "offline-effect-contract", provider: "deepseek", reasoning: false },
        stream: async function* (context) {
          toolResults = context.messages.filter((message) => message.role === "toolResult");
          const call = calls[turns++]; if (call === undefined) throw new Error("script exceeded the fixed sequence");
          expect(JSON.stringify(context).includes(seeds[index]!.record.recordId)).toBe(prepared.arm === "on");
          const message: PiSdkAssistantMessage = { api: "openai-completions", content: [call], model: actorFixture.config.provider.model,
            provider: "deepseek", role: "assistant", stopReason: "toolUse", timestamp: 1,
            usage: { cacheRead: 0, cacheWrite: 0, input: 100, output: 20, totalTokens: 120, cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 } } };
          yield { type: "start", partial: message }; yield { type: "toolcall_start", contentIndex: 0, partial: message };
          yield { type: "toolcall_delta", contentIndex: 0, partial: message, delta: JSON.stringify(call.arguments) };
          yield { type: "toolcall_end", contentIndex: 0, partial: message, toolCall: call };
          yield { type: "done", message, reason: "toolUse" };
        },
      };
      const factory = new BackendFactory({ credentialResolver: new CredentialResolver({ DEEPSEEK_API_KEY: "mem-e0-offline-test-not-a-real-key" }),
        runtimeFactory: ({ credential, endpoint, maximumOutputTokens, model, providerAccessPolicy }) => new ProductionPiRuntimePort({
          baseUrl: endpoint!, credential: credential!.reveal(), maximumOutputTokens: maximumOutputTokens!, model: model.modelId,
          provider: model.provider, providerAccessPolicy: providerAccessPolicy! }, async () => driver) });
      const run = createMemE0EffectActorForTesting(createMemE0ProductionActorForTesting({ observeSource: async () => source,
        validateModelRecord: async () => undefined,
        createRuntime: (options) => ({ ...createNodeRuntime(options), createModelBackend: (request) => factory.create(request) }) }));
      const observed = await run({ phase: "effect", caseId: prepared.caseId, arm: prepared.arm, plan, seed: seeds[index],
        authorization: { authorizeRemote: true, maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS, planSha256Confirmation: plan.planSha256, scope: "eight_attempt_effect_batch_only" },
        actorInput: { freeze, repositoryRoot, source, stateRoot, workspace, schemaVersion: 1,
          modelEvidence: { backend: "deepseek", baseUrl: "https://api.deepseek.com", endpointScope: "remote_https", kind: "remote_live_qualified",
            model: actorFixture.config.provider.model, provider: "deepseek", qualificationCompletedRequestCount: 6,
            qualificationEvidenceKind: "model_capability_probe_suite", qualificationEvidenceRef: ".bornagent/mem-e0/model-qualification-record.json",
            qualificationEvidenceSha256: freeze.modelQualificationEvidenceSha256, qualificationRequestCount: 6, qualificationStatus: "passed",
            qualificationUsageCapability: "complete", remoteBillableRequests: 6, remoteQualificationRequests: 6, requestCountScope: "qualification_only" } } });
      expect({ caseId: prepared.caseId, arm: prepared.arm, ...observed.run }).toMatchObject({ orchestrationFailure: false, applicationServiceObserved: true, agentLoopObserved: true });
      expect(observed.actorClass).toBe("offline_test");
      expect(observed.providerUsage.requestsStarted).toBe(pass ? 4 : 2);
      expect(observed.recall.every((entry) => entry.historicalItemCount === (prepared.arm === "on" ? 1 : 0))).toBe(true);
      expect(observed.grantSha256 === null).toBe(prepared.arm === "off");
      expect((await inspectEffectHost(workspace, prepared, observed.run.sessionEventSpanSha256)).hostValid).toBe(true);
      outcomes.push((await runMemE0HiddenVerifier(loaded, workspace)).passed);
      if (pass) expect(observed.run, JSON.stringify({ caseId: prepared.caseId, arm: prepared.arm, toolResults })).toMatchObject({ agentExitCode: 0, terminal: "verified_finish_task", toolSuccessCount: 4 });
    }
    expect(outcomes).toEqual([false, true, false, true, false, true, true, true]);
    expect(phase8NetworkActivityReport()).toMatchObject({ billableRequestCount: 0, blockedRemoteAttemptCount: 0,
      openedRemoteSocketCount: 0, remoteFetchAttemptCount: 0, remoteProviderRequestCount: 0, remoteSocketAttemptCount: 0 });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
