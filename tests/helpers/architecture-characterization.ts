import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { z } from "zod";

import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { runCli } from "../../src/cli/run-cli.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { DELEGATION_DURABLE_CANCEL_POLL_INTERVALS_V1 } from "../../src/delegation/runtime/child-launcher.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { SessionCatalog, type SessionCatalogObservationV1 } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { parseStrictJson } from "../../src/system/strict-json.js";
import {
  captureWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_LIMITS_V1,
  type WorkspaceCaptureObservationV1,
} from "../../src/worktrees/workspace-baseline.js";
import { FakeStreamingChatClient, fixedStream, waitForAbort } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime, InMemorySessionWriter } from "../helpers.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const BASELINE_PATH = "tests/evidence/architecture-simplification-characterization-v3.json";
const PREVIOUS_BASELINE_SHA256 = "aae8e113f8ca161a60a67052517978b28c65000d72b42a7601cecc0cad5ee27e";
const SESSION_ID = "70000000-0000-4000-8000-000000000020";
const RUN_ID = "71000000-0000-4000-8000-000000000020";
const OPERATION_ID = "10000000-0000-4000-8000-000000000019";
const REPOSITORY_ID = "a".repeat(64);
const WORKER_ID = "20000000-0000-4000-8000-000000000019";

const dependencyViolationSchema = z.object({
  from: z.string().min(1),
  importKind: z.enum(["type", "value"]),
  ruleId: z.string().min(1),
  to: z.string().min(1),
}).strict();

