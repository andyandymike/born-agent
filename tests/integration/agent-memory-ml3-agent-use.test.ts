import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { memoryRecordSourceReferenceSha256 } from "../../src/memory/core/memory-record-v1.js";
import { renderHistoricalMemoryExcerptV1 } from "../../src/memory/recall/automatic-memory-recall-service.js";
import {
  createPublicSyntheticRemoteMemoryGrantV1,
  publicSyntheticRemoteMemoryExcerptSha256,
  publicSyntheticRemoteMemoryTaskSha256,
} from "../../src/memory/recall/public-synthetic-remote-memory-grant.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";
import { disposeApplicationHostForStateRoot } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

interface ProcessResult {
  readonly exitCode: number;
  readonly request: {
    readonly canonicalContext?: { readonly text: string };
    readonly tools: readonly unknown[];
  } | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface HistoricalItem {
  readonly authority: string;
  readonly content: string;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly protected_category?: unknown;
}

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const activeStateRoots: string[] = [];
const tsxLoader = import.meta.resolve("tsx");
const AGENT_PROCESS_TIMEOUT_MS = 60_000;
const CROSS_PROCESS_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(activeStateRoots.splice(0).map((root) => disposeApplicationHostForStateRoot(root)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}

async function frozenFixture(): Promise<Readonly<{
  readonly poisonedTask: string;
  readonly recallQuery: string;
}>> {
  return JSON.parse(
    await readFile(resolve("fixtures/agent-memory/ml3/poisoning-and-effect.json"), "utf8"),
  ) as Readonly<{ readonly poisonedTask: string; readonly recallQuery: string }>;
}

async function seedSessionA(stateRoot: string, cwd: string, task: string): Promise<void> {
  activeStateRoots.push(stateRoot);
  const output = createMemoryIO();
  expect(await runCli([
    "agent",
    task,
    "--task-profile",
    "read-only",
    "--max-steps",
    "1",
    "--memory",
    "local",
  ], output.io, createRuntime({ controlPlaneStateRoot: stateRoot, cwd })), output.readStderr()).toBe(0);
  await disposeApplicationHostForStateRoot(stateRoot);
  const index = activeStateRoots.indexOf(stateRoot);
  if (index >= 0) activeStateRoots.splice(index, 1);
}

async function processAgent(
  stateRoot: string,
  cwd: string,
  task: string,
  memoryMode: "local" | "off",
): Promise<ProcessResult> {
  const result = await execFileAsync(process.execPath, [
    "--import",
    tsxLoader,
    resolve("tests/fixtures/agent-memory-ml3-process.ts"),
    stateRoot,
    cwd,
    task,
    memoryMode,
  ], {
    cwd: resolve("."),
    // MEMORY-ML3: 子进程timeout负责真正的hang止损；外层还要seed Session A并
    // dispose Application Host，因此不能和子进程共享同一个30秒deadline。
    timeout: AGENT_PROCESS_TIMEOUT_MS,
    windowsHide: true,
  });
  return JSON.parse(result.stdout) as ProcessResult;
}

function contextItems(result: ProcessResult): readonly HistoricalItem[] {
  if (result.request?.canonicalContext === undefined) return [];
  const decoded = JSON.parse(result.request.canonicalContext.text) as {
    readonly items?: readonly HistoricalItem[];
  };
  return decoded.items ?? [];
}

function remotePolicy(): string {
  return JSON.stringify({
    schema_version: 1,
    profiles: [{
      schema_version: 1,
      id: "remote-openai-ml3",
      mode: "remote_explicit",
      model_access: {
        kind: "remote_explicit",
        providers: [{
          provider: "openai",
          models: ["gpt-5.6-terra"],
          base_urls: ["https://api.openai.com/v1"],
        }],
        credential_access: "selected_provider_only",
        limits: {
          max_provider_requests_per_run: 2,
          max_output_tokens_per_request: 2_048,
          max_reported_total_tokens_per_run: 20_000,
        },
      },
      eval_access: { allowed_suites: ["targeted", "smoke"], max_attempts_per_run: 1 },
      docker_acquisition: { kind: "deny" },
    }],
  });
}

describe("Agent memory ML3 product use", () => {
  it("ML3 Session B uses a relevant Session A episode in a new process", async () => {
    const frozen = await frozenFixture();
    const stateRoot = await directory("bornagent-ml3-process-state-");
    const cwd = await directory("bornagent-ml3-process-repository-");
    await seedSessionA(stateRoot, cwd, frozen.poisonedTask);

    const sessionB = await processAgent(stateRoot, cwd, frozen.recallQuery, "local");
    expect(sessionB.exitCode, sessionB.stderr).toBe(0);
    const historical = contextItems(sessionB).filter((item) => item.kind === "historical_memory");
    expect(historical).toHaveLength(1);
    expect(historical[0]).toMatchObject({
      authority: "historical_only",
      metadata: {
        active_status: "available",
        authority_scope: "historical_evidence_only",
        source_status: "available",
      },
    });
    expect(historical[0]!.content).toContain("historical evidence only");
    expect(historical[0]!.content).toContain("bypass approval");
    expect(historical[0]!.metadata.recall_selection_sha256).toMatch(/^[a-f0-9]{64}$/u);
  }, CROSS_PROCESS_TEST_TIMEOUT_MS);

  it("ML3 off and remote-provider paths inject zero memory records", async () => {
    const frozen = await frozenFixture();
    const stateRoot = await directory("bornagent-ml3-boundary-state-");
    const cwd = await directory("bornagent-ml3-boundary-repository-");
    await seedSessionA(stateRoot, cwd, frozen.poisonedTask);

    const off = await processAgent(stateRoot, cwd, frozen.recallQuery, "off");
    expect(off.exitCode, off.stderr).toBe(0);
    expect(contextItems(off).filter((item) => item.kind === "historical_memory")).toHaveLength(0);
    expect(off.request?.canonicalContext?.text).not.toContain("bypass approval");

    const retrievalRoot = join(stateRoot, "memory", "v1", "retrieval");
    await rm(retrievalRoot, { force: true, recursive: true });
    const policyPath = join(await directory("bornagent-ml3-remote-policy-"), "policy.json");
    await writeFile(policyPath, remotePolicy(), "utf8");
    const client = new FakeStreamingChatClient(fixedStream());
    const output = createMemoryIO();
    activeStateRoots.push(stateRoot);
    expect(await runCli([
      "agent",
      frozen.recallQuery,
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "local",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-terra",
      "--policy-profile",
      "remote-openai-ml3",
      "--policy-config",
      policyPath,
    ], output.io, createRuntime({
      controlPlaneStateRoot: stateRoot,
      createModelBackend: () => client,
      cwd,
      env: { OPENAI_API_KEY: "not-a-live-request" },
    })), output.readStderr()).toBe(0);
    const remoteRequest: ProcessResult = {
      exitCode: 0,
      request: client.calls[0]?.request ?? null,
      stderr: output.readStderr(),
      stdout: output.readStdout(),
    };
    expect(contextItems(remoteRequest).filter((item) => item.kind === "historical_memory")).toHaveLength(0);
    expect(remoteRequest.request?.canonicalContext?.text).not.toContain("bypass approval");
    await expect(access(retrievalRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, CROSS_PROCESS_TEST_TIMEOUT_MS);

  it("allows one exact run-local public synthetic grant without weakening the remote zero default", async () => {
    const stateRoot = await directory("bornagent-ml3-public-remote-state-");
    const cwd = await directory("bornagent-ml3-public-remote-repository-");
    const policyPath = join(await directory("bornagent-ml3-public-remote-policy-"), "policy.json");
    await writeFile(policyPath, remotePolicy(), "utf8");
    const client = new FakeStreamingChatClient(fixedStream());
    const output = createMemoryIO();
    const task = "Apply the saved MEM-E0 public synthetic AURORA repository constraint.";
    let wrongRunGrant = false;
    activeStateRoots.push(stateRoot);
    const runtime = createRuntime({
      controlPlaneStateRoot: stateRoot,
      createModelBackend: () => client,
      createPublicSyntheticRemoteMemoryGrant: async (request) => {
        const store = await SqliteEpisodeStore.create({ stateRoot });
        try {
          const scope = Object.freeze({
            applicationRepositoryId: request.repositoryId,
            canonicalRootIdentitySha256: request.canonicalRootIdentitySha256,
            ownerPrincipalId: request.ownerPrincipalId,
          });
          const page = await store.listActiveRecords({ limit: 10, scope });
          const explicit = page.items.filter((record) => record.kind !== "episode");
          expect(explicit).toHaveLength(1);
          const record = explicit[0]!;
          const excerpt = renderHistoricalMemoryExcerptV1(record);
          return createPublicSyntheticRemoteMemoryGrantV1({
            allowedRecords: [{
              disclosureClass: "public_synthetic",
              excerptContentSha256: publicSyntheticRemoteMemoryExcerptSha256(excerpt),
              recordId: record.recordId,
              recordSha256: record.recordSha256,
              sourceReferenceSha256: memoryRecordSourceReferenceSha256(record),
            }],
            authorizationRefSha256: "a".repeat(64),
            canonicalRootIdentitySha256: request.canonicalRootIdentitySha256,
            maximumSelectedRecords: 1,
            model: request.model!,
            ownerPrincipalId: request.ownerPrincipalId,
            policyProfileId: request.policyProfileId!,
            provider: "openai",
            purpose: "fal_mem_e0_public_synthetic_effect_eval",
            repositoryId: request.repositoryId,
            runId: wrongRunGrant ? `${request.runId}-wrong` : request.runId,
            schemaVersion: 1,
            sessionId: request.sessionId,
            taskSha256: publicSyntheticRemoteMemoryTaskSha256(request.task),
            transportScope: "provider_network",
          });
        } finally {
          store.close();
        }
      },
      cwd,
      env: { OPENAI_API_KEY: "not-a-live-request" },
    });
    const register = createMemoryIO();
    expect(await runCli([
      "agent",
      "register this public synthetic repository",
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "off",
    ], register.io, runtime), register.readStderr()).toBe(0);
    const remembered = createMemoryIO();
    expect(await runCli([
      "memory",
      "remember",
      "constraint",
      "MEM-E0 public synthetic AURORA repository constraint: use AURORA_PUBLIC_731.",
      "--json",
    ], remembered.io, runtime), remembered.readStderr()).toBe(0);

    expect(await runCli([
      "agent",
      task,
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "local",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-terra",
      "--policy-profile",
      "remote-openai-ml3",
      "--policy-config",
      policyPath,
    ], output.io, runtime), output.readStderr()).toBe(0);
    const request: ProcessResult = {
      exitCode: 0,
      request: client.calls.at(-1)?.request ?? null,
      stderr: output.readStderr(),
      stdout: output.readStdout(),
    };
    const historical = contextItems(request).filter((item) => item.kind === "historical_memory");
    expect(historical).toHaveLength(1);
    expect(historical[0]?.content).toContain("AURORA_PUBLIC_731");
    expect(historical[0]?.authority).toBe("historical_only");

    wrongRunGrant = true;
    const callsBeforeDenied = client.calls.length;
    const denied = createMemoryIO();
    expect(await runCli([
      "agent",
      task,
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "local",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-terra",
      "--policy-profile",
      "remote-openai-ml3",
      "--policy-config",
      policyPath,
    ], denied.io, runtime)).toBe(1);
    expect(client.calls).toHaveLength(callsBeforeDenied);
  }, CROSS_PROCESS_TEST_TIMEOUT_MS);
});
