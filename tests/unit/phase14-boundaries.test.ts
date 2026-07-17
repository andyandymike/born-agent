import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareNodeAttemptWorkspace } from "../../src/evals/attempt-workspace-node.js";
import { EvalApprovalPolicy } from "../../src/evals/eval-approval-policy.js";
import { InProcessEvalAgentDriver, LocalOllamaEvalAgentDriver } from "../../src/evals/eval-agent-driver.js";
import { HiddenGraderRunner, type GraderContainerSpec } from "../../src/evals/hidden-grader-runner.js";
import { preflightEvalNoCostPolicy } from "../../src/evals/eval-no-cost-policy.js";
import { loadPriceCatalog, estimateSyntheticProviderCost } from "../../src/evals/price-catalog.js";
import { decodeProtocolObservations, loadProtocolCases } from "../../src/evals/protocol-case-loader.js";
import { loadEvalAssets } from "../../src/evals/eval-suite-loader.js";
import { EvalServiceRegistry } from "../../src/evals/eval-service-registry.js";
import { loadEvalTaskManifest } from "../../src/evals/eval-task-schema.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Phase 14 protocol, approval, and grader boundaries", () => {
  it("executes the checked-in static supervisor without executing candidate code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bornagent-grader-script-"));
    roots.push(root);
    const observations = path.join(root, "observations.jsonl");
    const grader = path.join(
      process.cwd(),
      "evals",
      "tasks",
      "read-paths",
      "grader",
      "grade.mjs",
    );
    await writeFile(
      observations,
      '{"case_id":"static","value":"PASS:read-paths\\n"}\n',
      "utf8",
    );
    expect(spawnSync(process.execPath, [grader, observations]).status).toBe(0);
    await writeFile(
      observations,
      '{"case_id":"static","value":"WRONG\\n"}\n',
      "utf8",
    );
    expect(spawnSync(process.execPath, [grader, observations]).status).toBe(1);
  });

  it("matches host-only case IDs and rejects bad, duplicate, unknown, or missing JSONL frames", () => {
    const cases = loadProtocolCases(
      { schema_version: 1, cases: [{ id: "a", value: { n: 1 } }, { id: "b", value: { n: 2 } }] },
      { schema_version: 1, cases: [{ id: "b", value: 20 }, { id: "a", value: 10 }] },
    );
    expect(cases.caseIds).toEqual(["a", "b"]);
    expect(decodeProtocolObservations('{"case_id":"b","value":20}\n{"case_id":"a","value":10}\n', cases.caseIds, { maxFrameBytes: 100, maxTotalBytes: 300 }).size).toBe(2);
    expect(() => decodeProtocolObservations('{"case_id":"a","value":1}\n{"case_id":"a","value":2}\n', cases.caseIds, { maxFrameBytes: 100, maxTotalBytes: 300 })).toThrow(/duplicate/u);
    expect(() => decodeProtocolObservations('{"case_id":"unknown","value":1}\n', cases.caseIds, { maxFrameBytes: 100, maxTotalBytes: 300 })).toThrow(/unknown/u);
    expect(() => decodeProtocolObservations('{bad}\n', cases.caseIds, { maxFrameBytes: 100, maxTotalBytes: 300 })).toThrow(/JSONL/u);
    expect(() => loadProtocolCases({ schema_version: 1, cases: [{ id: "a", value: 1 }] }, { schema_version: 1, cases: [{ id: "b", value: 1 }] })).toThrow(/match exactly/u);
  });

  it("binds eval approvals to one disposable workspace and exact Docker command", async () => {
    const registry = new EvalServiceRegistry([]);
    const manifest = loadEvalTaskManifest({
      schema_version: 1, id: "task-a", task_version: 1, category: "edit", prompt: "edit", initial_workspace_sha256: "a".repeat(64),
      scenario: { kind: "single_run", config: { context_window_tokens: 2048, executor: "docker_v1" }, services: [] },
      allowed_changes: { exact: ["answer.txt"], prefixes: [], max_files: 1, max_changed_lines: 10 },
      forbidden_changes: { exact: [], prefixes: [".git/"] },
      agent_commands: [{ executable: "node", args: ["--test"], cwd: "/workspace" }],
      acceptance: [{ id: "static", kind: "static", grader: { executable: "node", args: ["/grader/grade.mjs"], cwd: "/grader", timeout_ms: 1000, expected_exit: 0 } }],
      limits: { agent_duration_ms: 1000, grader_duration_ms: 1000 },
    }, registry).manifest;
    const policy = new EvalApprovalPolicy(manifest, "task-a-r1");
    expect(policy.decidePatch({ disposableWorkspaceId: "task-a-r1", paths: ["answer.txt"], changedLines: 1 }).decision).toBe("approved");
    expect(policy.decidePatch({ disposableWorkspaceId: "other", paths: ["answer.txt"], changedLines: 1 }).decision).toBe("denied");
    expect(policy.decideCommand({ disposableWorkspaceId: "task-a-r1", command: { executable: "node", args: ["--test"], cwd: "/workspace" }, executor: "docker_v1", network: "none" }).decision).toBe("approved");
    expect(policy.decideCommand({ disposableWorkspaceId: "task-a-r1", command: { executable: "node", args: ["--test", "extra"], cwd: "/workspace" }, executor: "docker_v1", network: "none" }).decision).toBe("denied");
  });

  it("cleans the candidate worker before starting a supervisor that cannot mount the workspace", async () => {
    const calls: string[] = [];
    let workerSpec: GraderContainerSpec | undefined;
    let supervisorSpec: GraderContainerSpec | undefined;
    const runner = new HiddenGraderRunner({
      async runWorker(spec) { calls.push("worker"); workerSpec = spec; return { observationsPath: "C:/observations" }; },
      async runSupervisor(spec) { calls.push("supervisor"); supervisorSpec = spec; return { exitCode: 0 }; },
      async cleanup(phase) { calls.push(`cleanup:${phase}`); return true; },
    });
    expect(await runner.run({ image: `grader@sha256:${"a".repeat(64)}`, workspacePath: "C:/workspace", graderPath: "C:/grader", runnerPath: "C:/runner", observationsPath: "C:/observations" }, new AbortController().signal)).toBe(true);
    expect(calls).toEqual(["worker", "cleanup:worker", "supervisor", "cleanup:supervisor"]);
    expect(workerSpec?.mounts.map((mount) => mount.target)).toEqual(["/workspace", "/runner"]);
    expect(supervisorSpec?.mounts.map((mount) => mount.target)).toEqual(["/grader", "/observations"]);
  });
});

