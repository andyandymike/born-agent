import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { DelegationOperationStore } from "../../src/delegation/delegation-operation-store.js";
import { createCanonicalPhase20Fixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { createMemoryIO } from "../helpers.js";

const roots: string[] = [];
const processes: ChildProcess[] = [];
const realBuiltCoordinatorCrashTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })));
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error("coordinator crash fixture did not reach the exact two-child terminal prefix");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = spawn("git", [...args], { cwd, env: process.env, stdio: "ignore", windowsHide: true });
  const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed (${String(exitCode)})`);
}

describe("Phase 20D real coordinator crash takeover", () => {
  realBuiltCoordinatorCrashTest("kills the coordinator after two real child receipts and closes the group without duplicate child work", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-real-takeover-"));
    roots.push(root);
    const workspace = join(root, "repository");
    const stateRoot = join(root, "state");
    const readyPath = join(root, "coordinator-ready.json");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "fact.txt"), "two-child coordinator crash fixture\n", "utf8");
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
    await git(workspace, ["init", "--initial-branch=main"]);
    await git(workspace, ["config", "core.autocrlf", "false"]);
    await git(workspace, ["config", "commit.gpgsign", "false"]);
    await git(workspace, ["config", "user.name", "Phase20 Real Takeover"]);
    await git(workspace, ["config", "user.email", "phase20-real-takeover@bornagent.local"]);
    await git(workspace, ["add", "--all"]);
    await git(workspace, ["commit", "--no-verify", "-m", "fixture baseline"]);
    const fixture = await createCanonicalPhase20Fixture({
      count: 2,
      environment: process.env,
      platform: process.platform,
      workspace,
    });

    const app = fileURLToPath(new URL("../fixtures/phase20-coordinator-crash-app.ts", import.meta.url));
    const cliEntryPath = resolve("dist", "cli.js");
    const coordinator = spawn(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      app,
      workspace,
      stateRoot,
      cliEntryPath,
      fixture.sessionId,
      fixture.delegationIds[0]!,
      readyPath,
    ], {
      cwd: resolve("."),
      detached: true,
      env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
      stdio: "ignore",
      windowsHide: true,
    });
    processes.push(coordinator);
    if (coordinator.pid === undefined) throw new Error("coordinator fixture has no process identity");
    const ready = JSON.parse(await waitForFile(readyPath)) as {
      readonly accepted: readonly string[];
      readonly activeActorSlots: number;
      readonly activeConflictClaims: number;
      readonly childStartCount: number;
    };
    expect(ready).toMatchObject({
      activeActorSlots: 2,
      activeConflictClaims: 2,
      childStartCount: 2,
    });
    expect(ready.accepted).toHaveLength(2);
    const prefix = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(prefix.delegations.maximumObservedActiveChildren).toBe(2);
    expect(prefix.delegations.barriers).toEqual([
      expect.objectContaining({ status: "suspended", terminalStatus: null }),
    ]);
    const operations = await DelegationOperationStore.listExisting(stateRoot);
    expect(operations).toHaveLength(2);
    expect((await Promise.all(operations.map((store) => store.read()))).every((operation) =>
      operation?.state === "reconciled")).toBe(true);

    const coordinatorExit = once(coordinator, "exit");
    coordinator.kill("SIGKILL");
    await Promise.race([
      coordinatorExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("coordinator kill did not reach a terminal process state")), 10_000)),
    ]);

    const environment = { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot };
    const runtime = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      cliEntryPath,
      cwd: workspace,
      delegationUserStateRoot: stateRoot,
      env: environment,
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase20-real-takeover",
      workerUserStateRoot: stateRoot,
      worktreeUserStateRoot: join(root, "worktrees"),
    });
    const resumeIO = createMemoryIO();
    expect(await runCli([
      "delegations",
      "resume",
      "--session",
      fixture.sessionId,
      "--delegation",
      fixture.delegationIds[0]!,
      "--json",
    ], resumeIO.io, runtime), resumeIO.readStderr()).toBe(0);

    const recovered = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(recovered.delegations.activeActorSlots).toEqual([]);
    expect(recovered.delegations.activeConflictClaims).toEqual([]);
    expect(recovered.delegations.barriers).toEqual([
      expect.objectContaining({ status: "released", terminalStatus: "completed" }),
    ]);
    expect(recovered.delegations.takeoverCount).toBe(1);
    expect(recovered.events.filter((event) =>
      event.scope === "session" && event.type === "delegation.child.started")).toHaveLength(2);
    expect(recovered.delegations.revisions.filter((revision) =>
      revision.status === "accepted" && revision.receipt?.status === "succeeded")).toHaveLength(2);
    expect(await DelegationOperationStore.listExisting(stateRoot)).toHaveLength(2);
    const leases = await DelegationGroupLeaseStore.listExisting(stateRoot);
    expect(leases).toHaveLength(1);
    expect(await leases[0]!.read()).toMatchObject({
      releaseReason: "reconciled",
      state: "released",
    });
  }, 180_000);
});
