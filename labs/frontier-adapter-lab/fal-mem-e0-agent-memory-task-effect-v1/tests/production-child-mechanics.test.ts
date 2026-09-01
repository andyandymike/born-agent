import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { ProductionMemoryEffectActorObservationV1 } from "../src/production-memory-effect-actor.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const tsxLoader = import.meta.resolve("tsx");
const childEntry = resolve(
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-child.ts",
);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

async function prepareWorkspace(root: string): Promise<string> {
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "config.txt"), "mode=unset\n", "utf8");
  await writeFile(join(workspace, "verify.mjs"), [
    'import { readFile } from "node:fs/promises";',
    'const text = await readFile(new URL("./src/config.txt", import.meta.url), "utf8");',
    'if (!/^mode=[a-z0-9-]+\\n$/u.test(text) || text === "mode=unset\\n") process.exitCode = 1;',
    "",
  ].join("\n"), "utf8");
  await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "mem-e0@example.invalid"], {
    cwd: workspace,
    windowsHide: true,
  });
  await execFileAsync("git", ["config", "user.name", "MEM-E0 Fixture"], {
    cwd: workspace,
    windowsHide: true,
  });
  await execFileAsync("git", ["add", "--", "src/config.txt", "verify.mjs"], {
    cwd: workspace,
    windowsHide: true,
  });
  await execFileAsync("git", ["commit", "-m", "freeze mem-e0 public fixture"], {
    cwd: workspace,
    windowsHide: true,
  });
  return workspace;
}

async function createEffectBinding(workspace: string): Promise<Readonly<{
  readonly publicVerifierRawSha256: string;
  readonly targetRelativePath: "src/config.txt";
}>> {
  const verifierBytes = await readFile(join(workspace, "verify.mjs"));
  return Object.freeze({
    publicVerifierRawSha256: createHash("sha256").update(verifierBytes).digest("hex"),
    targetRelativePath: "src/config.txt" as const,
  });
}

