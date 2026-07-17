import { describe, expect, it } from "vitest";

import { EvalCoreError } from "../../src/evals/eval-errors.js";
import { preflightEvalNoCostPolicy, refuseFullSuiteExecution } from "../../src/evals/eval-no-cost-policy.js";
import { loadEvalScenario } from "../../src/evals/eval-scenario-schema.js";
import { EvalServiceRegistry } from "../../src/evals/eval-service-registry.js";
import { loadEvalSuite, selectEvalTaskIds } from "../../src/evals/eval-suite-schema.js";
import {
  decideTaskChangedPath,
  loadEvalTaskManifest,
  matchesEvalAgentCommand,
} from "../../src/evals/eval-task-schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function registry(): EvalServiceRegistry {
  return new EvalServiceRegistry([
    {
      ref: "mcp_stdio_fixture",
      fixtureId: "search-two-files-v1",
      registryVersion: 1,
      fixtureVersion: 1,
      supportedModes: ["normal", "result_then_exit"],
      implementationSha256: SHA_A,
    },
  ]);
}

function taskManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "fix-clamp",
    task_version: 1,
    category: "edit-and-verify",
    prompt: "Fix clamp and verify it.",
    initial_workspace_sha256: SHA_B,
    scenario: {
      kind: "single_run",
      config: { context_window_tokens: 8_192, executor: "docker_v1" },
      services: [],
    },
    allowed_changes: { exact: ["src/clamp.ts", "package.json"], prefixes: ["tests/"], max_files: 2, max_changed_lines: 50 },
    forbidden_changes: { exact: ["package.json"], prefixes: [".git/", ".bornagent/"] },
    agent_commands: [{ executable: "corepack", args: ["pnpm", "test"], cwd: "/workspace" }],
    acceptance: [
      {
        id: "hidden-behavior",
        kind: "protocol",
        inputs_ref: "grader/inputs.json",
        expected_ref: "grader/expected.json",
        worker: { adapter: "node-module-call-v1", entry: "src/clamp.ts", timeout_ms: 30_000 },
        grader: {
          executable: "node",
          args: ["/grader/grade.mjs", "/observations/hidden-behavior.json"],
          cwd: "/grader",
          timeout_ms: 30_000,
          expected_exit: 0,
        },
      },
    ],
    limits: { agent_duration_ms: 600_000, grader_duration_ms: 60_000 },
  };
}

describe("Phase 14 strict manifests and scenario hashes", () => {
  it("loads canonical task rules with forbidden precedence and byte-exact commands", () => {
    const loaded = loadEvalTaskManifest(taskManifest(), registry(), SHA_B);

    expect(loaded.taskManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decideTaskChangedPath(loaded.manifest, "package.json")).toBe("forbidden");
    expect(decideTaskChangedPath(loaded.manifest, "tests/new.test.ts")).toBe("allowed");
    expect(
      matchesEvalAgentCommand(loaded.manifest.agent_commands, {
        executable: "corepack",
        args: ["pnpm", "test"],
        cwd: "/workspace",
      }),
    ).toBe(true);
    expect(
      matchesEvalAgentCommand(loaded.manifest.agent_commands, {
        executable: "corepack",
        args: ["pnpm", "test", "--runInBand"],
        cwd: "/workspace",
      }),
    ).toBe(false);
  });

  it("rejects arbitrary service commands and non-adjacent resume", () => {
    expect(() =>
      loadEvalScenario(
        {
          kind: "single_run",
          config: { context_window_tokens: 8_192, executor: "docker_v1" },
          services: [
            {
              ref: "mcp_stdio_fixture",
              fixture_id: "search-two-files-v1",
              mode: "normal",
              executable: "node",
            },
          ],
        },
        registry(),
      ),
    ).toThrow(EvalCoreError);

    expect(() =>
      loadEvalScenario(
        {
          kind: "scripted_v1",
          config: { context_window_tokens: 2_048, executor: "docker_v1" },
          services: [],
          steps: [
            {
              kind: "run",
              id: "initial",
              fault: { hook: "after_checkpoint_created", action: "terminate_once" },
            },
            { kind: "run", id: "interloper" },
            { kind: "resume", id: "recover", from: "initial" },
          ],
        },
        registry(),
      ),
    ).toThrow(/immediately/u);
  });

  it("loads a fixed 20-task plan without executing it", () => {
    const tasks = Array.from({ length: 20 }, (_, index) => ({
      id: `task-${String(index + 1)}`,
      task_version: 1,
      task_manifest_sha256: SHA_A,
      initial_workspace_sha256: SHA_B,
      grader_sha256: SHA_C,
    }));
    const loaded = loadEvalSuite({
      schema_version: 1,
      id: "suite-v1",
      suite_version: 1,
      tasks,
      smoke_task_ids: tasks.slice(0, 5).map((task) => task.id),
      full_task_ids: tasks.map((task) => task.id),
      repetition_policy: { smoke_default: 1, full_default: 1, maximum: 10 },
      attempt_inclusion_rule: "valid_started_v1",
      metric_definition_version: 1,
      price_currency: "USD",
    });

    expect(selectEvalTaskIds(loaded, "full")).toHaveLength(20);
  });
});

describe("Phase 14 zero-cost and full-suite policy", () => {
  it("accepts only in-process test sources or literal loopback Ollama", () => {
    expect(preflightEvalNoCostPolicy({ kind: "in_process_test", provider: "fake" }).evidence).toMatchObject({
      billableProviderRequestsSent: 0,
      estimatedCostUsd: null,
      billedCostUsd: null,
      proxyEnabled: false,
      redirectsEnabled: false,
    });
    expect(
      preflightEvalNoCostPolicy({
        kind: "local_ollama",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        installedModelTag: "qwen3:fixed",
        installedModelDigest: SHA_D,
      }).evidence.endpointScope,
    ).toBe("literal_loopback");
    expect(() =>
      preflightEvalNoCostPolicy({
        kind: "local_ollama",
        provider: "ollama",
        endpoint: "http://localhost:11434",
        installedModelTag: "qwen3:fixed",
        installedModelDigest: SHA_D,
      }),
    ).toThrow(/literal/u);
    expect(() => preflightEvalNoCostPolicy({ kind: "remote", provider: "openai" })).toThrow(EvalCoreError);
  });

  it("turn guard treats drift as exit 1 and full always returns exit 2 with zero attempts", () => {
    const source = { kind: "in_process_test", provider: "mock" } as const;
    const guard = preflightEvalNoCostPolicy(source);
    guard.assertBeforeModelTurn(source);
    expect(() => guard.assertBeforeModelTurn({ kind: "in_process_test", provider: "fake" })).toThrow(
      expect.objectContaining({ exitCode: 1 }),
    );

    expect(refuseFullSuiteExecution(["a", "b"], source)).toMatchObject({
      authorized: false,
      exitCode: 2,
      attemptsStarted: 0,
      providerRequestsSent: 0,
      fullSuiteExecution: "not_run_by_policy",
    });
  });
});