const architectureCharacterizationSchema = z.object({
  agentTerminalGoldens: z.array(z.object({
    eventTypes: z.array(z.string().min(1)),
    exitCode: z.number().int(),
    modelCallCount: z.number().int().nonnegative(),
    scenario: z.string().min(1),
    terminalType: z.string().min(1).nullable(),
    writerClosed: z.boolean(),
  }).strict()).min(1),
  backgroundHandoff: z.object({
    crashPrefixes: z.array(z.object({
      durableState: z.enum(["original", "next"]),
      faultPointId: z.string().min(1),
      retryOutcome: z.string().min(1),
    }).strict()).min(1),
    faultPoints: z.array(z.object({
      anchor: z.string().min(1),
      id: z.string().min(1),
      order: z.number().int().positive(),
    }).strict()).min(1),
    twoProcessCas: z.object({
      conflictCount: z.number().int().nonnegative(),
      contenderCount: z.number().int().positive(),
      finalOwner: z.enum(["parent", "worker"]),
      finalState: z.enum(["launching", "worker_owned", "terminal", "reconciliation_required"]),
      winnerCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  baselineId: z.literal("architecture-simplification-characterization-v3"),
  dependencyBoundaries: z.object({
    rules: z.array(z.object({
      description: z.string().min(1),
      id: z.string().min(1),
    }).strict()).min(1),
    violations: z.array(dependencyViolationSchema),
  }).strict(),
  generatedBy: z.literal("pnpm architecture:characterize"),
  previousBaselineSha256: z.string().regex(SHA256),
  reproduction: z.array(z.string().min(1)).min(1),
  schemaVersion: z.literal(1),
  sessionReads: z.object({
    catalogFullScanCount: z.number().int().nonnegative(),
    exclusiveSnapshotCount: z.number().int().nonnegative(),
    fixtureEventCount: z.number().int().positive(),
    fullProjectionCount: z.number().int().nonnegative(),
    polling: z.object({
      activeChild: z.object({
        immediateReadCount: z.number().int().nonnegative(),
        intervalMs: z.number().int().positive(),
        readAttemptsPerIdleSecond: z.number().int().nonnegative(),
      }).strict(),
      preStart: z.object({
        immediateReadCount: z.number().int().nonnegative(),
        intervalMs: z.number().int().positive(),
        readAttemptsPerIdleSecond: z.number().int().nonnegative(),
      }).strict(),
    }).strict(),
  }).strict(),
  surfaceRoutes: z.array(z.object({
    legacyAuthority: z.literal("explicit_domain_harness"),
    legacyFile: z.string().min(1),
    legacyToken: z.string().min(1),
    productAuthority: z.literal("application_service"),
    productFile: z.string().min(1),
    productToken: z.string().min(1),
    surfaceId: z.string().min(1),
  }).strict()).min(1),
  workspaceSnapshot: z.object({
    entryCount: z.number().int().positive(),
    limits: z.object({
      maxDepth: z.number().int().positive(),
      maxFileBytes: z.number().int().positive(),
      maxFiles: z.number().int().positive(),
      maxPathBytes: z.number().int().positive(),
      maxTotalBytes: z.number().int().positive(),
    }).strict(),
    materializeLimitCheckAfterPayloadReadCount: z.number().int().nonnegative(),
    payloadBytesRead: z.number().int().nonnegative(),
    payloadReadCount: z.number().int().nonnegative(),
    retainedPayloadBytes: z.number().int().nonnegative(),
    returnedPayloadBytes: z.number().int().nonnegative(),
    snapshotSha256: z.string().regex(SHA256),
    totalBytes: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const unique = (items: readonly string[], path: readonly (string | number)[]) => {
    if (new Set(items).size !== items.length) context.addIssue({ code: "custom", message: "characterization identities must be unique", path: [...path] });
  };
  unique(value.agentTerminalGoldens.map((item) => item.scenario), ["agentTerminalGoldens"]);
  unique(value.backgroundHandoff.faultPoints.map((item) => item.id), ["backgroundHandoff", "faultPoints"]);
  unique(value.dependencyBoundaries.rules.map((item) => item.id), ["dependencyBoundaries", "rules"]);
  unique(value.reproduction, ["reproduction"]);
  unique(value.surfaceRoutes.map((item) => item.surfaceId), ["surfaceRoutes"]);
});

export type ArchitectureCharacterizationV1 = Readonly<z.infer<typeof architectureCharacterizationSchema>>;

interface DependencyRuleV1 {
  readonly description: string;
  readonly id: string;
  readonly matches: (from: string, to: string) => boolean;
}

const DEPENDENCY_RULES: readonly DependencyRuleV1[] = Object.freeze([
  {
    description: "control-plane adapters do not own command-layer implementations",
    id: "control-plane-adapter-to-command",
    matches: (from, to) => from.startsWith("src/control-plane/adapters/") && to.startsWith("src/commands/"),
  },
  {
    description: "domain and runtime modules do not depend on CLI, command, or TUI surfaces",
    id: "domain-runtime-to-surface",
    matches: (from, to) => /^(?:src\/(?:agent|background|delegation|scheduling|sessions|task-graph|worktrees)\/)/u.test(from) &&
      /^(?:src\/(?:cli|commands|tui)\/)/u.test(to),
  },
  {
    description: "core MCP, repository, and tool modules do not depend on TUI presentation",
    id: "core-to-tui",
    matches: (from, to) => /^(?:src\/(?:mcp|repository-intelligence|tools)\/)/u.test(from) && to.startsWith("src/tui/"),
  },
  {
    description: "application use cases do not depend on CLI, command, or TUI surfaces",
    id: "use-case-to-surface",
    matches: (from, to) => from.startsWith("src/control-plane/use-cases/") && /^(?:src\/(?:cli|commands|tui)\/)/u.test(to),
  },
]);

const SURFACE_ROUTES = Object.freeze([
  {
    legacyAuthority: "explicit_domain_harness" as const,
    legacyFile: "src/control-plane/adapters/agent-cli-adapter.ts",
    legacyToken: "isDomainHarnessRuntime(runtime)",
    productAuthority: "application_service" as const,
    productFile: "src/cli/run-cli.ts",
    productToken: "executeAgentThroughApplicationService",
    surfaceId: "agent",
  },
  {
    legacyAuthority: "explicit_domain_harness" as const,
    legacyFile: "src/control-plane/adapters/chat-application-cli-adapter.ts",
    legacyToken: "isDomainHarnessRuntime(runtime)",
    productAuthority: "application_service" as const,
    productFile: "src/cli/run-cli.ts",
    productToken: "executeChatThroughApplicationService",
    surfaceId: "chat",
  },
  ...["goal", "plan", "graph", "delegations"].map((surfaceId) => ({
    legacyAuthority: "explicit_domain_harness" as const,
    legacyFile: `src/commands/${surfaceId}.ts`,
    legacyToken: "isDomainHarnessRuntime(runtime)",
    productAuthority: "application_service" as const,
    productFile: `src/commands/${surfaceId}.ts`,
    productToken: "executeTaskActionThroughApplicationService",
    surfaceId,
  })),
  {
    legacyAuthority: "explicit_domain_harness" as const,
    legacyFile: "src/commands/sessions.ts",
    legacyToken: "isDomainHarnessRuntime(runtime)",
    productAuthority: "application_service" as const,
    productFile: "src/commands/sessions.ts",
    productToken: "executeSessionResumeThroughRuntimeAdapter",
    surfaceId: "sessions",
  },
  {
    legacyAuthority: "explicit_domain_harness" as const,
    legacyFile: "src/tui/run-tui.ts",
    legacyToken: "isDomainHarnessRuntime(runtime)",
    productAuthority: "application_service" as const,
    productFile: "src/tui/run-tui.ts",
    productToken: "executeAgentThroughApplicationService",
    surfaceId: "tui",
  },
]);

const HANDOFF_FAULT_POINTS = Object.freeze([
  { anchor: "await exclusiveRecord(lock", id: "handoff.lock.durable", order: 1 },
  { anchor: "const current = await this.readHandoff()", id: "handoff.current.read", order: 2 },
  { anchor: "await exclusiveRecord(temporary", id: "handoff.candidate.durable", order: 3 },
  { anchor: "await rename(temporary, target)", id: "handoff.rename.complete", order: 4 },
  { anchor: "await unlink(lock)", id: "handoff.lock.removed", order: 5 },
]);

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

async function listTypeScriptFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.endsWith(".ts")) result.push(path);
    }
  };
  await visit(root);
  return Object.freeze(result);
}

function resolvedImport(from: string, specifier: string, workspaceRoot: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const supplied = resolve(dirname(from), specifier);
  const candidates = [
    supplied.replace(/\.js$/u, ".ts"),
    supplied.replace(/\.mjs$/u, ".mts"),
    `${supplied}.ts`,
    join(supplied, "index.ts"),
  ];
  const candidate = candidates.find((path) => relative(workspaceRoot, path).split(sep).join("/").startsWith("src/"));
  return candidate === undefined ? null : posix(relative(workspaceRoot, candidate));
}

function importKind(node: ts.ImportDeclaration | ts.ExportDeclaration): "type" | "value" {
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return "type";
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly === true) return "type";
    if (
      clause?.name === undefined && clause?.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    ) return "type";
  }
  return "value";
}

