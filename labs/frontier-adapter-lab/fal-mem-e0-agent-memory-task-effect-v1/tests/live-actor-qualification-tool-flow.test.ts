import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { expect, it } from "vitest";

import { createNodeRuntime } from "../../../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../../../src/cli/types.js";
import {
  disposeApplicationHostForStateRoot,
  executeAgentThroughApplicationService,
} from "../../../../src/control-plane/adapters/agent-cli-adapter.js";
import { BackendFactory } from "../../../../src/model/backend-factory.js";
import {
  ProductionPiRuntimePort,
  type PiRuntimeDriver,
  type PiSdkAssistantMessage,
  type PiSdkContext,
  type PiSdkToolCall,
} from "../../../../src/providers/pi/production-pi-runtime-port.js";
import { CredentialResolver } from "../../../../src/security/credential-resolver.js";
import { V2SessionWriter } from "../../../../src/sessions/v2-session-writer.js";
import { RestrictedToolRegistry } from "../../../../src/tools/restricted-tool-registry.js";
import { phase8NetworkActivityReport } from "../../../../tests/setup-network-tripwire.js";
import { loadMemE0ActorQualificationFixture } from "../src/actor-qualification-fixture.js";
import { MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE } from "../src/actor-qualification.js";
import { MemoryEffectApprovalBinding } from "../src/deterministic-memory-effect-backend.js";
import {
  assertExactMemE0QualificationBackendRequest,
  MemE0LiveExactApprovalPrompt,
  memE0ActorQualificationCommandOptions,
  memE0ActorQualificationEnvironment,
} from "../src/live-actor-qualification-executor.js";
import { createMemE0EffectToolRegistry } from "../src/production-memory-effect-actor.js";
import { inspectMemE0QualificationWorkspaceManifest } from "../src/live-actor-qualification-runner.js";
import { memE0QualificationSessionSpanSha256 } from "../src/qualification-host-state.js";
import { createMemE0Workspace } from "../src/workspace.js";

async function workspaceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await workspaceFiles(root, path));
    else files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

