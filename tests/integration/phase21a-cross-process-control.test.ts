import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  ControlOperationJournal,
  type AcceptControlOperationInputV1,
} from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";

interface OperationSnapshot {
  readonly domainRecordRefs: readonly unknown[];
  readonly errorCode: string | null;
  readonly operationId: string;
  readonly operationRevision: number;
  readonly ownerClaim: null | Readonly<{
    acquiredAt: string;
    claimEpoch: number;
    expiresAt: string;
    processStartIdentitySha256: string;
  }>;
  readonly preparedActionId: string;
  readonly primaryDomainRecord: unknown | null;
  readonly recordSha256: string;
  readonly state: string;
  readonly underlyingOperationRefs: readonly unknown[];
}

type DriverSnapshot =
  | Readonly<{
      claim: Readonly<{
        claimEpoch: number;
        operationId: string;
        processStartIdentitySha256: string;
      }>;
      kind: "acquired";
      operation: OperationSnapshot;
      takeover: boolean;
    }>
  | Readonly<{
      kind: "blocked_unknown_effect" | "busy" | "terminal";
      operation: OperationSnapshot;
    }>;

interface AcceptOutput {
  readonly acceptance: Readonly<{ created: boolean; operation: OperationSnapshot }>;
  readonly command: "accept";
  readonly pid: number;
}

interface AcceptAndAcquireOutput {
  readonly acceptance: Readonly<{ created: boolean; operation: OperationSnapshot }>;
  readonly command: "accept-and-acquire";
  readonly driver: DriverSnapshot;
  readonly pid: number;
}

interface DriverOutput {
  readonly command: "acquire" | "claim-and-hold";
  readonly driver: DriverSnapshot;
  readonly pid: number;
}

const workerPath = fileURLToPath(new URL("../fixtures/phase21a-control-worker.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];

function acceptInput(preparedActionId: string, idempotencyKey: string): AcceptControlOperationInputV1 {
  const repositoryId = "10000000-0000-4000-8000-000000000021";
  return {
    actionKind: "session.create",
    idempotencyKey,
    idempotencyNamespace: "application.commit.local_owner",
    preparedActionId,
    preparedActionSha256: sha256Canonical({ preparedActionId, schemaVersion: 1 }),
    requestIdentitySha256: sha256Canonical({ actionKind: "session.create", preparedActionId }),
    target: {
      catalogScope: { kind: "session_catalog", repositoryId, teamId: null },
      expectedCatalogVersion: { kind: "revision", revision: 0, sha256: "a".repeat(64) },
      kind: "new_session",
    },
  };
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase21a-cross-process-"));
  temporaryRoots.push(root);
  await loadOrCreateHostControlAuthority({ root });
  return root;
}

function startWorker(root: string, driverLeaseMs: number, command: string, payload: unknown): ChildProcess {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const child = spawn(process.execPath, [
    "--import",
    import.meta.resolve("tsx"),
    workerPath,
    root,
    String(driverLeaseMs),
    command,
    encodedPayload,
  ], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function runWorker<T>(root: string, driverLeaseMs: number, command: string, payload: unknown): Promise<T> {
  const child = startWorker(root, driverLeaseMs, command, payload);
  return new Promise((resolveResult, reject) => {
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Phase 21A worker timed out: ${command}`));
    }, 15_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`Phase 21A worker failed (${String(exitCode)}): ${stderr.trim()}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout.trim()) as T);
      } catch (error) {
        reject(new Error(`Phase 21A worker emitted invalid JSON: ${stdout.trim()}`, { cause: error }));
      }
    });
  });
}

function startHoldingWorker(
  root: string,
  driverLeaseMs: number,
  operationId: string,
  transitions: readonly string[] = [],
): Promise<Readonly<{ child: ChildProcess; output: DriverOutput }>> {
  const child = startWorker(root, driverLeaseMs, "claim-and-hold", { operationId, transitions });
  return new Promise((resolveResult, reject) => {
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Phase 21A holding worker did not publish its durable claim"));
    }, 15_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const onData = (chunk: string): void => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      try {
        resolveResult({ child, output: JSON.parse(stdout.slice(0, newline)) as DriverOutput });
      } catch (error) {
        reject(new Error(`Phase 21A holding worker emitted invalid JSON: ${stdout}`, { cause: error }));
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timeout);
      reject(new Error(`Phase 21A holding worker exited (${String(exitCode)}): ${stderr.trim()}`));
    });
  });
}

async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("worker did not terminate")), 10_000)),
  ]);
}

async function waitPast(expiresAt: string): Promise<void> {
  const remaining = Date.parse(expiresAt) - Date.now() + 75;
  if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
}

afterEach(async () => {
  for (const child of children.splice(0)) await killWorker(child).catch(() => undefined);
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })));
});

