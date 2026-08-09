import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { createPiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  FakeStreamingChatClient,
  fixedStream,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const workspaceArgument = process.argv[2];
if (workspaceArgument === undefined) {
  throw new Error("PTY fixture requires a workspace path");
}
const workspace: string = workspaceArgument;
const capabilityLifecycle = process.argv[3] === "capability";
const graphLifecycle = process.argv[3] === "graph";

const waiting = waitForAbort();
const firstBackend = new FakeStreamingChatClient(
  async function* (request, signal) {
    yield { delta: "PTY_ACTIVE", type: "text_delta" };
    yield* waiting(request, signal);
  },
  { model: "qwen3:1.7b", provider: "ollama" },
);
let backendIndex = 0;

const node = createNodeRuntime({
  approvalInput: { interactive: false, readLine: async () => null },
  cwd: workspace,
  env: process.env,
  execPath: process.execPath,
  killProcess: (identity, signal) => process.kill(identity, signal),
  nodeVersion: process.versions.node,
  onCancel: (listener) => {
    process.once("SIGINT", listener);
    return () => process.off("SIGINT", listener);
  },
  platform: process.platform,
  tuiHost: {
    createRenderer: createPiTuiRenderer,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  },
  version: "0.0.0-phase16f-pty",
});
const runtime: CliRuntime = {
  ...node,
  agentModelEvidence: () => ({
    backend: "fake",
    endpointScope: "in_process",
    kind: "contract_verified",
    remoteBillableRequests: 0,
  }),
  createModelBackend: () => {
    const backend =
      backendIndex === 0
        ? firstBackend
        : new FakeStreamingChatClient(fixedStream(["PTY_SECOND"]), {
            model: "qwen3:1.7b",
            provider: "ollama",
          });
    backendIndex += 1;
    return backend;
  },
  modelQualificationGate: new BundledFakeModelQualificationGate(true),
};

async function seedGraph(): Promise<void> {
  await writeLegacySession(workspace);
  const run = async (argv: readonly string[]): Promise<void> => {
    const io = createMemoryIO();
    const exitCode = await runCli(argv, io.io, runtime);
    if (exitCode !== 0) throw new Error(`Graph PTY seed failed (${String(exitCode)}): ${io.readStderr()}`);
  };
  await run(["goal", "set", SESSION_ID, "--text", "Control one durable Graph from the TUI"]);
  const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
  await writeFile(join(workspace, "pty-plan.json"), JSON.stringify({
    items: [{
      acceptance: "The Graph can be approved, queued, inspected, and cancelled from a real PTY.",
      id: "pty-graph",
      required: true,
      title: "Exercise Graph TUI controls",
    }],
    schema_version: 1,
    title: "Phase 19 PTY",
  }), "utf8");
  await run([
    "plan", "replace", SESSION_ID,
    "--goal-id", goal.content.goalId,
    "--goal-revision", "1",
    "--file", "pty-plan.json",
  ]);
  const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
  await run([
    "plan", "approve", SESSION_ID,
    "--goal-id", goal.content.goalId,
    "--goal-revision", "1",
    "--plan-id", plan.planId,
    "--revision", "1",
    "--sha256", plan.planSha256,
  ]);
  const budget = {
    maxArtifactBytes: 4096,
    maxAttempts: 1,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 1,
    maxReportedTokens: 4096,
  };
  await writeFile(join(workspace, "pty-graph.json"), JSON.stringify({
    binding: {
      goalId: goal.content.goalId,
      goalRevision: 1,
      planId: plan.planId,
      planRevision: 1,
      planSha256: plan.planSha256,
      sessionId: SESSION_ID,
    },
    graphBudget: budget,
    graphId: "95000000-0000-4000-8000-000000000019",
    nodes: [{
      agent: { mode: "plan", taskProfile: "read-only" },
      budget,
      dependsOn: [],
      kind: "agent",
      nodeId: "inspect",
      objective: "Inspect the durable Graph projection without external effects.",
      planItemIds: ["pty-graph"],
      requiredCapabilities: [],
      retry: { automaticOn: [], maxAttempts: 1 },
      sequence: 1,
      title: "Inspect Graph projection",
      workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
    }],
    schemaVersion: 1,
    title: "Phase 19 real PTY Graph",
  }), "utf8");
  await run(["graph", "replace", SESSION_ID, "--file", "pty-graph.json"]);
}

if (graphLifecycle) await seedGraph();

if (capabilityLifecycle) {
  const source = fileURLToPath(
    new URL("../../fixtures/capability-platform/m9-review-pack", import.meta.url),
  );
  const lifecycle = node.createPluginLifecycle!(workspace);
  const inspection = await lifecycle.inspect(source);
  const installed = await lifecycle.install(source, inspection.pluginSha256);
  await lifecycle.enable(installed.exactSelector);
}

const exitCode = await runCli(
  graphLifecycle
    ? [
        "tui",
        "--resume",
        SESSION_ID,
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ]
    : capabilityLifecycle
    ? [
        "tui",
        "--mcp",
        "offline-docs",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ]
    : [
        "tui",
        "First PTY run",
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--max-steps",
        "4",
      ],
  { stderr: process.stderr, stdout: process.stdout },
  runtime,
);
process.stdout.write(`\nPTY_APP_EXIT=${String(exitCode)}\n`);
process.exitCode = exitCode;