async function runChild(input: Readonly<Record<string, unknown>>, root: string): Promise<Readonly<{
  readonly observation: ProductionMemoryEffectActorObservationV1;
  readonly stdout: string;
}>> {
  const inputPath = join(root, `input-${String(Math.random()).slice(2)}.json`);
  await writeFile(inputPath, JSON.stringify(input), "utf8");
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(process.execPath, [
      "--import",
      tsxLoader,
      childEntry,
      inputPath,
    ], {
      cwd: resolve("."),
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (error) {
    const output = error !== null && typeof error === "object" && "stdout" in error
      ? String(error.stdout)
      : "missing child output";
    throw new Error(`MEM-E0 child failed with hash-only output: ${output}`, { cause: error });
  }
  const childStdout = typeof result.stdout === "string"
    ? result.stdout
    : result.stdout.toString("utf8");
  return Object.freeze({
    observation: JSON.parse(childStdout) as ProductionMemoryEffectActorObservationV1,
    stdout: childStdout,
  });
}

const seedTask = "Remember this public synthetic repository convention. " +
  "MEM_E0_KEY=marigold-17 MEM_E0_VALUE=amber-signal";
const seedLogicalSha256 = sha256Canonical({
  disclosureClass: "public_synthetic",
  kind: "decision",
  text: seedTask,
});

const effectTask = [
  "Apply the repository convention identified by the opaque key.",
  "MEM_E0_KEY=marigold-17",
  "MEM_E0_TARGET=src/config.txt",
  "MEM_E0_FIELD=mode",
  "MEM_E0_VERIFY_CWD=.",
  "MEM_E0_VERIFY_ARG=verify.mjs",
].join("\n");

describe("MEM-E0 production child mechanics", () => {
  it("persists in child A and uses canonical recalled memory through real tools in child B", async () => {
    const root = await temporaryRoot("bornagent-mem-e0-on-");
    const workspace = await prepareWorkspace(root);
    const effectBinding = await createEffectBinding(workspace);
    const stateRoot = join(root, "host-state");
    const seed = await runChild({
      effectBinding: null,
      memoryKind: "decision",
      memoryMode: "local",
      phase: "seed",
      schemaVersion: 1,
      stateRoot,
      task: seedTask,
      workspace,
    }, root);
    expect(seed.observation, JSON.stringify(seed.observation)).toMatchObject({
      agentExitCode: 0,
      backendCreatedCount: 1,
      explicitRememberExitCode: 0,
      explicitRememberStatus: "added",
      historicalItemCounts: [0],
      memoryMode: "local",
      orchestrationFailure: false,
      phase: "seed",
      providerNetworkRequests: 0,
    });
    expect(seed.observation.explicitMemoryLogicalSha256).toBe(seedLogicalSha256);
    expect(seed.observation.explicitMemoryRecordIdSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(seed.observation.explicitMemoryRecordSha256).toMatch(/^[a-f0-9]{64}$/u);

    const effect = await runChild({
      effectBinding,
      memoryKind: null,
      memoryMode: "local",
      phase: "effect",
      schemaVersion: 1,
      stateRoot,
      task: effectTask,
      workspace,
    }, root);
    expect(
      effect.observation,
      JSON.stringify({ effect: effect.observation, seed: seed.observation }),
    ).toMatchObject({
      agentExitCode: 0,
      backendCreatedCount: 1,
      decisionCounts: {
        emit_finish_task: 1,
        emit_patch: 1,
        emit_public_verifier: 1,
        emit_read_file: 1,
      },
      explicitRememberExitCode: null,
      explicitRememberStatus: "not_run",
      historicalItemCounts: [1],
      memoryMode: "local",
      orchestrationFailure: false,
      phase: "effect",
      providerNetworkRequests: 0,
      toolNames: ["read_file", "apply_patch", "run_command", "finish_task"],
    });
    expect(effect.observation.childPid).not.toBe(seed.observation.childPid);
    expect(effect.observation.approvalObservationSha256s).toHaveLength(2);
    expect(effect.observation.canonicalContextSha256s).toHaveLength(4);
    expect(effect.observation.memoryRecordIdSha256s).toEqual([
      seed.observation.explicitMemoryRecordIdSha256,
    ]);
    expect(effect.observation.memoryValueSha256s).toHaveLength(1);
    expect(effect.observation.toolArgumentSha256s).toHaveLength(4);
    expect(await readFile(join(workspace, "src", "config.txt"), "utf8")).toBe("mode=amber-signal\n");
    for (const forbidden of [workspace, stateRoot, seedTask, effectTask, "amber-signal"]) {
      expect(seed.stdout).not.toContain(forbidden);
      expect(effect.stdout).not.toContain(forbidden);
    }
  }, 120_000);

  it("memory off fails before tools and leaves the target unchanged", async () => {
    const root = await temporaryRoot("bornagent-mem-e0-off-");
    const workspace = await prepareWorkspace(root);
    const effectBinding = await createEffectBinding(workspace);
    const stateRoot = join(root, "host-state");
    const seed = await runChild({
      effectBinding: null,
      memoryKind: "decision",
      memoryMode: "local",
      phase: "seed",
      schemaVersion: 1,
      stateRoot,
      task: seedTask,
      workspace,
    }, root);
    expect(seed.observation, JSON.stringify(seed.observation)).toMatchObject({
      agentExitCode: 0,
      explicitRememberExitCode: 0,
      explicitRememberStatus: "added",
      historicalItemCounts: [0],
      memoryMode: "local",
      orchestrationFailure: false,
      phase: "seed",
      providerNetworkRequests: 0,
    });
    expect(seed.observation.explicitMemoryLogicalSha256).toBe(seedLogicalSha256);
    const result = await runChild({
      effectBinding,
      memoryKind: null,
      memoryMode: "off",
      phase: "effect",
      schemaVersion: 1,
      stateRoot,
      task: effectTask,
      workspace,
    }, root);
    expect(result.observation.agentExitCode).not.toBe(0);
    expect(
      result.observation.decisionCounts,
      JSON.stringify(result.observation),
    ).toEqual({ fail_closed_memory_missing: 1 });
    expect(result.observation.toolNames).toEqual([]);
    expect(result.observation.toolArgumentSha256s).toEqual([]);
    expect(result.observation.approvalObservationSha256s).toEqual([]);
    expect(result.observation.historicalItemCounts).toEqual([0]);
    expect(result.observation.childPid).not.toBe(seed.observation.childPid);
    expect(await readFile(join(workspace, "src", "config.txt"), "utf8")).toBe("mode=unset\n");
  }, 60_000);
});