describe("Phase 21A cross-process control operation ownership", () => {
  it("serializes K1/K2 acceptance of one prepared action to one durable winner", async () => {
    const root = await stateRoot();
    const preparedActionId = "20000000-0000-4000-8000-000000000021";
    const [k1, k2] = await Promise.all([
      runWorker<AcceptOutput>(root, 5_000, "accept", {
        acceptInput: acceptInput(preparedActionId, "K1"),
      }),
      runWorker<AcceptOutput>(root, 5_000, "accept", {
        acceptInput: acceptInput(preparedActionId, "K2"),
      }),
    ]);

    expect(k1.pid).not.toBe(k2.pid);
    expect([k1, k2].filter((result) => result.acceptance.created)).toHaveLength(1);
    expect(new Set([k1, k2].map((result) => result.acceptance.operation.operationId)).size).toBe(1);
    const authority = await loadOrCreateHostControlAuthority({ root });
    expect(await new ControlOperationJournal(authority.paths).list()).toHaveLength(1);
  }, 30_000);

  it("makes a second process join the prepared operation and observe its active owner as busy", async () => {
    const root = await stateRoot();
    const preparedActionId = "30000000-0000-4000-8000-000000000021";
    const accepted = await runWorker<AcceptOutput>(root, 10_000, "accept", {
      acceptInput: acceptInput(preparedActionId, "K1"),
    });
    const holder = await startHoldingWorker(root, 10_000, accepted.acceptance.operation.operationId);
    expect(holder.output.driver.kind).toBe("acquired");

    const joiner = await runWorker<AcceptAndAcquireOutput>(root, 10_000, "accept-and-acquire", {
      acceptInput: acceptInput(preparedActionId, "K2"),
    });

    expect(joiner.pid).not.toBe(holder.output.pid);
    expect(joiner.acceptance).toMatchObject({
      created: false,
      operation: { operationId: accepted.acceptance.operation.operationId },
    });
    expect(joiner.driver).toMatchObject({
      kind: "busy",
      operation: { operationId: accepted.acceptance.operation.operationId },
    });
  }, 30_000);

  it("allows one higher-epoch takeover after a dead pre-domain owner lease expires", async () => {
    const root = await stateRoot();
    const preparedActionId = "40000000-0000-4000-8000-000000000021";
    const accepted = await runWorker<AcceptOutput>(root, 600, "accept", {
      acceptInput: acceptInput(preparedActionId, "K1"),
    });
    const holder = await startHoldingWorker(root, 600, accepted.acceptance.operation.operationId);
    expect(holder.output.driver).toMatchObject({
      kind: "acquired",
      operation: { state: "accepted" },
      takeover: false,
    });
    if (holder.output.driver.kind !== "acquired") throw new TypeError("expected the first driver claim");
    const firstClaim = holder.output.driver.claim;
    const expiresAt = holder.output.driver.operation.ownerClaim?.expiresAt;
    if (expiresAt === undefined) throw new TypeError("first driver lease is missing");

    await killWorker(holder.child);
    await waitPast(expiresAt);
    const takeover = await runWorker<DriverOutput>(root, 600, "acquire", {
      operationId: accepted.acceptance.operation.operationId,
    });

    expect(takeover.pid).not.toBe(holder.output.pid);
    expect(takeover.driver).toMatchObject({
      claim: { claimEpoch: firstClaim.claimEpoch + 1 },
      kind: "acquired",
      operation: {
        domainRecordRefs: [],
        primaryDomainRecord: null,
        state: "accepted",
        underlyingOperationRefs: [],
      },
      takeover: true,
    });
    if (takeover.driver.kind !== "acquired") throw new TypeError("expected the replacement driver claim");
    expect(takeover.driver.claim.processStartIdentitySha256)
      .not.toBe(firstClaim.processStartIdentitySha256);
  }, 30_000);

  it("blocks an expired post-domain owner as unknown and never makes the prefix executable again", async () => {
    const root = await stateRoot();
    const preparedActionId = "50000000-0000-4000-8000-000000000021";
    const accepted = await runWorker<AcceptOutput>(root, 600, "accept", {
      acceptInput: acceptInput(preparedActionId, "K1"),
    });
    const holder = await startHoldingWorker(
      root,
      600,
      accepted.acceptance.operation.operationId,
      ["authority_validated", "domain_append_started"],
    );
    expect(holder.output.driver).toMatchObject({
      kind: "acquired",
      operation: {
        domainRecordRefs: [],
        primaryDomainRecord: null,
        state: "domain_append_started",
        underlyingOperationRefs: [],
      },
    });
    if (holder.output.driver.kind !== "acquired") throw new TypeError("expected dispatch driver claim");
    const expiresAt = holder.output.driver.operation.ownerClaim?.expiresAt;
    if (expiresAt === undefined) throw new TypeError("dispatch driver lease is missing");

    await killWorker(holder.child);
    await waitPast(expiresAt);
    const reconciliation = await runWorker<DriverOutput>(root, 600, "acquire", {
      operationId: accepted.acceptance.operation.operationId,
    });
    expect(reconciliation.driver).toMatchObject({
      kind: "blocked_unknown_effect",
      operation: {
        domainRecordRefs: [],
        errorCode: "control_driver_owner_lost_after_dispatch",
        ownerClaim: null,
        primaryDomainRecord: null,
        state: "blocked_unknown_effect",
        underlyingOperationRefs: [],
      },
    });

    const authority = await loadOrCreateHostControlAuthority({ root });
    const journal = new ControlOperationJournal(authority.paths, { driverLeaseMs: 600 });
    const terminalPrefix = await journal.read(accepted.acceptance.operation.operationId);
    const secondRecovery = await runWorker<DriverOutput>(root, 600, "acquire", {
      operationId: accepted.acceptance.operation.operationId,
    });
    expect(secondRecovery.driver).toMatchObject({
      kind: "terminal",
      operation: {
        operationRevision: terminalPrefix?.operationRevision,
        recordSha256: terminalPrefix?.recordSha256,
        state: "blocked_unknown_effect",
      },
    });
    expect(await journal.read(accepted.acceptance.operation.operationId)).toEqual(terminalPrefix);
  }, 30_000);
});
