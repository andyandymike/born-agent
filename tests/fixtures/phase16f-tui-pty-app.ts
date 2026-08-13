import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { createDomainHarness } from "../../src/coordination/domain-harness.js";
import { disposeApplicationHostForStateRoot } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { storeDelegationArtifactExact } from "../../src/delegation/delegation-control-plane.js";
import {
  canonicalDelegationIdentity,
  delegationAuthorityRequestPreviewIdentity,
} from "../../src/delegation/delegation-identity.js";
import {
  delegationRevisionContentSchema,
  normalizeDelegationRevision,
} from "../../src/delegation/delegation-schema.js";
import {
  createCanonicalPhase20CodingFixture,
  createCanonicalPhase20Fixture,
} from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createPiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
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
const delegationCodingCancelLifecycle = process.argv[3] === "delegation-coding-cancel";
const delegationCodingExitCancelLifecycle = process.argv[3] === "delegation-coding-exit-cancel";
const delegationCodingLifecycle = process.argv[3] === "delegation-coding";
const delegationCodingAnyLifecycle = delegationCodingLifecycle || delegationCodingCancelLifecycle || delegationCodingExitCancelLifecycle;
const delegationLifecycle = process.argv[3] === "delegation";
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
  ...(delegationLifecycle || delegationCodingAnyLifecycle
    ? {
        cliEntryPath: fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
        delegationUserStateRoot: join(workspace, "user-state", "delegations"),
        workerUserStateRoot: join(workspace, "user-state", "workers"),
        worktreeUserStateRoot: join(workspace, "w"),
      }
    : {}),
  cwd: workspace,
  // The real Windows PTY gate cold-starts package-owned child processes while
  // the full built-path matrix is already exercising worker/process teardown.
  // Keep production's 30s default unchanged; this explicit bounded fixture
  // budget prevents host load from turning a healthy cold start into an
  // unknown-effect handshake timeout.
  ...(delegationLifecycle || delegationCodingAnyLifecycle
    ? { delegationHandshakeTimeoutMs: 60_000 }
    : {}),
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

const delegationSessionMarker = join(workspace, "user-state", "phase20-pty-session.txt");

async function addProposedDelegation(sessionId: string): Promise<void> {
  const session = await new SessionCatalog(workspace).read(sessionId);
  const template = session.delegations.revisions[0];
  if (template === undefined) throw new Error("Phase 20 PTY fixture has no template delegation");
  const delegationId = randomUUID();
  const content = normalizeDelegationRevision({
    ...template.content,
    binding: { ...template.content.binding },
    delegationId,
    objective: "Reject this exact third delegation from the real TUI.",
    sequence: 3,
    title: "Canonical PTY rejection child",
  });
  const identity = canonicalDelegationIdentity(content);
  const artifact = await storeDelegationArtifactExact(
    workspace,
    sessionId,
    delegationId,
    identity.bytes,
    identity.delegationSha256,
  );
  const writer = await V2SessionWriter.openExisting(workspace, sessionId);
  try {
    await writer.appendDelegationEvent("delegation.revision.proposed", {
      artifact,
      authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
      binding: content.binding,
      content: delegationRevisionContentSchema.parse(content),
      delegation_id: delegationId,
      delegation_revision: 1,
      delegation_sha256: identity.delegationSha256,
      origin: { input_surface: "tui", kind: "user" },
      parent_actor_id: content.binding.parentActorId,
      parent_run_id: content.binding.parentRunId,
    });
  } finally {
    await writer.close();
  }
}

async function seedDelegations(): Promise<string> {
  try {
    return (await readFile(delegationSessionMarker, "utf8")).trim();
  } catch {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "user-state"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nuser-state/\n", "utf8");
    await writeFile(join(workspace, "src", "fact.txt"), "Phase 20 real PTY fixture\n", "utf8");
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Phase 20 PTY Fixture"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "phase20-pty@bornagent.local"], { cwd: workspace });
    await execFileAsync("git", ["add", "--all"], { cwd: workspace });
    await execFileAsync("git", ["commit", "--no-verify", "-m", "Phase 20 PTY baseline"], { cwd: workspace });
    const fixture = await createCanonicalPhase20Fixture({
      count: 2,
      environment: process.env,
      platform: process.platform,
      workspace,
    });
    await addProposedDelegation(fixture.sessionId);
    await writeFile(delegationSessionMarker, `${fixture.sessionId}\n`, "utf8");
    return fixture.sessionId;
  }
}