it("finishes the exact four-tool production flow without provider transport or workspace state leakage", async () => {
  const fixture = await loadMemE0ActorQualificationFixture(resolve("."));
  const root = await mkdtemp(join(tmpdir(), "mem-e0-tool-flow-offline-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  const target = fixture.config.fixture.case.targetRelativePath;
  const environment = memE0ActorQualificationEnvironment({
    DEEPSEEK_API_KEY: "mem-e0-offline-test-not-a-real-credential",
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
  }, stateRoot);
  const binding = new MemoryEffectApprovalBinding();
  const approvals = new MemE0LiveExactApprovalPrompt(binding, target);
  const writers: V2SessionWriter[] = [];
  const contexts: PiSdkContext[] = [];
  let registry: RestrictedToolRegistry | undefined;
  let stderr = "";
  try {
    const before = await createMemE0Workspace({ workspace, loadedCase: fixture.case });
    // Test-owned support bytes, not DS0 evidence and never eligible for a live receipt.
    const supportPath = ".bornagent/mem-e0/model-qualification-record.json";
    await mkdir(join(workspace, ".bornagent", "mem-e0"), { recursive: true });
    await writeFile(join(workspace, supportPath), "{\"offlineSentinel\":true}\n", { flag: "wx" });
    const calls: readonly PiSdkToolCall[] = [
      { type: "toolCall", id: "offline_read", name: "read_file", arguments: {
        path: target, start_line: null, end_line: null,
      } },
      { type: "toolCall", id: "offline_patch", name: "apply_patch", arguments: {
        patch: [
          `diff --git a/${target} b/${target}`,
          `--- a/${target}`, `+++ b/${target}`, "@@ -1,3 +1,3 @@",
          " export function harmControlMarker() {", '-  return "UNIMPLEMENTED";',
          '+  return "HARM_PUBLIC_214";', " }", "",
        ].join("\n"),
      } },
      { type: "toolCall", id: "offline_verify", name: "run_command", arguments: {
        executable: "node", args: ["verify.mjs"], cwd: ".", purpose: "verify", timeout_ms: 30_000,
      } },
      { type: "toolCall", id: "offline_finish", name: "finish_task", arguments: {
        status: "completed", summary: "The public verifier passed after the bounded patch.",
      } },
    ];
    const driver: PiRuntimeDriver = {
      model: {
        api: "openai-completions", baseUrl: "https://api.deepseek.com", contextWindow: 1_000_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: fixture.config.provider.model, input: ["text"], maxTokens: 2_048,
        name: "offline-contract-only", provider: "deepseek", reasoning: false,
      },
      stream: async function* (context, options) {
        const call = calls[contexts.length];
        if (call === undefined) throw new Error("offline script exceeded the frozen four turns");
        contexts.push(context);
        expect(options.maxRetries).toBe(0);
        expect(context.tools?.map((tool) => tool.name).sort()).toEqual([...MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE].sort());
        const message: PiSdkAssistantMessage = {
          api: "openai-completions", content: [call], model: fixture.config.provider.model,
          provider: "deepseek", role: "assistant", stopReason: "toolUse", timestamp: 1,
          usage: { cacheRead: 0, cacheWrite: 0, input: 100, output: 20, totalTokens: 120,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 } },
        };
        yield { type: "start", partial: message };
        yield { type: "toolcall_start", contentIndex: 0, partial: message };
        yield { type: "toolcall_delta", contentIndex: 0, partial: message, delta: JSON.stringify(call.arguments) };
        yield { type: "toolcall_end", contentIndex: 0, partial: message, toolCall: call };
        yield { type: "done", message, reason: "toolUse" };
      },
    };
    const factory = new BackendFactory({
      credentialResolver: new CredentialResolver(environment),
      runtimeFactory: ({ credential, endpoint, maximumOutputTokens, model, providerAccessPolicy }) =>
        new ProductionPiRuntimePort({
          baseUrl: endpoint!, credential: credential!.reveal(), maximumOutputTokens: maximumOutputTokens!,
          model: model.modelId, provider: model.provider, providerAccessPolicy: providerAccessPolicy!,
        }, async () => driver),
    });
    const base = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      approvalPromptOverride: approvals,
      capabilityUserStateRoot: join(stateRoot, "capabilities"), cwd: workspace,
      delegationUserStateRoot: join(stateRoot, "delegations"), env: environment,
      execPath: process.execPath, killProcess: (id, signal) => process.kill(id, signal),
      nodeVersion: process.versions.node, onCancel: () => () => undefined,
      platform: process.platform, version: "0.0.0-mem-e0-offline-regression",
      workerUserStateRoot: join(stateRoot, "workers"), worktreeUserStateRoot: join(stateRoot, "worktrees"),
    });
    const runtime: CliRuntime = {
      ...base,
      agentModelEvidence: () => ({
        backend: "deepseek", baseUrl: "https://api.deepseek.com", endpointScope: "remote_https",
        kind: "remote_live_qualified", model: fixture.config.provider.model, provider: "deepseek",
        qualificationCompletedRequestCount: 6, qualificationEvidenceKind: "model_capability_probe_suite",
        qualificationEvidenceRef: supportPath, qualificationEvidenceSha256: "a".repeat(64),
        qualificationRequestCount: 6, qualificationStatus: "passed", qualificationUsageCapability: "complete",
        remoteBillableRequests: 6, remoteQualificationRequests: 6, requestCountScope: "qualification_only",
      }),
      createAgentToolRegistry: async (options) => {
        registry = new RestrictedToolRegistry(await createMemE0EffectToolRegistry({
          approvalBinding: binding,
          effectBinding: { publicVerifierRawSha256: fixture.config.fixture.case.publicVerifierRawSha256, targetRelativePath: target },
          environment, options,
        }), MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE);
        return registry;
      },
      createModelBackend: (request) => {
        assertExactMemE0QualificationBackendRequest(request, fixture);
        return factory.create(request);
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
    await disposeApplicationHostForStateRoot(stateRoot);
    const events = writers[0]!.events;
    const diagnostic = {
      exitCode, turns: contexts.length, stderrSha256: createHash("sha256").update(stderr).digest("hex"),
      toolResults: events.filter((event) => event.type === "tool.call.completed").map((event) => event.data.status),
      toolErrors: events.filter((event) => event.type === "tool.call.completed").map((event) => event.data.error_code ?? null),
    };
    expect(diagnostic, JSON.stringify(diagnostic)).toMatchObject({ exitCode: 0, turns: 4, toolResults: ["success", "success", "success", "success"] });
    expect(events.filter((event) => event.type === "tool.call.requested").map((event) => event.data.tool_name))
      .toEqual(MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE);
    expect(approvals.observations().map((value) => value.decision)).toEqual(["approved", "approved"]);
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    for (const name of ["search", "list_files"]) {
      expect(await registry!.execute({ name, argumentsJson: "{}", callId: "unavailable-tool-counterfactual", step: 1 }, new AbortController().signal))
        .toMatchObject({ ok: false, error: { code: "delegated_tool_not_allowed" } });
    }
    expect(await readFile(join(workspace, target), "utf8")).toContain('return "HARM_PUBLIC_214";');
    const manifestInput = {
      actorFixture: fixture,
      before,
      recordRawSha256: createHash("sha256").update('{"offlineSentinel":true}\n').digest("hex"),
      expectedSessionEventSpanSha256: memE0QualificationSessionSpanSha256(events.filter((event) => event.scope === "run")),
    };
    const inspect = () => inspectMemE0QualificationWorkspaceManifest(manifestInput);
    expect(await inspect()).toMatchObject({ exactFileSet: true, supportRecordUnchanged: true, unchangedPublicFilesStable: true });
    expect(await inspectMemE0QualificationWorkspaceManifest({
      ...manifestInput, expectedSessionEventSpanSha256: "0".repeat(64),
    })).toMatchObject({ exactFileSet: false });

    // Never ignore an entire .bornagent subtree. Valid-looking but unowned
    // artifacts, unknown cache files and extra public files must all fail.
    const files = await workspaceFiles(workspace);
    const objectPath = files.find((path) => /\/objects\/[a-f0-9]{64}$/u.test(path))!;
    const orphanBytes = Buffer.from("unreferenced public synthetic object\n");
    const orphanSha256 = createHash("sha256").update(orphanBytes).digest("hex");
    const orphanPath = objectPath.replace(/[a-f0-9]{64}$/u, orphanSha256);
    for (const extra of ["src/extra.mjs", ".bornagent/extra.json", ".bornagent/cache/unexpected.key", orphanPath]) {
      await writeFile(join(workspace, extra), orphanBytes, { flag: "wx" });
      if (extra === orphanPath) {
        await writeFile(join(workspace, `${extra}.meta.json`), JSON.stringify({ bytes: orphanBytes.length, schema_version: 1, sha256: orphanSha256 }), { flag: "wx" });
      }
      expect((await inspect()).exactFileSet, "unexpected file must fail closed").toBe(false);
      await rm(join(workspace, extra));
      if (extra === orphanPath) await rm(join(workspace, `${extra}.meta.json`));
    }
    const sessionPath = files.find((path) => path.startsWith(".bornagent/sessions/"))!;
    for (const changed of [objectPath, `${objectPath}.meta.json`, sessionPath, ".bornagent/cache/repository-intelligence/navigation-integrity.key"]) {
      const original = await readFile(join(workspace, changed));
      await writeFile(join(workspace, changed), "tampered\n");
      expect((await inspect()).exactFileSet, "corrupt Host state must fail closed").toBe(false);
      await writeFile(join(workspace, changed), original);
    }
    const metadataOriginal = await readFile(join(workspace, `${objectPath}.meta.json`));
    await rm(join(workspace, `${objectPath}.meta.json`));
    expect((await inspect()).exactFileSet).toBe(false);
    await writeFile(join(workspace, `${objectPath}.meta.json`), metadataOriginal);
    await writeFile(join(workspace, supportPath), "tampered\n");
    expect((await inspect()).supportRecordUnchanged).toBe(false);
    await writeFile(join(workspace, supportPath), '{"offlineSentinel":true}\n');
    const publicVerifier = await readFile(join(workspace, "verify.mjs"));
    await writeFile(join(workspace, "verify.mjs"), "tampered\n");
    expect((await inspect()).unchangedPublicFilesStable).toBe(false);
    await writeFile(join(workspace, "verify.mjs"), publicVerifier);
    expect(await inspect()).toMatchObject({ exactFileSet: true, supportRecordUnchanged: true, unchangedPublicFilesStable: true });
    expect(contexts.every((context) => context.systemPrompt?.includes("Use only tools in the current tool catalog"))).toBe(true);
    expect(phase8NetworkActivityReport()).toMatchObject({
      billableRequestCount: 0, blockedRemoteAttemptCount: 0, openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 0, remoteProviderRequestCount: 0, remoteSocketAttemptCount: 0,
    });
  } finally {
    await disposeApplicationHostForStateRoot(stateRoot);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
