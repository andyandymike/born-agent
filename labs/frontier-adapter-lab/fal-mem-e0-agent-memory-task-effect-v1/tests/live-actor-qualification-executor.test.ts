import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../../../src/cli/types.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  disposeApplicationHostForStateRoot,
  executeAgentThroughApplicationService,
} from "../../../../src/control-plane/adapters/agent-cli-adapter.js";
import type { BackendCreationRequest } from "../../../../src/model/backend-factory.js";
import type { ModelEvent } from "../../../../src/model/model-events.js";
import { V2SessionWriter } from "../../../../src/sessions/v2-session-writer.js";
import { RestrictedToolRegistry } from "../../../../src/tools/restricted-tool-registry.js";
import { phase8NetworkActivityReport } from "../../../../tests/setup-network-tripwire.js";
import { loadMemE0ActorQualificationFixture } from "../src/actor-qualification-fixture.js";
import { MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE } from "../src/actor-qualification.js";
import { MemoryEffectApprovalBinding } from "../src/deterministic-memory-effect-backend.js";
import {
  assertExactMemE0QualificationBackendRequest,
  memE0ActorQualificationCommandOptions,
  memE0ActorQualificationEnvironment,
} from "../src/live-actor-qualification-executor.js";
import { createMemE0EffectToolRegistry } from "../src/production-memory-effect-actor.js";
import { createMemE0Workspace } from "../src/workspace.js";

it("carries explicit remote policy through Application Service, exact backend preflight, tools and AgentLoop without network", async () => {
  const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
  const root = await mkdtemp(join(tmpdir(), "mem-e0-executor-offline-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  const environment = memE0ActorQualificationEnvironment({
    // A test-owned sentinel, never a lookup of an ambient provider credential.
    DEEPSEEK_API_KEY: "mem-e0-offline-test-not-a-real-credential",
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
  }, stateRoot);
  const binding = new MemoryEffectApprovalBinding();
  const writers: V2SessionWriter[] = [];
  const backendRequests: BackendCreationRequest[] = [];
  let stderr = "";
  let toolRegistryCreated = 0;
  let offlineTurns = 0;
  let outgoingToolCatalogSha256: string | undefined;
  try {
    await createMemE0Workspace({ workspace, loadedCase: fixture.case });
    const base = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      approvalPromptOverride: { request: async () => "denied" },
      capabilityUserStateRoot: join(stateRoot, "capabilities"),
      cwd: workspace,
      delegationUserStateRoot: join(stateRoot, "delegations"),
      env: environment,
      execPath: process.execPath,
      killProcess: (id, signal) => process.kill(id, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-mem-e0-offline-regression",
      workerUserStateRoot: join(stateRoot, "workers"),
      worktreeUserStateRoot: join(stateRoot, "worktrees"),
    });
    const runtime: CliRuntime = {
      ...base,
      // This synthetic descriptor is only an in-process test dependency, not
      // a retained DS0 record or a qualification receipt eligible for live use.
      agentModelEvidence: () => ({
        backend: "deepseek",
        baseUrl: "https://api.deepseek.com",
        endpointScope: "remote_https",
        kind: "remote_live_qualified",
        model: fixture.config.provider.model,
        provider: "deepseek",
        qualificationCompletedRequestCount: 6,
        qualificationEvidenceKind: "model_capability_probe_suite",
        qualificationEvidenceRef: ".bornagent/mem-e0/model-qualification-record.json",
        qualificationEvidenceSha256: "a".repeat(64),
        qualificationRequestCount: 6,
        qualificationStatus: "passed",
        qualificationUsageCapability: "complete",
        remoteBillableRequests: 6,
        remoteQualificationRequests: 6,
        requestCountScope: "qualification_only",
      }),
      createAgentToolRegistry: async (options) => {
        toolRegistryCreated += 1;
        return new RestrictedToolRegistry(await createMemE0EffectToolRegistry({
          approvalBinding: binding,
          effectBinding: {
            publicVerifierRawSha256: fixture.config.fixture.case.publicVerifierRawSha256,
            targetRelativePath: fixture.config.fixture.case.targetRelativePath,
          },
          environment,
          options,
        }), MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE);
      },
      createModelBackend: (request) => {
        backendRequests.push(request);
        assertExactMemE0QualificationBackendRequest(request, fixture);
        const backend = base.createModelBackend(request);
        // Keep the production factory, catalog, capability checks and request
        // preparer. Stop at runTurn with a deterministic failure: no transport.
        return {
          capabilities: backend.capabilities,
          contextCapacity: backend.contextCapacity!,
          identity: backend.identity,
          prepareTurnRequest: (turn) => backend.prepareTurnRequest!(turn),
          resume: backend.resume,
          runTurn: async function* (turn): AsyncIterable<ModelEvent> {
            offlineTurns += 1;
            outgoingToolCatalogSha256 = sha256Canonical(turn.tools);
            yield {
              error: {
                category: "protocol",
                code: "mem_e0_offline_boundary_stop",
                message: "Offline test stopped before provider transport.",
                retryable: false,
              },
              type: "failed",
            };
          },
        };
      },
      observeSessionWriter: (writer) => {
        if (!(writer instanceof V2SessionWriter)) throw new Error("expected real V2 writer");
        writers.push(writer);
      },
    };
    const exitCode = await executeAgentThroughApplicationService(
      memE0ActorQualificationCommandOptions(fixture), runtime,
      { stdout: { write: () => undefined }, stderr: { write: (value) => { stderr += value; } } },
    );
    // Do not print raw diagnostics, session identifiers or temp paths on failure.
    const diagnosticSha256 = createHash("sha256").update(stderr).digest("hex");
    expect({ exitCode, offlineTurns, toolRegistryCreated }, diagnosticSha256).toEqual({
      exitCode: 5, offlineTurns: 1, toolRegistryCreated: 1,
    });
    expect(backendRequests.length).toBe(1);
    expect(backendRequests[0]?.transportScope).toBe("provider_network");
    expect(outgoingToolCatalogSha256).toBe(fixture.config.actor.toolCatalogSha256);
    expect(writers.length).toBe(1);
    const events = writers[0]!.events;
    const start = events.find((event) => event.scope === "run" && event.type === "run.started");
    expect(start?.data.application_commit?.action_kind).toBe("session.message.submit");
    expect(events.some((event) => event.type === "agent.step.started")).toBe(true);
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
    expect(phase8NetworkActivityReport()).toMatchObject({
      billableRequestCount: 0, blockedRemoteAttemptCount: 0, openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 0, remoteProviderRequestCount: 0, remoteSocketAttemptCount: 0,
    });

    // The fix supplies the missing evidence; it does not relax exact matching.
    const exact = backendRequests[0]!;
    const { transportScope: _scope, ...missingScope } = exact;
    const { runtimePolicy: _policy, ...missingPolicy } = exact;
    void _scope;
    void _policy;
    for (const invalid of [
      missingScope,
      missingPolicy,
      { ...exact, transportScope: "in_process_contract" as const },
      { ...exact, endpoint: "https://example.invalid" },
      { ...exact, model: "different-model" },
      { ...exact, provider: "openai" },
      {
        ...exact,
        runtimePolicy: {
          ...exact.runtimePolicy!,
          evidence: { ...exact.runtimePolicy!.evidence, profileSha256: "b".repeat(64) },
        },
      },
    ]) {
      expect(() => assertExactMemE0QualificationBackendRequest(invalid, fixture)).toThrow(/drifted/u);
    }
  } finally {
    await disposeApplicationHostForStateRoot(stateRoot);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