async function characterizeDependencies(workspaceRoot: string) {
  const violations: z.infer<typeof dependencyViolationSchema>[] = [];
  for (const file of await listTypeScriptFiles(resolve(workspaceRoot, "src"))) {
    const from = posix(relative(workspaceRoot, file));
    const source = await readFile(file, "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const node of parsed.statements) {
      if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const to = resolvedImport(file, node.moduleSpecifier.text, workspaceRoot);
      if (to === null) continue;
      for (const rule of DEPENDENCY_RULES) {
        if (rule.matches(from, to)) violations.push({ from, importKind: importKind(node), ruleId: rule.id, to });
      }
    }
  }
  violations.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en"));
  return Object.freeze({
    rules: Object.freeze(DEPENDENCY_RULES.map(({ description, id }) => Object.freeze({ description, id }))),
    violations: Object.freeze(violations.map((item) => Object.freeze(item))),
  });
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await lstat(path).then(() => true).catch(() => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${path}`);
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

function initialHandoff() {
  return Object.freeze({
    graphSha256: "b".repeat(64),
    operationId: OPERATION_ID,
    owner: "worker" as const,
    ownerPid: 6001,
    ownerProcessStartIdentity: "worker-start",
    parentNonceSha256: "c".repeat(64),
    schemaVersion: 1 as const,
    state: "worker_owned" as const,
    updatedAt: "2026-08-13T00:00:00.000Z",
    workerId: WORKER_ID,
    workerNonceSha256: "d".repeat(64),
  });
}

function terminalHandoff() {
  return Object.freeze({
    ...initialHandoff(),
    owner: "parent" as const,
    ownerPid: 7000,
    ownerProcessStartIdentity: "parent-terminal",
    state: "terminal" as const,
    updatedAt: "2026-08-13T00:00:03.000Z",
  });
}

async function characterizeHandoff(workspaceRoot: string, temporaryRoot: string) {
  const source = await readFile(resolve(workspaceRoot, "src/background/background-operation-store.ts"), "utf8");
  for (const point of HANDOFF_FAULT_POINTS) {
    if (!source.includes(point.anchor)) throw new Error(`handoff fault-point anchor disappeared: ${point.id}`);
  }

  const raceRoot = join(temporaryRoot, "race");
  const raceStore = await BackgroundOperationStore.create({ operationId: OPERATION_ID, repositoryId: REPOSITORY_ID, root: raceRoot });
  await raceStore.createHandoff(initialHandoff());
  const gate = join(temporaryRoot, "contenders.go");
  const readyA = join(temporaryRoot, "contender-a.ready");
  const readyB = join(temporaryRoot, "contender-b.ready");
  const fixture = resolve(workspaceRoot, "tests/fixtures/architecture-handoff-cas-contender.ts");
  const makeChild = (variant: "a" | "b", ready: string) => spawn(process.execPath, [
    "--import", "tsx", fixture, raceRoot, REPOSITORY_ID, OPERATION_ID, variant, gate, ready,
  ], { cwd: workspaceRoot, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const childA = makeChild("a", readyA);
  const childB = makeChild("b", readyB);
  const resultA = collectChild(childA);
  const resultB = collectChild(childB);
  await Promise.all([waitForPath(readyA), waitForPath(readyB)]);
  await writeFile(gate, "go\n", { encoding: "utf8", flag: "wx" });
  const contenderResults = await Promise.all([resultA, resultB]);
  if (contenderResults.some((result) => ![0, 8].includes(result.code ?? -1))) {
    throw new Error(`handoff contender failed unexpectedly: ${JSON.stringify(contenderResults)}`);
  }
  const final = await raceStore.readHandoff();
  if (final === null) throw new Error("handoff race lost its durable record");

  const orphanRoot = join(temporaryRoot, "orphan-lock");
  const orphanStore = await BackgroundOperationStore.create({ operationId: OPERATION_ID, repositoryId: REPOSITORY_ID, root: orphanRoot });
  await orphanStore.createHandoff(initialHandoff());
  await writeFile(join(orphanStore.paths.operation, ".handoff.lock"), "{\"nonce\":\"orphan\"}\n", "utf8");
  let orphanOutcome = "unexpected_success";
  try {
    await orphanStore.compareAndSwapHandoff({
      expectedOwner: "worker",
      expectedState: "worker_owned",
      next: terminalHandoff(),
      nonce: "retry-orphan",
    });
  } catch (error) {
    orphanOutcome = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  }
  const orphanDurable = await orphanStore.readHandoff();

  const responseRoot = join(temporaryRoot, "response-loss");
  const responseStore = await BackgroundOperationStore.create({ operationId: OPERATION_ID, repositoryId: REPOSITORY_ID, root: responseRoot });
  await responseStore.createHandoff(initialHandoff());
  await responseStore.compareAndSwapHandoff({
    expectedOwner: "worker",
    expectedState: "worker_owned",
    next: terminalHandoff(),
    nonce: "response-loss",
  });
  await writeFile(join(responseStore.paths.operation, ".handoff.lock"), "{\"nonce\":\"response-lost\"}\n", "utf8");
  let responseOutcome = "unexpected_success";
  try {
    await responseStore.compareAndSwapHandoff({
      expectedOwner: "worker",
      expectedState: "worker_owned",
      next: terminalHandoff(),
      nonce: "response-loss-retry",
    });
  } catch (error) {
    responseOutcome = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  }
  const responseDurable = await responseStore.readHandoff();

  return Object.freeze({
    crashPrefixes: Object.freeze([
      Object.freeze({
        durableState: orphanDurable?.state === "worker_owned" ? "original" as const : "next" as const,
        faultPointId: "handoff.lock.durable",
        retryOutcome: orphanOutcome,
      }),
      Object.freeze({
        durableState: responseDurable?.state === "terminal" ? "next" as const : "original" as const,
        faultPointId: "handoff.rename.complete",
        retryOutcome: responseOutcome,
      }),
    ]),
    faultPoints: HANDOFF_FAULT_POINTS,
    twoProcessCas: Object.freeze({
      conflictCount: contenderResults.filter((result) => result.code === 8).length,
      contenderCount: contenderResults.length,
      finalOwner: final.owner,
      finalState: final.state,
      winnerCount: contenderResults.filter((result) => result.code === 0).length,
    }),
  });
}

async function characterizeWorkspace(temporaryRoot: string) {
  const workspaceRoot = join(temporaryRoot, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, ".bornagent"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "BornAgent AS0.2\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(workspaceRoot, ".bornagent", "ignored.txt"), "not part of snapshot\n", "utf8");

  let payloadReadCount = 0;
  let payloadBytesRead = 0;
  let retainedPayloadBytes = 0;
  let returnedPayloadBytes = 0;
  let materializeLimitCheckAfterPayloadReadCount = -1;
  const observation: WorkspaceCaptureObservationV1 = {
    onLimitCheck: (event) => {
      if (event.pass === "snapshot_materialize") materializeLimitCheckAfterPayloadReadCount = payloadReadCount;
    },
    onPayloadRead: (event) => {
      payloadReadCount += 1;
      payloadBytesRead += event.bytes;
    },
    onRetainedPayloadBytes: (bytes) => {
      retainedPayloadBytes = Math.max(retainedPayloadBytes, bytes);
      returnedPayloadBytes = bytes;
    },
  };
  const captured = await captureWorkspaceSnapshot({
    baselineManifestSha256: "e".repeat(64),
    observation,
    workspaceId: "72000000-0000-4000-8000-000000000020",
    workspaceRoot,
  });
  return Object.freeze({
    entryCount: captured.manifest.entries.length,
    limits: WORKSPACE_SNAPSHOT_LIMITS_V1,
    materializeLimitCheckAfterPayloadReadCount,
    payloadBytesRead,
    payloadReadCount,
    retainedPayloadBytes,
    returnedPayloadBytes,
    snapshotSha256: captured.manifest.snapshotSha256,
    totalBytes: captured.manifest.totalBytes,
  });
}

function uuidSequence(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `73000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

async function characterizeSessionReads(temporaryRoot: string) {
  const workspace = join(temporaryRoot, "session-workspace");
  await mkdir(workspace, { recursive: true });
  const writer = await V2SessionWriter.createNew(workspace, SESSION_ID, {
    createEventId: uuidSequence(),
    timestamp: () => "2026-08-13T00:00:00.000Z",
  });
  const publisher = new EventPublisher({
    randomUUID: uuidSequence(),
    renderer: { render: () => undefined },
    runId: RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => "2026-08-13T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "AS0.2 session read fixture" },
      model: "qwen3:1.7b",
      provider: "ollama",
      timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "pi-ai",
      adapter_version: "0.80.7",
      capabilities: { cancellation: "abort_signal", reasoning: "none", streaming: true, tools: "best_effort", usage: "complete" },
      config_fingerprint: "f".repeat(64),
      model: "qwen3:1.7b",
      provider: "ollama",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
  await publisher.publish({ data: { delta: "done" }, type: "text.delta" });
  await publisher.publish({ data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, type: "usage" });
  await publisher.publish({ data: { duration_ms: 1, output_chars: 4 }, type: "run.completed" });
  const fixtureEventCount = writer.events.length;
  await writer.close();

  let catalogFullScanCount = 0;
  let exclusiveSnapshotCount = 0;
  let fullProjectionCount = 0;
  const observation: SessionCatalogObservationV1 = {
    onCatalogFullScan: () => { catalogFullScanCount += 1; },
    onExclusiveSnapshot: () => { exclusiveSnapshotCount += 1; },
    onFullProjection: () => { fullProjectionCount += 1; },
  };
  const catalog = new SessionCatalog(workspace, observation);
  await catalog.scan();
  await catalog.read(SESSION_ID);
  const polling = (intervalMs: number) => Object.freeze({
    immediateReadCount: 1,
    intervalMs,
    readAttemptsPerIdleSecond: 1 + Math.floor(1_000 / intervalMs),
  });
  return Object.freeze({
    catalogFullScanCount,
    exclusiveSnapshotCount,
    fixtureEventCount,
    fullProjectionCount,
    polling: Object.freeze({
      activeChild: polling(DELEGATION_DURABLE_CANCEL_POLL_INTERVALS_V1.activeChildMs),
      preStart: polling(DELEGATION_DURABLE_CANCEL_POLL_INTERVALS_V1.preStartMs),
    }),
  });
}

async function agentScenario(input: Readonly<{
  args?: readonly string[];
  behavior: ConstructorParameters<typeof FakeStreamingChatClient>[0];
  runtime?: Parameters<typeof createRuntime>[0];
  scenario: string;
  writer?: InMemorySessionWriter;
}>) {
  const writer = input.writer ?? new InMemorySessionWriter();
  const client = new FakeStreamingChatClient(input.behavior);
  const io = createMemoryIO();
  const exitCode = await runCli([
    "agent", "AS0.2 terminal golden", "--task-profile", "read-only", ...(input.args ?? []),
  ], io.io, createRuntime({
    createModelBackend: () => client,
    createSessionWriter: async () => writer,
    ...input.runtime,
  }));
  return Object.freeze({
    eventTypes: Object.freeze(writer.events.map((event) => event.type)),
    exitCode,
    modelCallCount: client.calls.length,
    scenario: input.scenario,
    terminalType: writer.events.at(-1)?.type.startsWith("run.") === true ? writer.events.at(-1)!.type : null,
    writerClosed: writer.closed,
  });
}

async function characterizeAgentTerminals() {
  const completed = await agentScenario({ behavior: fixedStream(["AS0.2 complete"]), scenario: "completed" });

  const timeout = await agentScenario({
    args: ["--request-timeout-ms", "1000"],
    behavior: waitForAbort(),
    runtime: {
      clearTimer: () => undefined,
      setTimer: (listener, delayMs) => {
        if (delayMs === 1_000) queueMicrotask(listener);
        return { delayMs };
      },
    },
    scenario: "request_timeout",
  });

  let cancelListener: (() => void) | undefined;
  const cancelled = await agentScenario({
    behavior: async function* (request, signal) {
      queueMicrotask(() => cancelListener?.());
      yield* waitForAbort()(request, signal);
    },
    runtime: {
      onCancel: (listener) => {
        cancelListener = listener;
        return () => { cancelListener = undefined; };
      },
    },
    scenario: "user_cancelled",
  });

  const persistenceWriter = new InMemorySessionWriter("memory://as0.2-persistence", (event) => {
    if (event.type === "agent.step.started") throw new Error("AS0.2 injected persistence failure");
  });
  const persistence = await agentScenario({
    behavior: fixedStream(["must not be requested"]),
    scenario: "persistence_failure",
    writer: persistenceWriter,
  });
  return Object.freeze([completed, timeout, cancelled, persistence]);
}

async function characterizeSurfaceRoutes(workspaceRoot: string) {
  for (const route of SURFACE_ROUTES) {
    const product = await readFile(resolve(workspaceRoot, route.productFile), "utf8");
    const legacy = route.legacyFile === route.productFile ? product : await readFile(resolve(workspaceRoot, route.legacyFile), "utf8");
    if (!product.includes(route.productToken)) throw new Error(`product route disappeared: ${route.surfaceId}`);
    if (!legacy.includes(route.legacyToken)) throw new Error(`legacy route disappeared: ${route.surfaceId}`);
  }
  return SURFACE_ROUTES;
}

export function parseArchitectureCharacterization(source: string): ArchitectureCharacterizationV1 {
  return Object.freeze(architectureCharacterizationSchema.parse(parseStrictJson(source)));
}

export function architectureCharacterizationSource(value: ArchitectureCharacterizationV1): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function architectureCharacterizationSha256(value: ArchitectureCharacterizationV1): string {
  return sha256(canonicalJson(value));
}

export async function generateArchitectureCharacterization(workspaceRoot: string): Promise<ArchitectureCharacterizationV1> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-as0.2-characterization-"));
  try {
    const value = {
      agentTerminalGoldens: await characterizeAgentTerminals(),
      backgroundHandoff: await characterizeHandoff(workspaceRoot, temporaryRoot),
      baselineId: "architecture-simplification-characterization-v3" as const,
      dependencyBoundaries: await characterizeDependencies(workspaceRoot),
      generatedBy: "pnpm architecture:characterize" as const,
      previousBaselineSha256: PREVIOUS_BASELINE_SHA256,
      reproduction: Object.freeze([
        "pnpm architecture:characterize -- --write",
        "pnpm architecture:characterize -- --check --report test-results/architecture-as0.2-command.json",
        "pnpm test tests/unit/architecture-simplification-characterization.test.ts --maxWorkers=1 --reporter=json --outputFile=test-results/architecture-as0.2-vitest.json",
        "pnpm architecture:gate -- --profile metric --report test-results/architecture-as0.2-command.json --report-argv-json [\"pnpm\",\"architecture:characterize\",\"--\",\"--check\",\"--report\",\"test-results/architecture-as0.2-command.json\"] --report test-results/architecture-as0.2-vitest.json --report-argv-json [\"pnpm\",\"test\",\"tests/unit/architecture-simplification-characterization.test.ts\",\"--maxWorkers=1\",\"--reporter=json\",\"--outputFile=test-results/architecture-as0.2-vitest.json\"] --receipt-out test-results/architecture-as0.2-receipt.json",
      ]),
      schemaVersion: 1 as const,
      sessionReads: await characterizeSessionReads(temporaryRoot),
      surfaceRoutes: await characterizeSurfaceRoutes(workspaceRoot),
      workspaceSnapshot: await characterizeWorkspace(temporaryRoot),
    };
    return Object.freeze(architectureCharacterizationSchema.parse(value));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function readTrackedArchitectureCharacterization(workspaceRoot: string): Promise<ArchitectureCharacterizationV1> {
  return parseArchitectureCharacterization(await readFile(resolve(workspaceRoot, BASELINE_PATH), "utf8"));
}

export function architectureCharacterizationMetrics(value: ArchitectureCharacterizationV1): Readonly<Record<string, number>> {
  return Object.freeze({
    "as0.2.agent-terminal-scenario-count": value.agentTerminalGoldens.length,
    "as0.2.dependency-violation-count": value.dependencyBoundaries.violations.length,
    "as0.2.handoff-cas-conflict-count": value.backgroundHandoff.twoProcessCas.conflictCount,
    "as0.2.handoff-cas-winner-count": value.backgroundHandoff.twoProcessCas.winnerCount,
    "as0.2.handoff-fault-point-count": value.backgroundHandoff.faultPoints.length,
    "as0.2.session-catalog-full-scan-count": value.sessionReads.catalogFullScanCount,
    "as0.2.session-exclusive-snapshot-count": value.sessionReads.exclusiveSnapshotCount,
    "as0.2.session-full-projection-count": value.sessionReads.fullProjectionCount,
    "as0.2.session-poll-active-read-attempts": value.sessionReads.polling.activeChild.readAttemptsPerIdleSecond,
    "as0.2.session-poll-prestart-read-attempts": value.sessionReads.polling.preStart.readAttemptsPerIdleSecond,
    "as0.2.surface-route-count": value.surfaceRoutes.length,
    "as0.2.workspace-payload-bytes-read": value.workspaceSnapshot.payloadBytesRead,
    "as0.2.workspace-payload-read-count": value.workspaceSnapshot.payloadReadCount,
    "as0.2.workspace-retained-payload-bytes": value.workspaceSnapshot.retainedPayloadBytes,
  });
}

export const ARCHITECTURE_CHARACTERIZATION_BASELINE_PATH = BASELINE_PATH;