describe("Phase 14 local-only drivers and offline price fixtures", () => {
  it("uses the scripted DSL in-process and rejects a mismatched local driver source", async () => {
    const assets = await loadEvalAssets(path.join(process.cwd(), "evals"));
    const scripted = assets.tasks.get("resume-checkpoint");
    const ollamaTask = assets.tasks.get("read-paths");
    if (scripted === undefined || ollamaTask === undefined) throw new Error("missing checked-in task");
    const root = await mkdtemp(path.join(tmpdir(), "bornagent-phase14-driver-")); roots.push(root);
    const fakeRoot = path.join(root, "fake"); await mkdir(fakeRoot);
    const fakeWorkspace = await prepareNodeAttemptWorkspace(scripted.workspaceRoot, fakeRoot);
    const fakeSource = { kind: "in_process_test", provider: "fake" } as const;
    const fakeResult = await new InProcessEvalAgentDriver().run({ task: scripted, workspacePath: fakeWorkspace.workspacePath, model: "deterministic-v1", source: fakeSource, guard: preflightEvalNoCostPolicy(fakeSource), signal: new AbortController().signal, approvalPolicy: new EvalApprovalPolicy(scripted.task.manifest, "scripted-r1"), disposableWorkspaceId: "scripted-r1" });
    expect(fakeResult.events.some((event) => event.type === "resume_adopted")).toBe(true);
    expect(fakeResult.events.some((event) => event.type === "approval_decided" && event.fields.decisionSource === "eval_policy")).toBe(true);

    const source = { kind: "local_ollama", provider: "ollama", endpoint: "http://127.0.0.1:11434", installedModelTag: "qwen3:fixed", installedModelDigest: "b".repeat(64) } as const;
    await expect(new LocalOllamaEvalAgentDriver().run({ task: ollamaTask, workspacePath: fakeWorkspace.workspacePath, model: "qwen3:fixed", source: fakeSource, guard: preflightEvalNoCostPolicy(source), signal: new AbortController().signal, approvalPolicy: new EvalApprovalPolicy(ollamaTask.task.manifest, "ollama-r1"), disposableWorkspaceId: "ollama-r1" })).rejects.toThrow(/wrong source/u);
  }, 60_000);

  it("loads a checked-in catalog without fetching and preserves null cost semantics", async () => {
    const catalog = loadPriceCatalog(JSON.parse(await readFile(path.join(process.cwd(), "evals", "price-catalog-v1.json"), "utf8")) as unknown);
    const entry = catalog.catalog.entries[0];
    if (entry === undefined) throw new Error("missing price fixture");
    expect(estimateSyntheticProviderCost({ entry, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(3);
    expect(estimateSyntheticProviderCost({ entry, inputTokens: null, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});
