import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  backgroundHandoffTransitionId,
  backgroundHandoffRevisionV2Schema,
} from "../../src/background/background-schema.js";
import { parseStrictJson } from "../../src/system/strict-json.js";

const REPOSITORY = "a".repeat(64);
const OPERATION = "10000000-0000-4000-8000-000000000119";
const WORKER = "20000000-0000-4000-8000-000000000119";
const SESSION = "30000000-0000-4000-8000-000000000119";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function launch() {
  const descriptor = {
    cliEntryPathSha256: "1".repeat(64),
    cliEntrySha256: "2".repeat(64),
    nodeExecutablePathSha256: "3".repeat(64),
    nodeExecutableSha256: "4".repeat(64),
    nodeVersion: "22.19.0",
    packageName: "bornagent" as const,
    packageRootInventorySha256: "5".repeat(64),
    packageVersion: "0.0.0",
    schemaVersion: 1 as const,
    workerProtocolVersion: 1 as const,
  };
  return {
    cliEntryPath: "D:/bornagent/dist/cli.js",
    descriptor,
    descriptorSha256: sha256Canonical(descriptor),
    graphId: "40000000-0000-4000-8000-000000000119",
    graphRevision: 1,
    graphSha256: "b".repeat(64),
    launchDeadline: "2026-08-13T00:01:00.000Z",
    nodeExecutablePath: "C:/Program Files/nodejs/node.exe",
    operationId: OPERATION,
    originRoot: "D:/workspace",
    parentPid: 6_001,
    parentProcessStartIdentity: "parent-start",
    repositoryId: REPOSITORY,
    runtimeProfileId: "offline",
    schemaVersion: 1 as const,
    sessionId: SESSION,
    workerId: WORKER,
    workerNonceSha256: "d".repeat(64),
  };
}

function handoff(state: "launching" | "worker_owned" = "launching") {
  return {
    graphSha256: "b".repeat(64),
    operationId: OPERATION,
    owner: state === "launching" ? "parent" as const : "worker" as const,
    ownerPid: state === "launching" ? 6_001 : 7_001,
    ownerProcessStartIdentity: state === "launching" ? "parent-start" : "worker-start",
    parentNonceSha256: "c".repeat(64),
    schemaVersion: 1 as const,
    state,
    updatedAt: state === "launching" ? "2026-08-13T00:00:00.000Z" : "2026-08-13T00:00:01.000Z",
    workerId: WORKER,
    workerNonceSha256: "d".repeat(64),
  };
}

async function fixtureStore() {
  const root = await mkdtemp(join(tmpdir(), "bornagent-as1.1-handoff-"));
  roots.push(root);
  const store = await BackgroundOperationStore.create({ operationId: OPERATION, repositoryId: REPOSITORY, root });
  await store.createLaunch(launch());
  return { root, store };
}

