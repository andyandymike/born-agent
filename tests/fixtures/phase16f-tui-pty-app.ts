import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { createPiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  FakeContinuation,
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
const hookApprovalLifecycle = process.argv[3] === "hook-approval";
const execFileAsync = promisify(execFile);

const waiting = waitForAbort();
const firstBackend = new FakeStreamingChatClient(
  async function* (request, signal) {
    yield { delta: "PTY_ACTIVE", type: "text_delta" };
    yield* waiting(request, signal);
  },
  { model: "qwen3:1.7b", provider: "ollama" },
);
let hookApprovalTurn = 0;
const hookApprovalBackend = new FakeStreamingChatClient(
  async function* () {
    if (hookApprovalTurn === 0) {
      hookApprovalTurn += 1;
      yield {
        call: {
          argumentsJson: JSON.stringify({ text: "HOOK_PTY_ORIGINAL_ACTION" }),
          callId: "hook-pty-mcp-call",
          name: "mcp__offline_docs__echo",
        },
        type: "tool_call",
      };
      yield {
        type: "usage",
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      };
      yield {
        continuation: new FakeContinuation("hook-pty-mcp-call"),
        providerResponseId: "resp_hook_pty_call",
        type: "turn_completed",
      };
      return;
    }
    yield { delta: "HOOK_PTY_DENIED", type: "text_delta" };
    yield {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    };
    yield {
      continuation: new FakeContinuation("hook-pty-final"),
      providerResponseId: "resp_hook_pty_final",
      type: "turn_completed",
    };
  },
  { model: "qwen3:1.7b", provider: "ollama" },
);
let backendIndex = 0;

const node = createNodeRuntime({
  approvalInput: { interactive: false, readLine: async () => null },
  capabilityUserStateRoot: join(workspace, "user-state", "capabilities"),
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
    if (hookApprovalLifecycle) return hookApprovalBackend;
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

async function seedHookApprovalPlugin(): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  const source = join(workspace, "hook-approval-plugin");
  await mkdir(join(source, "hooks", "command-gate"), { recursive: true });
  await mkdir(join(source, "mcp"), { recursive: true });
  await writeFile(join(source, "bornagent.plugin.json"), JSON.stringify({
    schema_version: 1,
    plugin_id: "bornagent.hook-pty",
    plugin_version: "1.0.0",
    display_name: "Hook PTY",
    description: "Offline double-approval PTY fixture.",
    components: {
      hooks: ["hooks/command-gate/hook.json"],
      mcp_servers: ["mcp/server.json"],
    },
  }), "utf8");
  await writeFile(join(source, "hooks", "command-gate", "hook.json"), JSON.stringify({
    schema_version: 1,
    kind: "hook",
    component_id: "command-gate",
    display_name: "Command Gate",
    description: "Require an independent command Hook approval after the original MCP approval.",
    event: "tool.before_effect",
    mode: "gate",
    matcher: {
      action_kinds: ["mcp.tool.call"],
      capability_ids: ["offline-docs"],
      tool_names: ["mcp__offline_docs__echo"],
    },
    handler: {
      type: "command",
      executable: "gate.mjs",
      argv: [],
      cwd: "workspace_root",
      environment: {},
      sandbox: "policy_selected",
    },
    timeout_ms: 2_000,
    failure_policy: "fail_closed",
    requested_effects: ["process_spawn"],
  }), "utf8");
  await writeFile(
    join(source, "hooks", "command-gate", "gate.mjs"),
    "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection',evidence:['pty:hook-approved']})));\n",
    "utf8",
  );
  await writeFile(join(source, "mcp", "server.json"), JSON.stringify({
    schema_version: 1,
    kind: "mcp_server",
    component_id: "offline-docs",
    display_name: "Offline Docs",
    description: "Deterministic local MCP approval fixture.",
    transport: "stdio",
    executable: "server.mjs",
    args: [],
    cwd: "plugin_root",
    integrity_files: ["server.mjs"],
    env: [],
    startup_timeout_ms: 2_000,
    call_timeout_ms: 5_000,
    requested_effects: ["process_spawn"],
  }), "utf8");
  await writeFile(join(source, "mcp", "server.mjs"), [
    'import readline from "node:readline";',
    'const reply = (id, result) => process.stdout.write(`${JSON.stringify({jsonrpc:"2.0",id,result})}\\n`);',
    'const input = readline.createInterface({input:process.stdin}); input.on("close", () => process.exit(0));',
    'for await (const line of input) {',
    '  const request = JSON.parse(line); if (request.id === undefined) continue;',
    '  if (request.method === "initialize") reply(request.id,{protocolVersion:request.params?.protocolVersion??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"hook-pty",version:"1.0.0"}});',
    '  else if (request.method === "tools/list") reply(request.id,{tools:[{name:"echo",description:"Echo deterministic text.",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}]});',
    '  else if (request.method === "tools/call") reply(request.id,{content:[{type:"text",text:`echo:${String(request.params?.arguments?.text??"")}`}]});',
    '  else reply(request.id,{});',
    '}',
    "",
  ].join("\n"), "utf8");
  const lifecycle = node.createPluginLifecycle!(workspace);
  const inspection = await lifecycle.inspect(source);
  const installed = await lifecycle.install(source, inspection.pluginSha256);
  await lifecycle.enable(installed.exactSelector);
}

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
if (hookApprovalLifecycle) {
  await seedHookApprovalPlugin();
}

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
    : hookApprovalLifecycle
    ? [
        "tui",
        "--mode",
        "build",
        "--mcp",
        "offline-docs",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--max-steps",
        "3",
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
