import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createModelQualificationRecord } from "../../src/model/model-qualification-schema.js";
import { modelQualificationIdentitySha256 } from "../../src/model/model-qualification-identity.js";
import { ModelQualificationStore } from "../../src/model/model-qualification-store.js";
import { resolvePiModelQualificationTarget } from "../../src/model/model-qualification-target.js";
import { UserStateModelQualificationGate } from "../../src/model/user-state-model-qualification-gate.js";
import { loadRuntimePolicyRegistry } from "../../src/policy/policy-config-loader.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
} from "../../src/policy/policy-resolver.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function localTarget(workspace: string, state: string) {
  const env = { LOCALAPPDATA: state };
  const policy = resolveEffectiveRuntimePolicy(
    await loadRuntimePolicyRegistry({
      env,
      platform: "win32",
      workspace,
    }),
    undefined,
  );
  const request = resolveProviderPolicyRequest(policy, {
    model: "qwen3:1.7b",
    provider: "ollama",
  });
  const refresh = async () => [
    { digest: "a".repeat(64), tag: "qwen3:1.7b" },
  ];
  const target = await resolvePiModelQualificationTarget({
    endpoint: request.endpoint,
    model: request.model,
    policyProfileId: policy.entry.profile.id,
    policyProfileSha256: policy.evidence.profileSha256,
    provider: request.provider,
    refreshLocalModelCatalog: refresh,
  });
  return { env, refresh, target };
}

async function commitPlanOnlyEvidence(workspace: string, state: string): Promise<void> {
  const { env, target } = await localTarget(workspace, state);
  const identitySha256 = modelQualificationIdentitySha256(target.identity);
  const common = { code: "passed", durationMs: 1, status: "passed" as const };
  const record = createModelQualificationRecord({
    createdAt: "2026-07-31T00:00:00.000Z",
    identity: target.identity,
    identitySha256,
    probeResults: [
      { ...common, observed: { deltaCount: 1, terminalText: true }, probeId: "streaming_text_v1", requestCount: 0 },
      { ...common, observed: { argumentsStrict: true, callIdPresent: true, toolCallCount: 1 }, probeId: "strict_tool_args_v1", requestCount: 1 },
      { ...common, observed: { acknowledgementMatched: true, terminalText: true }, probeId: "tool_continuation_v1", requestCount: 1 },
      { code: "sequence_step_1_invalid", durationMs: 1, observed: { ordered: false, toolCallCount: 0 }, probeId: "sequential_tools_v1", requestCount: 1, status: "failed" },
      { ...common, observed: { abortObserved: true, cancelLatencyMs: 1, lateEventCount: 0 }, probeId: "cancellation_v1", requestCount: 1 },
      { ...common, observed: { availability: "complete" }, probeId: "usage_semantics_v1", requestCount: 0 },
    ],
    qualifiedModes: ["plan"],
    schemaVersion: 1,
    totalDurationMs: 4,
    totalRequestCount: 4,
  });
  const store = await ModelQualificationStore.create({ env, platform: "win32" });
  await store.commit(record);
}

describe("Phase 16E ordinary-run qualification gate", () => {
  it("allows exact Plan-only evidence and rejects Build before backend creation", async () => {
    const workspace = await temporaryRoot("bornagent-phase16e-gate-workspace-");
    const state = await temporaryRoot("bornagent-phase16e-gate-state-");
    await commitPlanOnlyEvidence(workspace, state);
    const { env, refresh } = await localTarget(workspace, state);
    const refreshLocalModelCatalog = vi.fn(refresh);
    const backend = new FakeStreamingChatClient(fixedStream(), {
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    const createModelBackend = vi.fn(() => backend);
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd: workspace,
      env,
      modelQualificationGate: new UserStateModelQualificationGate({
        env,
        platform: "win32",
        refreshLocalModelCatalog,
      }),
      refreshLocalModelCatalog,
    });

    const plan = createMemoryIO();
    expect(
      await runCli(
        ["agent", "Inspect only", "--mode", "plan", "--provider", "ollama", "--model", "qwen3:1.7b"],
        plan.io,
        runtime,
      ),
    ).toBe(8);
    expect(createModelBackend).toHaveBeenCalledOnce();

    const build = createMemoryIO();
    expect(
      await runCli(
        ["agent", "Try build", "--mode", "build", "--provider", "ollama", "--model", "qwen3:1.7b"],
        build.io,
        runtime,
      ),
    ).toBe(2);
    expect(build.readStderr()).toContain("does not cover build mode");
    expect(createModelBackend).toHaveBeenCalledOnce();
    expect(refreshLocalModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("rejects missing evidence before backend construction and never auto-runs probes", async () => {
    const workspace = await temporaryRoot("bornagent-phase16e-missing-workspace-");
    const state = await temporaryRoot("bornagent-phase16e-missing-state-");
    const { env, refresh } = await localTarget(workspace, state);
    const createModelBackend = vi.fn(() => {
      throw new Error("backend must remain unopened");
    });
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd: workspace,
      env,
      modelQualificationGate: new UserStateModelQualificationGate({
        env,
        platform: "win32",
        refreshLocalModelCatalog: refresh,
      }),
    });
    const memory = createMemoryIO();
    expect(
      await runCli(
        ["agent", "No hidden probe", "--mode", "plan", "--provider", "ollama", "--model", "qwen3:1.7b"],
        memory.io,
        runtime,
      ),
    ).toBe(2);
    expect(memory.readStderr()).toContain("model_unqualified");
    expect(createModelBackend).not.toHaveBeenCalled();
  });
});
