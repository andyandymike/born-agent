import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { taskMutationBlocker } from "../../src/coordination/task-control-plane.js";
import {
  createTaskkillArgvRunner,
  NodeProcessTreeCleanup,
} from "../../src/execution/process-tree-cleanup.js";
import { HookCommandOperationReconciler } from "../../src/hooks/hook-command-operation-reconciler.js";
import { HookCommandOperationStore } from "../../src/hooks/hook-command-operation-store.js";
import { HookCommandSupervisor, type HookCommandSupervisorIpcPort } from "../../src/hooks/hook-command-supervisor.js";
import { hookCommandSupervisorBootstrapSchema, type HookCommandSupervisorMessageV1 } from "../../src/hooks/hook-command-supervisor-schema.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";

const temporary: string[] = [];
const SESSION_ID = "10000000-0000-4000-8000-000000000019";
const RUN_ID = "20000000-0000-4000-8000-000000000019";
const INVOCATION_ID = "30000000-0000-4000-8000-000000000019";
const REQUESTED_EVENT_ID = "40000000-0000-4000-8000-000000000019";
const TERMINAL_EVENT_ID = "50000000-0000-4000-8000-000000000019";
const NOW = "2026-08-10T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanup() {
  const isProcessAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return new NodeProcessTreeCleanup({
    isProcessAlive,
    killProcess: (pid, signal) => process.kill(pid, signal),
    platform: process.platform,
    ...(process.platform === "win32"
      ? { taskkill: createTaskkillArgvRunner((file, argv, options) => spawn(file, [...argv], options)) }
      : {}),
    timers: {
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    },
  });
}

class FakeSupervisorIpc implements HookCommandSupervisorIpcPort {
  readonly sent: HookCommandSupervisorMessageV1[] = [];
  #connected = true;
  #disconnect!: () => void;
  readonly #disconnected = new Promise<void>((resolve) => {
    this.#disconnect = resolve;
  });

  constructor(
    readonly bootstrap: unknown,
    readonly disconnectAfterStarted = false,
  ) {}

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#disconnect();
  }

  isConnected(): boolean {
    return this.#connected;
  }

  async receive(): Promise<unknown> {
    return this.bootstrap;
  }

  async send(message: HookCommandSupervisorMessageV1): Promise<void> {
    if (!this.#connected) throw new Error("disconnected");
    this.sent.push(message);
    if (message.kind === "started" && this.disconnectAfterStarted) this.disconnect();
  }

  waitForDisconnect(): Promise<void> {
    return this.#disconnected;
  }
}

async function requestedStore(input: {
  readonly actionSha256: string;
  readonly hookIdentitySha256: string;
  readonly inputSha256: string;
  readonly nonceSha256: string;
  readonly root: string;
  readonly sessionLockNonceSha256?: string;
}): Promise<HookCommandOperationStore> {
  const store = await HookCommandOperationStore.create({
    invocationId: INVOCATION_ID,
    root: input.root,
    runId: RUN_ID,
    sessionId: SESSION_ID,
  });
  await store.createRequested({
    actionSha256: input.actionSha256,
    createdAt: NOW,
    failurePolicy: "fail_closed",
    hookIdentitySha256: input.hookIdentitySha256,
    inputSha256: input.inputSha256,
    invocationId: INVOCATION_ID,
    mode: "gate",
    nonceSha256: input.nonceSha256,
    requestedEventId: REQUESTED_EVENT_ID,
    runId: RUN_ID,
    schemaVersion: 1,
    sessionId: SESSION_ID,
    sessionLockNonceSha256: input.sessionLockNonceSha256 ?? "9".repeat(64),
    state: "requested",
    terminalEventId: TERMINAL_EVENT_ID,
  });
  return store;
}

