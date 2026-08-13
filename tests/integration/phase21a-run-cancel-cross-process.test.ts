import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const worker = String.raw`
const [encoded] = process.argv.slice(1);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const { randomUUID } = await import("node:crypto");
const { createPhase21ALocalControlPlane } = await import("./src/control-plane/local-control-plane.ts");
const plane = await createPhase21ALocalControlPlane({
  launcher: { launch: async () => { throw new Error("cancel worker must not launch a run"); } },
  stateRoot: input.stateRoot,
});
const context = plane.context("cli", randomUUID());
if (input.command === "cancel") {
  const payload = { reason: "user", runId: input.runId };
  const prepared = await plane.actions.prepare(context, {
    actionKind: "run.cancel",
    payload,
    payloadSha256: input.payloadSha256,
    prepareIdempotencyKey: "cross-process-cancel-prepare",
    requestId: randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head: input.head, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: {
        kind: "session",
        repositoryId: input.repositoryId,
        sessionId: input.sessionId,
        teamId: null,
      },
    },
  });
  if (prepared.status !== "ok") throw new Error(JSON.stringify(prepared.error));
  const committed = await plane.actions.commit(context, {
    idempotencyKey: "cross-process-cancel-K1",
    preparedActionId: prepared.result.prepared.preparedActionId,
    preparedActionSha256: prepared.result.prepared.preparedActionSha256,
    requestId: randomUUID(),
    schemaVersion: 1,
  });
  process.stdout.write(JSON.stringify({ committed, prepared: prepared.result.prepared }) + "\n");
} else if (input.command === "replay") {
  const committed = await plane.actions.commit(context, {
    idempotencyKey: "cross-process-cancel-K2",
    preparedActionId: input.preparedActionId,
    preparedActionSha256: input.preparedActionSha256,
    requestId: randomUUID(),
    schemaVersion: 1,
  });
  process.stdout.write(JSON.stringify({ committed }) + "\n");
} else if (input.command === "replacement") {
  const barrier = await plane.sessions.readRunCancelBarrier(input.repositoryId, input.sessionId, input.runId);
  let replacementError = null;
  try {
    await plane.sessions.registerRunOwner({
      initialObservedHead: input.head,
      ownerGenerationSha256: input.replacementGenerationSha256,
      ownerOperationId: input.runId,
      repositoryId: input.repositoryId,
      runId: input.runId,
      sessionId: input.sessionId,
    });
  } catch (error) {
    replacementError = {
      code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(JSON.stringify({
    hasRequest: barrier.request !== null,
    ownerGenerationSha256: barrier.owner?.fact.ownerGenerationSha256 ?? null,
    replacementError,
    terminal: barrier.terminal,
  }) + "\n");
} else {
  throw new Error("unknown worker command");
}
`;

function runWorker<T>(input: unknown): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      worker,
      encoded,
    ], {
      cwd: resolve("."),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("cross-process cancel worker timed out"));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`cross-process cancel worker failed (${String(code)}): ${stderr.trim()}`));
        return;
      }
      try {
        resolveWorker(JSON.parse(stdout.trim()) as T);
      } catch (error) {
        reject(new Error(`cross-process cancel worker returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

describe("Phase 21A cross-process durable run cancellation", () => {
  it("persists an owner-absent request as blocked unknown and fences replacement dispatch", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-phase21a-cancel-process-state-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "bornagent-phase21a-cancel-process-repo-"));
    temporary.push(stateRoot, repositoryRoot);
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("setup plane must not launch a run"); } },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const repositoryId = repository.registration.repositoryId;
    const session = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repositoryId),
      operationId: randomUUID(),
      repositoryId,
    });
    const sessionId = session.entry.sessionId;
    const runId = randomUUID();
    const ownerGenerationSha256 = "1".repeat(64);
    const startedHead = Object.freeze({
      eventId: randomUUID(),
      eventIntegrityToken: `slh_v1_${"A".repeat(43)}`,
      schemaVersion: 1 as const,
      sequence: 1,
      sessionId,
    });
    await plane.sessions.registerRunOwner({
      initialObservedHead: session.entry.initialLedgerHead,
      ownerGenerationSha256,
      ownerOperationId: runId,
      repositoryId,
      runId,
      sessionId,
    });
    await plane.sessions.observeRunOwner({
      observationKind: "started",
      observedHead: startedHead,
      ownerGenerationSha256,
      repositoryId,
      runId,
      sessionId,
    });
    const { sha256Canonical } = await import("../../src/completion/canonical-json.js");
    const cancelPayload = { reason: "user" as const, runId };
    const first = await runWorker<{
      committed: Readonly<{ operationId: string | null; result: Readonly<{ signalStatus: string; terminalBinding: unknown }> }>;
      prepared: Readonly<{ preparedActionId: string; preparedActionSha256: string }>;
    }>({
      command: "cancel",
      head: startedHead,
      payloadSha256: sha256Canonical(cancelPayload),
      repositoryId,
      runId,
      sessionId,
      stateRoot,
    });
    expect(first.committed).toMatchObject({
      error: { code: "control_operation_busy" },
      result: null,
      status: "rejected",
    });
    const barrier = await plane.sessions.readRunCancelBarrier(repositoryId, sessionId, runId);
    expect(barrier.request?.fact.applicationCommit.operationId).toBe(first.committed.operationId);
    expect(barrier.binding).toBeNull();
    expect(barrier.terminal).toBeNull();

    const replay = await runWorker<{ committed: typeof first.committed }>({
      command: "replay",
      preparedActionId: first.prepared.preparedActionId,
      preparedActionSha256: first.prepared.preparedActionSha256,
      stateRoot,
    });
    expect(replay.committed.operationId).toBe(first.committed.operationId);
    expect(replay.committed).toMatchObject({
      error: { code: "control_operation_busy" },
      operationId: first.committed.operationId,
      result: null,
      status: "rejected",
    });
    const blocked = (await plane.operations.list()).find((operation) =>
      operation.operationId === first.committed.operationId
    );
    expect(blocked).toMatchObject({
      errorCode: "control_action_reconcile_incomplete",
      state: "blocked_unknown_effect",
    });

    const restarted = await runWorker<{
      hasRequest: boolean;
      ownerGenerationSha256: string;
      replacementError: Readonly<{ code: string; message: string }>;
      terminal: unknown;
    }>({
      command: "replacement",
      head: startedHead,
      replacementGenerationSha256: "2".repeat(64),
      repositoryId,
      runId,
      sessionId,
      stateRoot,
    });
    expect(restarted).toMatchObject({
      hasRequest: true,
      ownerGenerationSha256,
      replacementError: {
        code: "control_operation_busy",
        message: expect.stringMatching(/barrier|owner generation/i),
      },
      terminal: null,
    });
  }, 60_000);
});