function collectChild(child: ChildProcess): Promise<Readonly<{ code: number | null; stderr: string; stdout: string }>> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (value: string) => { stdout += value; });
  child.stderr?.on("data", (value: string) => { stderr += value; });
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveResult(Object.freeze({ code, stderr, stdout })));
  });
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await lstat(path).then(() => true).catch(() => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("AS1.1 background handoff V2 revision CAS", () => {
  it("publishes genesis and transitions through a strict hash-linked chain without a persistent lock", async () => {
    const { store } = await fixtureStore();
    const genesis = await store.createHandoffV2({
      handoff: handoff(),
      launch: launch(),
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER }),
    });
    expect(genesis).toMatchObject({ protocol: "v2", revision: 0, handoff: { owner: "parent", state: "launching" } });
    await store.compareAndSwapHandoff({
      expectedOwner: "parent",
      expectedState: "launching",
      next: handoff("worker_owned"),
      nonce: "unused-v2",
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "worker_claim", workerId: WORKER }),
    });
    expect(await store.readHandoffAuthority()).toMatchObject({
      protocol: "v2",
      revision: 1,
      handoff: { owner: "worker", state: "worker_owned" },
    });
    expect((await store.inspectHandoff()).legacyLockPresent).toBe(false);
    expect(await lstat(store.paths.handoff).then(() => true).catch(() => false)).toBe(false);
    expect((await readdir(store.paths.handoffV2)).filter((name) => name.startsWith("revision-"))).toEqual([
      "revision-000000000000.json",
      "revision-000000000001.json",
    ]);
    await expect(store.createHandoff(handoff())).rejects.toMatchObject({ code: "worker_reconciliation_required" });
  });

  it("recovers candidate and published response-loss prefixes without creating another revision", async () => {
    const { root, store } = await fixtureStore();
    const genesisTransition = backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER });
    const candidateFailureStore = await BackgroundOperationStore.openExisting({
      operationId: OPERATION,
      options: { onHandoffV2FaultPoint: (point) => { if (point === "candidate_durable") throw new Error("candidate response lost"); } },
      repositoryId: REPOSITORY,
      root,
    });
    await expect(candidateFailureStore.createHandoffV2({ handoff: handoff(), launch: launch(), transitionId: genesisTransition }))
      .rejects.toThrow("candidate response lost");
    expect(await store.readHandoff()).toBeNull();
    await store.createHandoffV2({ handoff: handoff(), launch: launch(), transitionId: genesisTransition });

    const claimTransition = backgroundHandoffTransitionId({ operationId: OPERATION, transition: "worker_claim", workerId: WORKER });
    const publishedFailureStore = await BackgroundOperationStore.openExisting({
      operationId: OPERATION,
      options: { onHandoffV2FaultPoint: (point) => { if (point === "revision_published") throw new Error("publish response lost"); } },
      repositoryId: REPOSITORY,
      root,
    });
    const next = handoff("worker_owned");
    await expect(publishedFailureStore.compareAndSwapHandoff({
      expectedOwner: "parent", expectedState: "launching", next, nonce: "unused", transitionId: claimTransition,
    })).rejects.toThrow("publish response lost");
    await store.compareAndSwapHandoff({
      expectedOwner: "parent", expectedState: "launching", next, nonce: "unused", transitionId: claimTransition,
    });
    expect((await store.readHandoffAuthority())?.revision).toBe(1);
    expect((await readdir(store.paths.handoffV2)).filter((name) => name.startsWith("revision-"))).toHaveLength(2);
  });

  it("allows exactly one real process to publish one next revision", async () => {
    const { root, store } = await fixtureStore();
    await store.createHandoffV2({
      handoff: handoff(), launch: launch(),
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER }),
    });
    const gate = join(root, "go");
    const readyA = join(root, "a.ready");
    const readyB = join(root, "b.ready");
    const fixture = resolve("tests/fixtures/architecture-handoff-v2-cas-contender.ts");
    const makeChild = (variant: "a" | "b", ready: string) => spawn(process.execPath, [
      "--import", "tsx", fixture, root, REPOSITORY, OPERATION, WORKER, variant, gate, ready,
    ], { cwd: resolve("."), env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const childA = makeChild("a", readyA);
    const childB = makeChild("b", readyB);
    const resultA = collectChild(childA);
    const resultB = collectChild(childB);
    await Promise.all([waitForPath(readyA), waitForPath(readyB)]);
    await writeFile(gate, "go\n", { flag: "wx" });
    const results = await Promise.all([resultA, resultB]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 8)).toHaveLength(1);
    expect(results.find((result) => result.code === 8)?.stdout).toContain("worker_handoff_conflict");
    expect(await store.readHandoffAuthority()).toMatchObject({ protocol: "v2", revision: 1 });
  });

  it("fails closed on revision gaps, hash corruption, V1 coexistence, and an ownerless legacy lock", async () => {
    const first = await fixtureStore();
    await first.store.createHandoffV2({
      handoff: handoff(), launch: launch(),
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER }),
    });
    await rename(
      join(first.store.paths.handoffV2, "revision-000000000000.json"),
      join(first.store.paths.handoffV2, "revision-000000000001.json"),
    );
    await expect(first.store.readHandoff()).rejects.toMatchObject({ code: "worker_reconciliation_required" });

    const second = await fixtureStore();
    await second.store.createHandoffV2({
      handoff: handoff(), launch: launch(),
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER }),
    });
    const revisionPath = join(second.store.paths.handoffV2, "revision-000000000000.json");
    const revision = backgroundHandoffRevisionV2Schema.parse(parseStrictJson(await readFile(revisionPath, "utf8")));
    await writeFile(revisionPath, `${JSON.stringify({ ...revision, transitionId: "f".repeat(64) })}\n`, "utf8");
    await expect(second.store.readHandoff()).rejects.toMatchObject({ code: "worker_reconciliation_required" });

    const third = await fixtureStore();
    await third.store.createHandoffV2({
      handoff: handoff(), launch: launch(),
      transitionId: backgroundHandoffTransitionId({ operationId: OPERATION, transition: "genesis", workerId: WORKER }),
    });
    await writeFile(third.store.paths.handoff, `${JSON.stringify(handoff())}\n`, "utf8");
    await expect(third.store.readHandoff()).rejects.toMatchObject({ code: "worker_reconciliation_required" });

    const legacy = await fixtureStore();
    await legacy.store.createHandoff(handoff());
    const lockPath = join(legacy.store.paths.operation, ".handoff.lock");
    await writeFile(lockPath, "{\"nonce\":\"orphan\"}\n", "utf8");
    const inspection = await legacy.store.inspectHandoff();
    expect(inspection).toMatchObject({ authority: { protocol: "v1" }, legacyLockPath: lockPath, legacyLockPresent: true });
    await expect(legacy.store.compareAndSwapHandoff({
      expectedOwner: "parent", expectedState: "launching", next: handoff("worker_owned"), nonce: "retry",
    })).rejects.toMatchObject({ code: "worker_handoff_conflict" });
    expect(await lstat(lockPath).then(() => true).catch(() => false)).toBe(true);
    await unlink(lockPath);
  });
});