function phase20CodingBudget() {
  return {
    maxArtifactBytes: 512 * 1024,
    maxAttempts: 2,
    maxChangedBytes: 32 * 1024,
    maxChangedFiles: 4,
    maxCommandExecutions: 2,
    maxCommandOutputBytes: 256 * 1024,
    maxDurationMs: 240_000,
    maxModelSteps: 8,
    maxReportedTokens: 4096,
  };
}

async function seedCodingDelegation(): Promise<string> {
  await mkdir(join(workspace, "fixtures"), { recursive: true });
  await mkdir(join(workspace, "user-state"), { recursive: true });
  await cp(
    fileURLToPath(new URL("../../fixtures/phase-07-fix-and-verify", import.meta.url)),
    join(workspace, "fixtures", "phase-07-fix-and-verify"),
    { recursive: true },
  );
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\nuser-state/\nw/\nplan.json\ngraph.json\n", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "# Phase 20 coding PTY fixture\n", "utf8");
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Phase 20 Coding PTY"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "phase20-coding-pty@bornagent.local"], { cwd: workspace });
  await execFileAsync("git", ["add", "--all"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--no-verify", "-m", "Phase 20 coding PTY baseline"], { cwd: workspace });
  await writeLegacySession(workspace);
  const run = async (argv: readonly string[]): Promise<void> => {
    const io = createMemoryIO();
    const exitCode = await runCli(argv, io.io, runtime);
    if (exitCode !== 0) throw new Error(`Coding delegation PTY seed failed (${String(exitCode)}): ${io.readStderr()}`);
  };
  await run(["goal", "set", SESSION_ID, "--text", "Approve and verify one isolated child patch from the TUI"]);
  const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
  await writeFile(join(workspace, "plan.json"), JSON.stringify({
    items: [{
      acceptance: "The child patch and verification each receive an actor-bound approval.",
      id: "coding-child",
      required: true,
      title: "Run coding child",
    }],
    schema_version: 1,
    title: "Phase 20 coding PTY",
  }), "utf8");
  await run(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"]);
  const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
  await run([
    "plan", "approve", SESSION_ID,
    "--goal-id", goal.content.goalId,
    "--goal-revision", "1",
    "--plan-id", plan.planId,
    "--revision", "1",
    "--sha256", plan.planSha256,
  ]);
  await writeFile(join(workspace, "graph.json"), JSON.stringify({
    binding: {
      goalId: goal.content.goalId,
      goalRevision: 1,
      planId: plan.planId,
      planRevision: 1,
      planSha256: plan.planSha256,
      sessionId: SESSION_ID,
    },
    graphBudget: phase20CodingBudget(),
    graphId: "98000000-0000-4000-8000-000000000020",
    nodes: [{
      agent: { mode: "build", taskProfile: "coding" },
      budget: phase20CodingBudget(),
      dependsOn: [],
      kind: "agent",
      nodeId: "build",
      objective: "Coordinate one isolated child patch.",
      planItemIds: ["coding-child"],
      requiredCapabilities: [],
      retry: { automaticOn: [], maxAttempts: 1 },
      sequence: 1,
      title: "Build isolated fix",
      workspace: { declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"], mode: "managed_worktree" },
    }],
    schemaVersion: 1,
    title: "Phase 20 coding PTY Graph",
  }), "utf8");
  await run(["graph", "replace", SESSION_ID, "--file", "graph.json"]);
  const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
  await run(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256]);
  const allocationRuntime: CliRuntime = {
    ...createNodeRuntime({
    approvalInput: { interactive: true, readLine: async () => "y" },
    capabilityUserStateRoot: join(workspace, "user-state", "capabilities"),
    cliEntryPath: fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
    cwd: workspace,
    delegationUserStateRoot: join(workspace, "user-state", "delegations"),
    env: process.env,
    execPath: process.execPath,
    killProcess: (identity, signal) => process.kill(identity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0-phase20-coding-pty-seed",
    workerUserStateRoot: join(workspace, "user-state", "workers"),
      worktreeUserStateRoot: join(workspace, "w"),
    }),
    // Fixture-only seed path: allocation deliberately bypasses the product
    // Application Host so the real TUI can start from an already-managed
    // coding worktree. AS4 requires that bypass to be explicit capability.
    domainHarness: createDomainHarness(),
  };
  const allocationIo = createMemoryIO();
  const allocationManager = await allocationRuntime.createManagedWorktreeManager?.({
    io: allocationIo.io,
    sessionId: SESSION_ID,
  });
  if (allocationManager === undefined) {
    throw new Error("Coding delegation PTY worktree manager is unavailable");
  }
  await allocationManager.allocate({
    allowDirty: false,
    graphRevision: 1,
    graphSha256: graph.graphSha256,
    signal: new AbortController().signal,
    sourceNodeId: "build",
  });
  const managed = (await new SessionCatalog(workspace).read(SESSION_ID)).worktrees.workspaces[0]!;
  await createCanonicalPhase20CodingFixture({
    graphId: graph.graphId,
    graphRevision: graph.revision,
    graphSha256: graph.graphSha256,
    goalId: goal.content.goalId,
    goalObjective: goal.content.objective,
    goalRevision: goal.content.revision,
    managedWorkspaceBaselineSha256: managed.baseline.manifestSha256,
    managedWorkspaceId: managed.identity.workspaceId,
    nodeId: "build",
    planId: plan.planId,
    planRevision: 1,
    planSha256: plan.planSha256,
    sessionId: SESSION_ID,
    workspace,
  });
  return SESSION_ID;
}

if (graphLifecycle) await seedGraph();
const delegationSessionId = delegationLifecycle ? await seedDelegations() : SESSION_ID;
const codingDelegationSessionId = delegationCodingAnyLifecycle ? await seedCodingDelegation() : SESSION_ID;
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

// This PTY fixture seeds product facts and launches the interactive TUI in one
// Node process. Real CLI and TUI invocations have separate process lifetimes;
// close the seed Host explicitly so the TUI creates its one state-root Host
// with TUI approval/presentation ports rather than reusing the seed CLI ports.
if (runtime.controlPlaneStateRoot !== undefined) {
  await disposeApplicationHostForStateRoot(runtime.controlPlaneStateRoot);
}

const exitCode = await runCli(
  delegationCodingAnyLifecycle
    ? [
        "tui",
        "--inspect-session",
        codingDelegationSessionId,
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ]
    : delegationLifecycle
    ? [
        "tui",
        "--inspect-session",
        delegationSessionId,
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ]
    : graphLifecycle
    ? [
        "tui",
        "--inspect-session",
        SESSION_ID,
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
if (delegationLifecycle) {
  const session = await new SessionCatalog(workspace).read(delegationSessionId);
  process.stdout.write(`\nPTY_DELEGATION_SNAPSHOT=${JSON.stringify({
    accepted: session.delegations.revisions.filter((revision) => revision.status === "accepted").length,
    childStartCount: session.events.filter((event) => event.scope === "session" && event.type === "delegation.child.started").length,
    rejected: session.delegations.revisions.filter((revision) => revision.status === "rejected").length,
    receipts: session.delegations.revisions.filter((revision) => revision.receipt?.status === "succeeded").length,
  })}\n`);
}
if (delegationCodingAnyLifecycle) {
  const session = await new SessionCatalog(workspace).read(codingDelegationSessionId);
  const codingSnapshot = {
    accepted: session.delegations.revisions.filter((revision) => revision.status === "accepted").length,
    activeActorSlots: session.delegations.activeActorSlots.length,
    activeConflictClaims: session.delegations.activeConflictClaims.length,
    approvedEffects: session.events.filter((event) => event.scope === "run" && event.type === "approval.decided" && event.data.decision === "approved").length,
    cancelRequests: session.events.filter((event) => event.scope === "session" && event.type === "delegation.cancel.requested").length,
    cancelled: session.delegations.revisions.filter((revision) => revision.status === "cancelled").length,
    childApprovalRequests: session.events.filter((event) => event.scope === "session" && event.type === "delegation.child.approval_waiting").length,
    childStartCount: session.events.filter((event) => event.scope === "session" && event.type === "delegation.child.started").length,
  };
  process.stdout.write(delegationCodingCancelLifecycle || delegationCodingExitCancelLifecycle
    ? `\nPTY_CODING_CANCEL_SNAPSHOT=${JSON.stringify(codingSnapshot)}\n`
    : `\nPTY_CODING_DELEGATION_SNAPSHOT=${JSON.stringify(codingSnapshot)}\n`);
}
process.stdout.write(`\nPTY_APP_EXIT=${String(exitCode)}\n`);
process.exitCode = exitCode;