async function supervisorFixture(scriptText: string, disconnectAfterStarted = false) {
  const root = await mkdtemp(join(tmpdir(), "bornagent-hook-supervisor-"));
  temporary.push(root);
  const operationRoot = join(root, "operations");
  const scriptPath = join(root, "hook.mjs");
  await writeFile(scriptPath, scriptText, "utf8");
  const inputBytes = Buffer.from('{"event":"fixture"}', "utf8");
  const rawNonce = "a".repeat(43);
  const actionSha256 = "1".repeat(64);
  const hookIdentitySha256 = "2".repeat(64);
  const executableSha256 = hash(await readFile(process.execPath));
  const store = await requestedStore({
    actionSha256,
    hookIdentitySha256,
    inputSha256: hash(inputBytes),
    nonceSha256: hash(rawNonce),
    root: operationRoot,
  });
  const bootstrap = hookCommandSupervisorBootstrapSchema.parse({
    actionSha256,
    argv: [],
    cwd: root,
    environment: { BORN_HOOK_PROTOCOL: "1" },
    executablePath: process.execPath,
    executableSha256,
    hookIdentitySha256,
    inputBase64: inputBytes.toString("base64"),
    inputSha256: hash(inputBytes),
    invocationId: INVOCATION_ID,
    mode: "gate",
    protocolVersion: 1,
    rawNonce,
    scriptPath,
    scriptSha256: hash(await readFile(scriptPath)),
    secrets: ["super-secret-sentinel"],
    timeoutMs: 5_000,
  });
  const ipc = new FakeSupervisorIpc(bootstrap, disconnectAfterStarted);
  const supervisor = new HookCommandSupervisor({
    cleanup: cleanup(),
    ipc,
    operationRoot,
    randomUUID,
    timestamp: () => NOW,
  });
  return { ipc, store, supervisor };
}

async function startSession(workspace: string, writer: V2SessionWriter): Promise<void> {
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => NOW,
    writer,
  });
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "Hook recovery fixture" },
      model: "local-fixture",
      provider: "ollama",
      timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "pi-ai",
      adapter_version: "0.80.7",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "best_effort",
        usage: "complete",
      },
      config_fingerprint: "f".repeat(64),
      model: "local-fixture",
      provider: "ollama",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
}

const hookIdentity = {
  componentId: "gate",
  componentSha256: "3".repeat(64),
  kind: "hook" as const,
  pluginId: "fixture",
  pluginSha256: "4".repeat(64),
  pluginVersion: "1.0.0",
  qualifiedId: "user_install:fixture@1.0.0/hook:gate",
  source: "user_install" as const,
};

describe("Phase 19 closure command Hook recovery", () => {
  it("captures one strict Host result through a real child and durable supervisor journal", async () => {
    const fixture = await supervisorFixture(
      "process.stderr.write(String(process.env.OPENAI_API_KEY)); process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection'}));",
    );
    await fixture.supervisor.run({ invocationId: INVOCATION_ID, runId: RUN_ID, sessionId: SESSION_ID });
    const record = await fixture.store.read();
    expect(fixture.ipc.sent.map((message) => message.kind)).toEqual(["started", "captured"]);
    expect(record).toMatchObject({
      capture: { decision: "no_objection", kind: "gate", stderr: "undefined" },
      state: "captured",
    });
    expect(JSON.stringify(record)).not.toContain("super-secret-sentinel");
  });

  it("treats parent IPC loss after start as unknown and terminates the real child tree", async () => {
    const fixture = await supervisorFixture(
      "setInterval(() => {}, 1000);",
      true,
    );
    await fixture.supervisor.run({ invocationId: INVOCATION_ID, runId: RUN_ID, sessionId: SESSION_ID });
    const record = await fixture.store.read();
    expect(record).toMatchObject({
      capture: { code: "hook_invocation_cancelled", effectState: "unknown", kind: "failure" },
      state: "captured",
    });
    if (record?.state === "captured" && record.process !== undefined) {
      const hookPid = record.process.hookPid;
      expect(() => process.kill(hookPid, 0)).toThrow();
    }
  }, 15_000);

  it("backfills a captured result exactly once and then marks the journal terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-hook-reconcile-"));
    temporary.push(workspace);
    const operationRoot = join(workspace, "operation-state");
    const writer = await V2SessionWriter.createNew(workspace, SESSION_ID, {
      createEventId: randomUUID,
      timestamp: () => NOW,
    });
    await startSession(workspace, writer);
    const inputSha256 = "5".repeat(64);
    await writer.appendRunEventWithId(RUN_ID, REQUESTED_EVENT_ID, "hook.invocation.requested", {
      event: "tool.before_effect",
      handler: "command",
      hook_identity: hookIdentity,
      hook_input_artifact_id: `sha256:${inputSha256}`,
      hook_input_sha256: inputSha256,
      invocation_id: INVOCATION_ID,
      mode: "gate",
    });
    const store = await requestedStore({
      actionSha256: "6".repeat(64),
      hookIdentitySha256: sha256Canonical(hookIdentity),
      inputSha256,
      nonceSha256: "7".repeat(64),
      root: operationRoot,
      sessionLockNonceSha256: writer.lockNonceSha256,
    });
    await store.markSpawning({
      nonce: randomUUID(),
      spawningAt: NOW,
      supervisor: { supervisorPid: process.pid, supervisorStartIdentity: "8".repeat(64) },
    });
    const started = await store.markStarted({
      nonce: randomUUID(),
      process: {
        hookPid: process.pid,
        processIdentitySha256: "9".repeat(64),
        supervisorPid: process.pid,
        supervisorStartIdentity: "8".repeat(64),
      },
      startedAt: NOW,
    });
    await writer.appendRunEvent(RUN_ID, "hook.invocation.started", {
      action_sha256: started.actionSha256,
      invocation_id: INVOCATION_ID,
      pid: process.pid,
      process_identity_sha256: started.process.processIdentitySha256,
    });
    await store.markCaptured({
      capture: {
        actionSha256: started.actionSha256,
        decision: "no_objection",
        evidence: ["host:fixture:1"],
        kind: "gate",
        stderr: "",
        stdout: '{"decision":"no_objection","schemaVersion":1}',
      },
      capturedAt: NOW,
      nonce: randomUUID(),
    });
    const reconciler = new HookCommandOperationReconciler({
      operationRoot,
      randomUUID,
      sessionId: SESSION_ID,
      timestamp: () => NOW,
      workspace,
      writer,
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ backfilled: 1, inspected: 1 });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ backfilled: 0, inspected: 1 });
    expect(writer.events.filter((event) => event.type === "hook.invocation.decided")).toHaveLength(1);
    expect(writer.events.filter((event) => event.type === "artifact.stored")).toHaveLength(1);
    expect(await store.read()).toMatchObject({ state: "terminal", terminalEventId: TERMINAL_EVENT_ID });
    await writer.close();
  });

  it("closes a requested-only operation only from the exact dead-owner lock fact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-hook-not-started-"));
    temporary.push(workspace);
    const operationRoot = join(workspace, "operation-state");
    const writer = await V2SessionWriter.createNew(workspace, SESSION_ID, { timestamp: () => NOW });
    await startSession(workspace, writer);
    const inputSha256 = "a".repeat(64);
    await writer.appendRunEventWithId(RUN_ID, REQUESTED_EVENT_ID, "hook.invocation.requested", {
      event: "tool.before_effect",
      handler: "command",
      hook_identity: hookIdentity,
      hook_input_artifact_id: `sha256:${inputSha256}`,
      hook_input_sha256: inputSha256,
      invocation_id: INVOCATION_ID,
      mode: "gate",
    });
    const previousLock = "b".repeat(64);
    const store = await requestedStore({
      actionSha256: "c".repeat(64),
      hookIdentitySha256: sha256Canonical(hookIdentity),
      inputSha256,
      nonceSha256: "d".repeat(64),
      root: operationRoot,
      sessionLockNonceSha256: previousLock,
    });
    const reconciler = new HookCommandOperationReconciler({
      operationRoot,
      randomUUID,
      sessionId: SESSION_ID,
      timestamp: () => NOW,
      workspace,
      writer,
    });
    expect(taskMutationBlocker(reconstructMultiRunSession(writer.events))).toMatchObject({
      code: "session_effect_reconciliation_required",
      details: ["unknown_hook_commands=1"],
    });
    await expect(reconciler.reconcile()).rejects.toMatchObject({ code: "hook_effect_unknown" });
    await writer.appendSessionEvent("session.lock.recovered", {
      previous_nonce_sha256: previousLock,
      reason: "owner_confirmed_dead",
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ backfilled: 1 });
    expect(taskMutationBlocker(reconstructMultiRunSession(writer.events))).toBeNull();
    expect(await store.read()).toMatchObject({
      capture: { effectState: "none", kind: "failure" },
      state: "terminal",
    });
    await writer.close();
  });
});
