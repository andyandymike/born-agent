import { Command, CommanderError, Option } from "commander";

import { executeAgentThroughApplicationService } from "../control-plane/adapters/agent-cli-adapter.js";
import { executeChatThroughApplicationService } from "../control-plane/adapters/chat-application-cli-adapter.js";
import { executeDoctor } from "../commands/doctor.js";
import { executeModels } from "../commands/models.js";
import {
  executeModelsQualificationRemove,
  executeModelsQualificationShow,
  executeModelsQualify,
} from "../commands/model-qualification.js";
import {
  executeSessionsList,
  executeSessionsResume,
  executeSessionsShow,
} from "../commands/sessions.js";
import type { CliIO, CliRuntime } from "./types.js";
import { executeTui } from "../tui/run-tui.js";
import {
  executeMcpInspect,
  executeMcpList,
  executeMcpPromptGet,
  executeMcpPromptsList,
} from "../commands/mcp.js";
import { executeSandboxDoctor } from "../commands/sandbox-doctor.js";
import { executeEvalCompare, executeEvalList, executeEvalRun, executeEvalShow } from "../evals/eval-cli.js";
import { executeDockerPrepare, executeDockerStatus } from "../commands/docker.js";
import { executePolicyExplain, executePolicyShow, executePolicyValidate } from "../commands/policy.js";
import {
  executeGoalAbandon,
  executeGoalNew,
  executeGoalSet,
  executeGoalShow,
} from "../commands/goal.js";
import {
  executePlanApprove,
  executePlanReject,
  executePlanReplace,
  executePlanShow,
} from "../commands/plan.js";
import {
  executeRepoIndex,
  executeRepoQueryOutline,
  executeRepoQueryReferences,
  executeRepoQuerySymbol,
  executeRepoStatus,
} from "../commands/repo.js";
import {
  executeCapabilitiesDoctor,
  executeCapabilitiesList,
  executeCapabilitiesShow,
} from "../commands/capabilities.js";
import { executeSkillsList, executeSkillsShow } from "../commands/skills.js";
import {
  executePluginsDisable,
  executePluginsEnable,
  executePluginsInspect,
  executePluginsInstall,
  executePluginsList,
  executePluginsRemove,
  executePluginsShow,
} from "../commands/plugins.js";
import { executeHooksExplain, executeHooksList } from "../commands/hooks.js";
import {
  executeGraphApprove,
  executeGraphCancel,
  executeGraphDoctor,
  executeGraphEnqueue,
  executeGraphLogs,
  executeGraphReject,
  executeGraphReplace,
  executeGraphRun,
  executeGraphPromote,
  executeGraphOriginVerify,
  executeGraphResume,
  executeGraphRetry,
  executeGraphShow,
  executeGraphStatus,
  executeGraphValidate,
  executeGraphWorktrees,
  executeGraphWorktreeAllocate,
  executeGraphWorktreeCleanup,
  executeGraphWorkerDoctor,
} from "../commands/graph.js";
import { executeInternalGraphWorker } from "../commands/internal-graph-worker.js";
import { executeInternalHookCommandSupervisor } from "../commands/internal-hook-command-supervisor.js";
import { executeInternalDelegationChild } from "../commands/internal-delegation-child.js";
import {
  executeDelegationsApprove,
  executeDelegationsCancel,
  executeDelegationsDoctor,
  executeDelegationsList,
  executeDelegationsPrepare,
  executeDelegationsPropose,
  executeDelegationsReceipt,
  executeDelegationsReject,
  executeDelegationsResume,
  executeDelegationsShow,
  executeDelegationsStart,
} from "../commands/delegations.js";

function collectOption(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

export async function runCli(
  argv: readonly string[],
  io: CliIO,
  runtime: CliRuntime,
): Promise<number> {
  const program = new Command()
    .name("born")
    .description("A learning-first coding agent.")
    .version(runtime.version, "-V, --version")
    .exitOverride()
    .configureOutput({
      outputError: (text, write) => write(text),
      writeErr: (text) => io.stderr.write(text),
      writeOut: (text) => io.stdout.write(text),
    });

  let commandExitCode = 0;

  const memory = program
    .command("memory")
    .description("Inspect and manage repository-scoped exact-source local memory.");

  memory
    .command("status")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean }) => {
      const { executeMemoryStatus } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryStatus(options, runtime, io);
    });

  memory
    .command("list")
    .option("--limit <count>", "page size from 1 to 100")
    .option("--cursor <cursor>", "scope-bound continuation cursor")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { cursor?: string; json: boolean; limit?: string }) => {
      const { executeMemoryList } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryList(options, runtime, io);
    });

  memory
    .command("search")
    .argument("<query>", "exact episode ID, quoted phrase, or lexical terms")
    .option("--limit <count>", "result count from 1 to 20")
    .option("--explain", "show deterministic rank components", false)
    .option("--json", "write versioned JSON", false)
    .action(async (query: string, options: { explain: boolean; json: boolean; limit?: string }) => {
      const { executeMemorySearch } = await import("../commands/memory.js");
      commandExitCode = await executeMemorySearch(query, options, runtime, io);
    });

  memory
    .command("show")
    .argument("<record-id>", "exact episode or explicit memory record ID")
    .option("--json", "write versioned JSON", false)
    .action(async (recordId: string, options: { json: boolean }) => {
      const { executeMemoryShow } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryShow(recordId, options, runtime, io);
    });

  memory
    .command("remember")
    .argument("<kind>", "fact, preference, decision, or constraint")
    .argument("<text>", "bounded explicit memory text")
    .option("--supersedes <record-id>", "replace one active explicit record with a new revision")
    .option("--json", "write versioned JSON", false)
    .action(async (
      kind: string,
      text: string,
      options: { json: boolean; supersedes?: string },
    ) => {
      const { executeMemoryRemember } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryRemember(kind, text, options, runtime, io);
    });

  memory
    .command("retract")
    .argument("<record-id>", "exact active episode or explicit memory record ID")
    .option("--json", "write versioned JSON", false)
    .action(async (recordId: string, options: { json: boolean }) => {
      const { executeMemoryRetract } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryRetract(recordId, options, runtime, io);
    });

  memory
    .command("rebuild")
    .description("Delete and rebuild the current scope's derived FTS projection.")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean }) => {
      const { executeMemoryRebuild } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryRebuild(options, runtime, io);
    });

  memory
    .command("doctor")
    .description("Diagnose canonical SQLite, sources, capacity, permissions, and FTS.")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean }) => {
      const { executeMemoryDoctor } = await import("../commands/memory.js");
      commandExitCode = await executeMemoryDoctor(options, runtime, io);
    });

  const internal = program.command("internal", { hidden: true });
  internal
    .command("hook-command-supervisor", { hidden: true })
    .requiredOption("--session <uuid>")
    .requiredOption("--run <uuid>")
    .requiredOption("--invocation <uuid>")
    .action(async (options: { invocation: string; run: string; session: string }) => {
      commandExitCode = await executeInternalHookCommandSupervisor({
        invocationId: options.invocation,
        runId: options.run,
        sessionId: options.session,
      }, runtime, io);
    });

  const delegations = program
    .command("delegations")
    .description("Review and run approved, authority-attenuated child-agent delegations.");

  delegations
    .command("list")
    .requiredOption("--session <uuid>", "parent session ID")
    .option("--status <status>", "filter by exact projected status")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean; session: string; status?: string }) => {
      commandExitCode = await executeDelegationsList({
        json: options.json,
        sessionId: options.session,
        ...(options.status === undefined ? {} : { status: options.status }),
      }, runtime, io);
    });

  delegations
    .command("show")
    .requiredOption("--session <uuid>", "parent session ID")
    .requiredOption("--delegation <uuid>", "delegation ID")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { delegation: string; json: boolean; session: string }) => {
      commandExitCode = await executeDelegationsShow({ delegationId: options.delegation, json: options.json, sessionId: options.session }, runtime, io);
    });

  delegations
    .command("propose")
    .requiredOption("--session <uuid>", "parent session ID")
    .requiredOption("--file <path>", "workspace-local delegation JSON document")
    .option("--base-revision <revision>", "exact revision being replaced")
    .option("--base-sha256 <digest>", "exact SHA-256 being replaced")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { baseRevision?: string; baseSha256?: string; file: string; json: boolean; session: string }) => {
      commandExitCode = await executeDelegationsPropose({
        ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
        ...(options.baseSha256 === undefined ? {} : { baseSha256: options.baseSha256 }),
        file: options.file,
        json: options.json,
        sessionId: options.session,
      }, runtime, io);
    });

  delegations
    .command("approve")
    .requiredOption("--session <uuid>", "parent session ID")
    .requiredOption("--delegation <uuid>", "delegation ID")
    .requiredOption("--revision <revision>", "exact revision")
    .requiredOption("--sha256 <digest>", "exact delegation SHA-256")
    .option("--queue", "also make the approved revision runnable", false)
    .option("--json", "write versioned JSON", false)
    .action(async (options: { delegation: string; json: boolean; queue: boolean; revision: string; session: string; sha256: string }) => {
      commandExitCode = await executeDelegationsApprove({
        delegationId: options.delegation,
        json: options.json,
        queue: options.queue,
        revision: options.revision,
        sessionId: options.session,
        sha256: options.sha256,
      }, runtime, io);
    });

  delegations
    .command("reject")
    .requiredOption("--session <uuid>", "parent session ID")
    .requiredOption("--delegation <uuid>", "delegation ID")
    .requiredOption("--revision <revision>", "exact revision")
    .requiredOption("--sha256 <digest>", "exact delegation SHA-256")
    .option("--reason <text>", "bounded rejection reason")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { delegation: string; json: boolean; reason?: string; revision: string; session: string; sha256: string }) => {
      commandExitCode = await executeDelegationsReject({
        delegationId: options.delegation,
        json: options.json,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        revision: options.revision,
        sessionId: options.session,
        sha256: options.sha256,
      }, runtime, io);
    });

  for (const [name, description, execute] of [
    ["prepare", "Freeze a minimal context capsule and child envelope without launching.", executeDelegationsPrepare],
    ["resume", "Queue an approved delegation for execution.", executeDelegationsResume],
    ["start", "Launch one prepared queued child with a sealed runtime.", executeDelegationsStart],
    ["receipt", "Read and verify the immutable structured child receipt.", executeDelegationsReceipt],
  ] as const) {
    delegations
      .command(name)
      .description(description)
      .requiredOption("--session <uuid>", "parent session ID")
      .requiredOption("--delegation <uuid>", "delegation ID")
      .option("--json", "write versioned JSON", false)
      .action(async (options: { delegation: string; json: boolean; session: string }) => {
        commandExitCode = await execute({ delegationId: options.delegation, json: options.json, sessionId: options.session }, runtime, io);
      });
  }

  delegations
    .command("cancel")
    .requiredOption("--session <uuid>", "parent session ID")
    .requiredOption("--delegation <uuid>", "delegation ID")
    .requiredOption("--reason <text>", "bounded cancellation reason")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { delegation: string; json: boolean; reason: string; session: string }) => {
      commandExitCode = await executeDelegationsCancel({ delegationId: options.delegation, json: options.json, reason: options.reason, sessionId: options.session }, runtime, io);
    });

  delegations
    .command("doctor")
    .requiredOption("--session <uuid>", "parent session ID")
    .option("--delegation <uuid>", "restrict operation inspection to one delegation")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { delegation?: string; json: boolean; session: string }) => {
      commandExitCode = await executeDelegationsDoctor({
        json: options.json,
        sessionId: options.session,
        ...(options.delegation === undefined ? {} : { delegationId: options.delegation }),
      }, runtime, io);
    });
  internal
    .command("delegation-child", { hidden: true })
    .requiredOption("--operation <uuid>")
    .requiredOption("--envelope <path>")
    .requiredOption("--nonce <value>")
    .action(async (options: { operation: string; envelope: string; nonce: string }) => {
      commandExitCode = await executeInternalDelegationChild({
        envelopePath: options.envelope,
        nonce: options.nonce,
        operationId: options.operation,
      }, runtime, io);
    });
  internal
    .command("graph-worker", { hidden: true })
    .requiredOption("--operation <uuid>")
    .requiredOption("--repository <sha256>")
    .action(async (options: { operation: string; repository: string }) => {
      commandExitCode = await executeInternalGraphWorker({
        operationId: options.operation,
        repositoryId: options.repository,
      }, runtime, io);
    });

  const plugins = program
    .command("plugins")
    .description("Inspect and manage immutable local Plugin packages without executing them.");

  plugins
    .command("inspect")
    .argument("<local-directory>", "local Plugin directory; URLs, archives, and UNC paths are unsupported")
    .option("--json", "write versioned JSON", false)
    .action(async (source: string, options: { json: boolean }) => {
      commandExitCode = await executePluginsInspect(source, options, runtime, io);
    });

  plugins
    .command("install")
    .argument("<local-directory>", "local Plugin directory")
    .option("--expect-sha256 <digest>", "require one exact package digest")
    .option("--json", "write versioned JSON", false)
    .action(async (source: string, options: { expectSha256?: string; json: boolean }) => {
      commandExitCode = await executePluginsInstall(source, options, runtime, io);
    });

  plugins
    .command("list")
    .option("--installed", "show installed packages", false)
    .option("--enabled", "show only packages enabled for a new run", false)
    .option("--json", "write versioned JSON", false)
    .action(async (options: { enabled: boolean; installed: boolean; json: boolean }) => {
      commandExitCode = await executePluginsList(options, runtime, io);
    });

  plugins
    .command("show")
    .argument("<exact-selector>", "user_install:<id>@<version>#sha256:<full-digest>")
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean }) => {
      commandExitCode = await executePluginsShow(selector, options, runtime, io);
    });

  plugins
    .command("enable")
    .argument("<exact-selector>", "exact installed Plugin selector")
    .requiredOption("--yes", "confirm enablement for future runs")
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean; yes: boolean }) => {
      commandExitCode = await executePluginsEnable(selector, options, runtime, io);
    });

  plugins
    .command("disable")
    .argument("<exact-selector>", "exact enabled Plugin selector")
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean }) => {
      commandExitCode = await executePluginsDisable(selector, options, runtime, io);
    });

  plugins
    .command("remove")
    .argument("<exact-selector>", "exact disabled Plugin selector")
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean }) => {
      commandExitCode = await executePluginsRemove(selector, options, runtime, io);
    });

  const capabilities = program
    .command("capabilities")
    .description("Inspect the exact local capability catalog without executing components.");

  const hooks = program
    .command("hooks")
    .description("Inspect enabled lifecycle Hooks without executing them.");

  hooks
    .command("list")
    .option("--event <event>", "filter one exact lifecycle event")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { event?: string; json: boolean }) => {
      commandExitCode = await executeHooksList(options, runtime, io);
    });

  hooks
    .command("explain")
    .argument("<action-kind>", "exact action kind")
    .option("--path <relative-path>", "optional normalized path for matcher simulation")
    .option("--json", "write versioned JSON", false)
    .action(async (actionKind: string, options: { json: boolean; path?: string }) => {
      commandExitCode = await executeHooksExplain(actionKind, options, runtime, io);
    });

  capabilities
    .command("list")
    .description("List bounded capability metadata from explicit sources.")
    .option("--source <source>", "builtin, user_install, or workspace")
    .option("--kind <kind>", "skill, hook, or mcp_server")
    .option("--enabled-only", "show only capabilities eligible for a new run", false)
    .option("--workspace <absolute-path>", "inspect one explicit workspace")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { enabledOnly: boolean; json: boolean; kind?: string; source?: string; workspace?: string }) => {
      commandExitCode = await executeCapabilitiesList(options, runtime, io);
    });

  capabilities
    .command("show")
    .description("Show one exact or uniquely resolved capability.")
    .argument("<selector>", "qualified ID or unique read-only selector")
    .option("--workspace <absolute-path>", "inspect one explicit workspace")
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean; workspace?: string }) => {
      commandExitCode = await executeCapabilitiesShow(selector, options, runtime, io);
    });

  capabilities
    .command("doctor")
    .description("Validate capability sources, manifests, paths, digests, and conflicts without repair.")
    .option("--workspace <absolute-path>", "inspect one explicit workspace")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean; workspace?: string }) => {
      commandExitCode = await executeCapabilitiesDoctor(options, runtime, io);
    });

  const skills = program
    .command("skills")
    .description("Inspect enabled inert Skills without loading their content.");

  skills
    .command("list")
    .option("--model-allowed", "show only Skills visible to the model", false)
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean; modelAllowed: boolean }) => {
      commandExitCode = await executeSkillsList(options, runtime, io);
    });

  skills
    .command("show")
    .argument("<selector>", "exact or unique Skill selector")
    .option("--resources", "include the declared resource catalog", false)
    .option("--json", "write versioned JSON", false)
    .action(async (selector: string, options: { json: boolean; resources: boolean }) => {
      commandExitCode = await executeSkillsShow(selector, options, runtime, io);
    });

  const repo = program
    .command("repo")
    .description("Inspect, build, and query the local derived repository index.");

  repo
    .command("status")
    .description("Inspect source, rules, engine, and existing cache without building.")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean }) => {
      commandExitCode = await executeRepoStatus(options, runtime, io);
    });

  repo
    .command("index")
    .description("Build or update the local derived repository index in the foreground.")
    .option("--rebuild", "ignore the current pointer and verify a clean rebuild", false)
    .option("--json", "write versioned JSON", false)
    .action(async (options: { json: boolean; rebuild: boolean }) => {
      commandExitCode = await executeRepoIndex(options, runtime, io);
    });

  const repoQuery = repo.command("query").description("Run one bounded structured repository query.");

  repoQuery
    .command("outline")
    .argument("[path]", "canonical workspace-relative subtree")
    .option("--max-depth <depth>", "relative depth 0..4")
    .option("--limit <count>", "result limit 1..500")
    .option("--cursor <cursor>", "opaque generation-bound cursor")
    .option("--json", "write versioned JSON", true)
    .action(async (path: string | undefined, options: { cursor?: string; json: boolean; limit?: string; maxDepth?: string }) => {
      commandExitCode = await executeRepoQueryOutline(path, options, runtime, io);
    });

  repoQuery
    .command("symbol")
    .argument("<query>", "bounded symbol name query")
    .option("--path <prefix>", "canonical workspace-relative path prefix")
    .option("--limit <count>", "result limit 1..50")
    .option("--cursor <cursor>", "opaque generation-bound cursor")
    .option("--json", "write versioned JSON", true)
    .action(async (query: string, options: { cursor?: string; json: boolean; limit?: string; path?: string }) => {
      commandExitCode = await executeRepoQuerySymbol(query, options, runtime, io);
    });

  repoQuery
    .command("references")
    .argument("<symbol-id>", "generation-bound symbol ID from find_symbol")
    .option("--relation <relation>", "reference relation filter", collectOption, [])
    .option("--limit <count>", "result limit 1..100")
    .option("--cursor <cursor>", "opaque generation-bound cursor")
    .option("--json", "write versioned JSON", true)
    .action(async (symbolId: string, options: { cursor?: string; json: boolean; limit?: string; relation: string[] }) => {
      commandExitCode = await executeRepoQueryReferences(symbolId, { ...options, relations: options.relation }, runtime, io);
    });

  const policy = program
    .command("policy")
    .description("Inspect and validate the effective versioned runtime policy.");

  policy
    .command("show")
    .description("Show one effective profile without constructing a backend.")
    .option("--profile <id>", "exact profile id; defaults to built-in local-free-v1")
    .option("--config <absolute-path>", "explicit trusted user policy config")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { config?: string; json: boolean; profile?: string }) => {
      commandExitCode = await executePolicyShow(options, runtime, io);
    });

  policy
    .command("validate")
    .description("Validate built-in and optional user policy assets without network access.")
    .option("--config <absolute-path>", "explicit trusted user policy config")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { config?: string; json: boolean }) => {
      commandExitCode = await executePolicyValidate(options, runtime, io);
    });

  policy
    .command("explain")
    .description("Explain a hypothetical provider/eval decision with zero side effects.")
    .requiredOption("--profile <id>", "exact selected profile id")
    .option("--config <absolute-path>", "explicit trusted user policy config")
    .option("--provider <id>", "exact provider request")
    .option("--model <id>", "exact model request")
    .option("--endpoint <url>", "exact endpoint request")
    .option("--suite <targeted|smoke|full>", "hypothetical eval suite")
    .option("--json", "write versioned JSON", false)
    .action(async (options: { config?: string; endpoint?: string; json: boolean; model?: string; profile: string; provider?: string; suite?: string }) => {
      commandExitCode = await executePolicyExplain(options, runtime, io);
    });

  program
    .command("agent")
    // PHASE4: agent 是独立命令；chat 继续保留 Phase 3 的最多一次工具往返，避免语义偷换。
    .description("Run a budgeted coding AgentLoop over the workspace.")
    .argument("<task>", "repository task to answer; do not paste API keys")
    .option("--provider <provider>", "model provider: openai, anthropic, or ollama")
    .option("--model <model>", "override the provider model")
    .option("--mode <mode>", "agent mode: plan or build")
    .option("--policy-profile <id>", "exact runtime policy profile; default local-free-v1")
    .option("--policy-config <absolute-path>", "trusted user runtime policy config")
    .option("--mcp <server-id>", "enable one local stdio MCP server", collectOption, [])
    .option("--skill <selector>", "activate one exact or unique Skill", collectOption, [])
    .option("--skill-args <text>", "opaque arguments for one explicitly selected Skill")
    .option("--mcp-prompt <server-id:prompt-name>", "inject one explicit frozen MCP prompt")
    .option("--mcp-prompt-args <json>", "JSON object with string values for --mcp-prompt")
    .option("--executor <executor>", "command executor: local or docker")
    .option("--docker-image <name@sha256:digest>", "trusted local digest-pinned Docker image")
    .option("--sandbox-memory-mib <mib>", "Docker memory limit (256..8192 MiB)")
    .option("--sandbox-cpus <cpus>", "Docker CPU limit (0.25..8)")
    .option("--sandbox-pids <count>", "Docker PID limit (32..1024)")
    .option("--sandbox-tmp-mib <mib>", "Docker tmpfs limit (16..1024 MiB)")
    .option("--max-steps <steps>", "maximum model responses")
    // PHASE4: max-duration 覆盖整次 run，request-timeout 只覆盖一轮 provider response。
    .option("--max-duration-ms <milliseconds>", "whole-run wall clock budget")
    .option(
      "--request-timeout-ms <milliseconds>",
      "timeout for each provider request",
    )
    .option("--max-tokens <tokens>", "maximum reported total tokens")
    .addOption(
      new Option("--memory <mode>", "episodic memory and safe recall: off or local")
        .choices(["off", "local"])
        .default("off"),
    )
    .option(
      "--edit-approval <mode>",
      "file edit approval: ask or deny",
    )
    .option(
      "--command-approval <mode>",
      "command approval: ask or deny",
    )
    .option(
      "--command-timeout-ms <milliseconds>",
      "default timeout for an approved command",
    )
    .option(
      "--task-profile <profile>",
      "task profile: read-only or coding",
    )
    .option(
      "--completion-policy <policy>",
      "completion policy: verified",
    )
    .option(
      "--require-verification <mode>",
      "verification requirement: auto",
    )
    .option(
      "--report-format <format>",
      "deterministic report format: text or json",
    )
    .option(
      "--max-tool-output-bytes <bytes>",
      "cumulative UTF-8 tool observation budget",
    )
    .option(
      "--max-command-output-bytes <bytes>",
      "combined stdout/stderr capture budget",
    )
    .option(
      "--context-reserve-output-tokens <tokens>",
      "reserved output capacity for each context plan",
    )
    .option(
      "--context-compaction-threshold <ratio>",
      "context compaction threshold from 0.50 to 0.95",
    )
    .option(
      "--context-window-tokens <tokens>",
      "conservative context window override (may only lower a pinned limit)",
    )
    .option(
      "--artifact-capture-bytes <bytes>",
      "maximum sanitized capture bytes per artifact",
    )
    .option("--verbose", "write step and budget metadata to stderr", false)
    .addHelpText(
      "after",
      "\nSecurity: tasks and allowed tool observations are saved locally in .bornagent/sessions; do not paste secrets.\n",
    )
    .action(
      async (
        task: string,
        options: {
          artifactCaptureBytes?: string;
          commandApproval?: string;
          commandTimeoutMs?: string;
          completionPolicy?: string;
          contextCompactionThreshold?: string;
          contextReserveOutputTokens?: string;
          contextWindowTokens?: string;
          editApproval?: string;
          executor?: string;
          dockerImage?: string;
          maxDurationMs?: string;
          maxCommandOutputBytes?: string;
          maxSteps?: string;
          maxTokens?: string;
          maxToolOutputBytes?: string;
          memory: "local" | "off";
          mcp: string[];
          mcpPrompt?: string;
          mcpPromptArgs?: string;
          mode?: string;
          model?: string;
          policyConfig?: string;
          policyProfile?: string;
          provider?: string;
          reportFormat?: string;
          requireVerification?: string;
          requestTimeoutMs?: string;
          sandboxCpus?: string;
          sandboxMemoryMib?: string;
          sandboxPids?: string;
          sandboxTmpMib?: string;
          skill: string[];
          skillArgs?: string;
          taskProfile?: string;
          verbose: boolean;
        },
      ) => {
        commandExitCode = await executeAgentThroughApplicationService(
          {
            artifactCaptureBytes: options.artifactCaptureBytes,
            commandApproval: options.commandApproval,
            commandTimeoutMs: options.commandTimeoutMs,
            completionPolicy: options.completionPolicy,
            contextCompactionThreshold: options.contextCompactionThreshold,
            contextReserveOutputTokens: options.contextReserveOutputTokens,
            contextWindowTokens: options.contextWindowTokens,
            editApproval: options.editApproval,
            executor: options.executor,
            dockerImage: options.dockerImage,
            maxDurationMs: options.maxDurationMs,
            maxCommandOutputBytes: options.maxCommandOutputBytes,
            maxSteps: options.maxSteps,
            maxTokens: options.maxTokens,
            maxToolOutputBytes: options.maxToolOutputBytes,
            memoryMode: options.memory,
            mcpServerIds: options.mcp,
            mcpPromptArgumentsJson: options.mcpPromptArgs,
            mcpPromptSelection: options.mcpPrompt,
            mode: options.mode,
            model: options.model,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            provider: options.provider,
            reportFormat: options.reportFormat,
            requireVerification: options.requireVerification,
            requestTimeoutMs: options.requestTimeoutMs,
            sandboxCpus: options.sandboxCpus,
            sandboxMemoryMiB: options.sandboxMemoryMib,
            sandboxPids: options.sandboxPids,
            sandboxTmpMiB: options.sandboxTmpMib,
            skillArguments: options.skillArgs,
            skillSelections: options.skill,
            task,
            taskProfile: options.taskProfile,
            verbose: options.verbose,
          },
          runtime,
          io,
        );
      },
    );

  program
    .command("chat")
    .description("Stream a response with at most one read-only tool call.")
    .argument("<prompt>", "text prompt to send; do not paste API keys")
    .option("--provider <provider>", "model provider: openai, anthropic, or ollama")
    .option("--model <model>", "override the provider model")
    .option("--policy-profile <id>", "exact runtime policy profile; default local-free-v1")
    .option("--policy-config <absolute-path>", "trusted user runtime policy config")
    .option("--timeout-ms <milliseconds>", "request timeout in milliseconds")
    .option("--no-tools", "disable read-only workspace tools")
    // PHASE3: Commander 对 --no-tools 生成 options.tools=false；默认则为 true。
    .option("--verbose", "write response metadata to stderr", false)
    .addHelpText(
      "after",
      "\nSecurity: prompts and allowed tool observations are saved locally in .bornagent/sessions; do not paste secrets.\n",
    )
    .action(
      async (
        prompt: string,
        options: {
          model?: string;
          policyConfig?: string;
          policyProfile?: string;
          provider?: string;
          timeoutMs?: string;
          tools: boolean;
          verbose: boolean;
        },
      ) => {
        commandExitCode = await executeChatThroughApplicationService(
          {
            model: options.model,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            prompt,
            provider: options.provider,
            timeoutMs: options.timeoutMs,
            toolsEnabled: options.tools,
            verbose: options.verbose,
          },
          runtime,
          io,
        );
      },
    );

  program
    .command("tui")
    .description("Run the event-driven interactive terminal UI.")
    .argument("[task]", "optional repository task; omit to open the idle screen")
    .option("--resume <session-id>", "resume one saved session")
    .option("--inspect-session <session-id>", "open one saved session without starting a model run")
    .option(
      "--allow-degraded-resume",
      "explicitly accept canonical-only resume",
      false,
    )
    .option("--provider <provider>", "model provider: openai, anthropic, or ollama")
    .option("--model <model>", "override the provider model")
    .option("--mode <mode>", "initial agent mode: plan or build")
    .option("--policy-profile <id>", "exact runtime policy profile; default local-free-v1")
    .option("--policy-config <absolute-path>", "trusted user runtime policy config")
    .option("--mcp <server-id>", "enable one local stdio MCP server", collectOption, [])
    .option("--executor <executor>", "command executor: local or docker")
    .option("--docker-image <name@sha256:digest>", "trusted local digest-pinned Docker image")
    .option("--sandbox-memory-mib <mib>", "Docker memory limit")
    .option("--sandbox-cpus <cpus>", "Docker CPU limit")
    .option("--sandbox-pids <count>", "Docker PID limit")
    .option("--sandbox-tmp-mib <mib>", "Docker tmpfs limit")
    .option("--max-steps <steps>", "maximum model responses")
    .option("--max-duration-ms <milliseconds>", "whole-run wall clock budget")
    .option("--request-timeout-ms <milliseconds>", "timeout for each provider request")
    .option("--max-tokens <tokens>", "maximum reported total tokens")
    .option("--edit-approval <mode>", "file edit approval: ask or deny")
    .option("--command-approval <mode>", "command approval: ask or deny")
    .option("--command-timeout-ms <milliseconds>", "approved command timeout")
    .option("--task-profile <profile>", "task profile: read-only or coding")
    .option("--completion-policy <policy>", "completion policy: verified")
    .option("--require-verification <mode>", "verification requirement: auto")
    .option("--report-format <format>", "report format: text or json")
    .option("--max-tool-output-bytes <bytes>", "tool observation budget")
    .option("--max-command-output-bytes <bytes>", "command capture budget")
    .option("--context-reserve-output-tokens <tokens>", "reserved output capacity")
    .option("--context-compaction-threshold <ratio>", "context compaction threshold")
    .option("--context-window-tokens <tokens>", "conservative context override")
    .option("--artifact-capture-bytes <bytes>", "artifact capture limit")
    .action(
      async (
        task: string | undefined,
        options: {
          allowDegradedResume: boolean;
          artifactCaptureBytes?: string;
          commandApproval?: string;
          commandTimeoutMs?: string;
          completionPolicy?: string;
          contextCompactionThreshold?: string;
          contextReserveOutputTokens?: string;
          contextWindowTokens?: string;
          editApproval?: string;
          executor?: string;
          dockerImage?: string;
          maxCommandOutputBytes?: string;
          maxDurationMs?: string;
          maxSteps?: string;
          maxTokens?: string;
          maxToolOutputBytes?: string;
          mcp: string[];
          mode?: string;
          model?: string;
          policyConfig?: string;
          policyProfile?: string;
          provider?: string;
          reportFormat?: string;
          requireVerification?: string;
          requestTimeoutMs?: string;
          sandboxCpus?: string;
          sandboxMemoryMib?: string;
          sandboxPids?: string;
          sandboxTmpMib?: string;
          resume?: string;
          inspectSession?: string;
          taskProfile?: string;
        },
      ) => {
        commandExitCode = await executeTui(
          {
            allowDegradedResume: options.allowDegradedResume,
            artifactCaptureBytes: options.artifactCaptureBytes,
            commandApproval: options.commandApproval,
            commandTimeoutMs: options.commandTimeoutMs,
            completionPolicy: options.completionPolicy,
            contextCompactionThreshold: options.contextCompactionThreshold,
            contextReserveOutputTokens: options.contextReserveOutputTokens,
            contextWindowTokens: options.contextWindowTokens,
            editApproval: options.editApproval,
            executor: options.executor,
            dockerImage: options.dockerImage,
            maxCommandOutputBytes: options.maxCommandOutputBytes,
            maxDurationMs: options.maxDurationMs,
            maxSteps: options.maxSteps,
            maxTokens: options.maxTokens,
            maxToolOutputBytes: options.maxToolOutputBytes,
            mcpServerIds: options.mcp,
            mode: options.mode,
            model: options.model,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            provider: options.provider,
            reportFormat: options.reportFormat,
            requireVerification: options.requireVerification,
            requestTimeoutMs: options.requestTimeoutMs,
            sandboxCpus: options.sandboxCpus,
            sandboxMemoryMiB: options.sandboxMemoryMib,
            sandboxPids: options.sandboxPids,
            sandboxTmpMiB: options.sandboxTmpMib,
            resumeSessionId: options.resume,
            ...(options.inspectSession === undefined ? {} : { inspectSessionId: options.inspectSession }),
            task,
            taskProfile: options.taskProfile,
          },
          runtime,
          io,
        );
      },
    );

  const models = program
    .command("models")
    .description("List the versioned local model capability catalog.")
    .option("--provider <provider>", "filter by provider")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--json", "write the versioned JSON document", false)
    .option(
      "--refresh-local",
      "query literal-loopback Ollama /api/tags with a short timeout",
      false,
    )
    .action(
      async (options: {
        json: boolean;
        policyConfig?: string;
        policyProfile?: string;
        provider?: string;
        refreshLocal: boolean;
      }) => {
        commandExitCode = await executeModels(
          {
            json: options.json,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            provider: options.provider,
            refreshLocal: options.refreshLocal,
          },
          runtime,
          io,
        );
      },
    );

  models.enablePositionalOptions();

  models
    .command("qualify")
    .description("Run the bounded explicit protocol qualification suite.")
    .requiredOption("--model <model>", "exact model id")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option(
      "--confirm-remote-requests <count>",
      "confirm the exact remote request ceiling",
    )
    .option("--json", "write strict qualification JSON", false)
    .action(
      async (options: {
        confirmRemoteRequests?: string;
        json: boolean;
        model: string;
        policyConfig?: string;
        policyProfile?: string;
      }, command: Command) => {
        const resolved = command.optsWithGlobals() as typeof options & {
          provider?: string;
        };
        if (resolved.provider === undefined) {
          io.stderr.write("usage/config error: --provider is required\n");
          commandExitCode = 2;
          return;
        }
        commandExitCode = await executeModelsQualify(
          { ...resolved, provider: resolved.provider },
          runtime,
          io,
        );
      },
    );

  const qualification = models
    .command("qualification")
    .description("Inspect or remove exact local qualification evidence.");

  qualification
    .command("show")
    .description("Show evidence for one exact current provider/model identity.")
    .requiredOption("--model <model>", "exact model id")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--json", "write strict qualification JSON", false)
    .action(
      async (options: {
        json: boolean;
        model: string;
        policyConfig?: string;
        policyProfile?: string;
      }, command: Command) => {
        const resolved = command.optsWithGlobals() as typeof options & {
          provider?: string;
        };
        if (resolved.provider === undefined) {
          io.stderr.write("usage/config error: --provider is required\n");
          commandExitCode = 2;
          return;
        }
        commandExitCode = await executeModelsQualificationShow(
          { ...resolved, provider: resolved.provider },
          runtime,
          io,
        );
      },
    );

  qualification
    .command("remove")
    .description("Remove one exact qualification record under an exclusive lock.")
    .requiredOption("--identity-sha256 <hash>", "exact qualification identity hash")
    .option("--yes", "confirm exact record removal", false)
    .option("--json", "write strict removal JSON", false)
    .action(
      async (options: {
        identitySha256: string;
        json: boolean;
        yes: boolean;
      }, command: Command) => {
        const resolved = command.optsWithGlobals() as typeof options;
        commandExitCode = await executeModelsQualificationRemove(
          resolved,
          runtime,
          io,
        );
      },
    );

  const goal = program
    .command("goal")
    .description("Inspect and mutate durable user-owned Goals without calling a model.");

  goal
    .command("show")
    .description("Show the durable Goal projection for one session.")
    .argument("<session-id>", "canonical session UUID")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean }) => {
      commandExitCode = await executeGoalShow(
        { json: options.json, sessionId },
        runtime,
        io,
      );
    });

  goal
    .command("set")
    .description("Create the initial Goal or revise the exact active Goal.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--text <objective>", "bounded Goal objective")
    .option("--goal-id <id>", "exact active Goal id")
    .option("--base-revision <n>", "exact active Goal revision")
    .action(
      async (
        sessionId: string,
        options: { baseRevision?: string; goalId?: string; text: string },
      ) => {
        commandExitCode = await executeGoalSet(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  goal
    .command("new")
    .description("Start a new Goal, optionally replacing the exact active Goal.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--text <objective>", "bounded Goal objective")
    .option("--parent-goal <id>", "explicit earlier parent Goal id")
    .option("--abandon-current", "confirm exact active Goal replacement", false)
    .option("--current-goal-id <id>", "exact active Goal id")
    .option("--current-revision <n>", "exact active Goal revision")
    .action(
      async (
        sessionId: string,
        options: {
          abandonCurrent: boolean;
          currentGoalId?: string;
          currentRevision?: string;
          parentGoal?: string;
          text: string;
        },
      ) => {
        commandExitCode = await executeGoalNew(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  goal
    .command("abandon")
    .description("Abandon the exact active Goal.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--goal-id <id>", "exact active Goal id")
    .requiredOption("--revision <n>", "exact active Goal revision")
    .requiredOption("--reason <text>", "bounded non-empty reason")
    .action(
      async (
        sessionId: string,
        options: { goalId: string; reason: string; revision: string },
      ) => {
        commandExitCode = await executeGoalAbandon(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  const plan = program
    .command("plan")
    .description("Inspect, replace, approve, or reject durable Plans without calling a model.");

  plan
    .command("show")
    .description("Show pending, approved, and projected Todo state.")
    .argument("<session-id>", "canonical session UUID")
    .option("--history", "include superseded and rejected revisions", false)
    .option("--json", "write canonical JSON", false)
    .action(
      async (
        sessionId: string,
        options: { history: boolean; json: boolean },
      ) => {
        commandExitCode = await executePlanShow(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  plan
    .command("replace")
    .description("Propose a user-authored Plan revision from a strict workspace JSON file.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--goal-id <id>", "exact active Goal id")
    .requiredOption("--goal-revision <n>", "exact active Goal revision")
    .requiredOption("--file <workspace-relative-json>", "strict workspace-relative Plan JSON")
    .option("--base-plan-id <id>", "exact current Plan id")
    .option("--base-revision <n>", "exact current Plan revision")
    .option("--base-sha256 <hash>", "exact full current Plan SHA-256")
    .action(
      async (
        sessionId: string,
        options: {
          basePlanId?: string;
          baseRevision?: string;
          baseSha256?: string;
          file: string;
          goalId: string;
          goalRevision: string;
        },
      ) => {
        commandExitCode = await executePlanReplace(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  plan
    .command("approve")
    .description("Approve one exact pending Plan revision and full hash.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--goal-id <id>", "exact active Goal id")
    .requiredOption("--goal-revision <n>", "exact active Goal revision")
    .requiredOption("--plan-id <id>", "exact pending Plan id")
    .requiredOption("--revision <n>", "exact pending Plan revision")
    .requiredOption("--sha256 <hash>", "full pending Plan SHA-256")
    .action(
      async (
        sessionId: string,
        options: {
          goalId: string;
          goalRevision: string;
          planId: string;
          revision: string;
          sha256: string;
        },
      ) => {
        commandExitCode = await executePlanApprove(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  plan
    .command("reject")
    .description("Reject one exact pending Plan revision and full hash.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--goal-id <id>", "exact active Goal id")
    .requiredOption("--goal-revision <n>", "exact active Goal revision")
    .requiredOption("--plan-id <id>", "exact pending Plan id")
    .requiredOption("--revision <n>", "exact pending Plan revision")
    .requiredOption("--sha256 <hash>", "full pending Plan SHA-256")
    .requiredOption("--reason <text>", "bounded non-empty rejection reason")
    .action(
      async (
        sessionId: string,
        options: {
          goalId: string;
          goalRevision: string;
          planId: string;
          reason: string;
          revision: string;
          sha256: string;
        },
      ) => {
        commandExitCode = await executePlanReject(
          { ...options, sessionId },
          runtime,
          io,
        );
      },
    );

  const graph = program
    .command("graph")
    .description("Validate and control exact durable Task Graph revisions.");

  graph
    .command("validate")
    .description("Validate and hash one strict workspace Graph JSON file without mutation.")
    .requiredOption("--file <workspace-relative-json>", "strict workspace-relative Graph JSON")
    .option("--json", "write canonical JSON", false)
    .action(async (options: { file: string; json: boolean }) => {
      commandExitCode = await executeGraphValidate(options, runtime, io);
    });

  graph
    .command("doctor")
    .description("Validate local Git, deterministic scheduler, managed worktree, promotion, and sealed worker capabilities.")
    .option("--json", "write canonical JSON", false)
    .action(async (options: { json: boolean }) => {
      commandExitCode = await executeGraphDoctor(options, runtime, io);
    });

  graph
    .command("show")
    .description("Replay and verify durable Graph revisions for one session.")
    .argument("<session-id>", "canonical session UUID")
    .option("--revision <n>", "show one exact Graph revision")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; revision?: string }) => {
      commandExitCode = await executeGraphShow({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("replace")
    .description("Propose an initial or replacement Graph from a strict workspace JSON file.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--file <workspace-relative-json>", "strict workspace-relative Graph JSON")
    .option("--base-revision <n>", "exact current Graph revision")
    .option("--base-sha256 <hash>", "exact full current Graph SHA-256")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { baseRevision?: string; baseSha256?: string; file: string; json: boolean }) => {
      commandExitCode = await executeGraphReplace({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("approve")
    .description("Approve one exact draft Graph revision; effects remain independently gated.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact draft Graph revision")
    .requiredOption("--sha256 <hash>", "exact full draft Graph SHA-256")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphApprove({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("reject")
    .description("Reject one exact draft Graph revision.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact draft Graph revision")
    .requiredOption("--sha256 <hash>", "exact full draft Graph SHA-256")
    .option("--reason <text>", "bounded optional rejection reason")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; reason?: string; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphReject({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("enqueue")
    .description("Enqueue one exact approved Graph revision without granting node effects.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact approved Graph revision")
    .requiredOption("--sha256 <hash>", "exact full approved Graph SHA-256")
    .option("--runtime-profile <id>", "trusted runtime policy profile", "local-free-v1")
    .option("--background", "reserve background execution intent", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { background: boolean; json: boolean; revision: string; runtimeProfile: string; sha256: string }) => {
      commandExitCode = await executeGraphEnqueue({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("status")
    .description("Replay the durable Graph execution projection.")
    .argument("<session-id>", "canonical session UUID")
    .option("--live", "add one bounded current worker observation", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; live: boolean }) => {
      commandExitCode = await executeGraphStatus({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("run")
    .description("Run the deterministic single-active Graph scheduler.")
    .argument("<session-id>", "canonical session UUID")
    .option("--foreground", "run under the current terminal", false)
    .option("--background", "hando off to a bounded background worker", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { background: boolean; foreground: boolean; json: boolean }) => {
      if (options.background && options.foreground) {
        io.stderr.write("task_graph_schema_invalid: choose one execution mode\n");
        commandExitCode = 2;
        return;
      }
      commandExitCode = await executeGraphRun({ background: options.background, json: options.json, sessionId }, runtime, io);
    });

  graph
    .command("resume")
    .description("Resume one exact waiting Graph with fresh foreground or background authority.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact waiting Graph revision")
    .requiredOption("--sha256 <hash>", "exact full waiting Graph SHA-256")
    .option("--foreground", "resume under the current terminal", false)
    .option("--background", "resume through a new sealed worker handoff", false)
    .option("--takeover", "request owner-death reconciliation before resume", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { background: boolean; foreground: boolean; json: boolean; revision: string; sha256: string; takeover: boolean }) => {
      commandExitCode = await executeGraphResume({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("retry")
    .description("Authorize a fresh user retry for one exact known failed node attempt.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--node <id>", "exact failed node id")
    .requiredOption("--attempt <n>", "exact failed attempt number")
    .requiredOption("--terminal-event <id>", "exact terminal event UUID")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { attempt: string; json: boolean; node: string; terminalEvent: string }) => {
      commandExitCode = await executeGraphRetry({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("logs")
    .description("Read verified bounded node receipts for one Graph session.")
    .argument("<session-id>", "canonical session UUID")
    .option("--node <id>", "filter by exact node id")
    .option("--cursor <opaque>", "continue after an opaque bounded cursor")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { cursor?: string; json: boolean; node?: string }) => {
      commandExitCode = await executeGraphLogs({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("worktrees")
    .description("Show replayed managed worktree and promotion state without exposing local paths.")
    .argument("<session-id>", "canonical session UUID")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean }) => {
      commandExitCode = await executeGraphWorktrees({ ...options, sessionId }, runtime, io);
    });

  const graphWorker = graph
    .command("worker")
    .description("Inspect bounded background worker eligibility.");

  graphWorker
    .command("doctor")
    .description("Seal and verify the current built CLI worker executable.")
    .option("--json", "write canonical JSON", false)
    .action(async (options: { json: boolean }) => {
      commandExitCode = await executeGraphWorkerDoctor(options, runtime, io);
    });

  graph
    .command("cancel")
    .description("Request cancellation of one exact active Graph revision.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact active Graph revision")
    .requiredOption("--sha256 <hash>", "exact full active Graph SHA-256")
    .requiredOption("--reason <text>", "bounded cancellation reason")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; reason: string; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphCancel({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("worktree-allocate")
    .description("Capture an exact baseline and create one approved managed worktree lineage.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact approved Graph revision")
    .requiredOption("--sha256 <hash>", "exact full approved Graph SHA-256")
    .requiredOption("--source-node <id>", "managed_worktree lineage source node")
    .option("--include-current-changes", "explicitly include tracked/untracked origin changes", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { includeCurrentChanges: boolean; json: boolean; revision: string; sha256: string; sourceNode: string }) => {
      commandExitCode = await executeGraphWorktreeAllocate({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("promote")
    .description("Promote one accepted managed-worktree attempt through exact origin preimages.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact executing Graph revision")
    .requiredOption("--sha256 <hash>", "exact full Graph SHA-256")
    .requiredOption("--node-id <id>", "exact managed node id")
    .requiredOption("--attempt-id <id>", "exact accepted attempt UUID")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { attemptId: string; json: boolean; nodeId: string; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphPromote({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("verify-origin")
    .description("Retry the exact verification action against one applied promotion target.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--revision <n>", "exact executing Graph revision")
    .requiredOption("--sha256 <hash>", "exact full Graph SHA-256")
    .requiredOption("--promotion-operation <id>", "exact applied promotion operation UUID")
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { json: boolean; promotionOperation: string; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphOriginVerify({ ...options, sessionId }, runtime, io);
    });

  graph
    .command("worktree-cleanup")
    .description("Remove an exact clean worktree, or explicitly archive every file before force removal.")
    .argument("<session-id>", "canonical session UUID")
    .requiredOption("--graph-id <id>", "exact Graph UUID")
    .requiredOption("--revision <n>", "exact Graph revision")
    .requiredOption("--sha256 <hash>", "exact full Graph SHA-256")
    .requiredOption("--node-id <id>", "node in the managed lineage")
    .option("--archive-and-remove", "capture a verified local archive before force removal", false)
    .option("--json", "write canonical JSON", false)
    .action(async (sessionId: string, options: { archiveAndRemove: boolean; graphId: string; json: boolean; nodeId: string; revision: string; sha256: string }) => {
      commandExitCode = await executeGraphWorktreeCleanup({ ...options, sessionId }, runtime, io);
    });

  const sessions = program
    .command("sessions")
    .description("List, replay, or safely resume local sessions.");

  sessions
    .command("list")
    .description("List local sessions without calling a model.")
    .option("--limit <count>", "maximum sessions to show (1..200)")
    .option("--json", "write a versioned JSON document", false)
    .action(async (options: { json: boolean; limit?: string }) => {
      commandExitCode = await executeSessionsList(
        { json: options.json, limit: options.limit },
        runtime,
        io,
      );
    });

  sessions
    .command("show")
    .description("Replay one saved session without calling a model or tool.")
    .argument("<session-id>", "canonical session UUID")
    .option("--context", "show bounded context plan metadata", false)
    .option("--events", "show bounded redacted domain events", false)
    .option("--json", "write a versioned JSON document", false)
    .action(
      async (
        sessionId: string,
        options: { context: boolean; events: boolean; json: boolean },
      ) => {
        commandExitCode = await executeSessionsShow(
          {
            context: options.context,
            events: options.events,
            json: options.json,
            sessionId,
          },
          runtime,
          io,
        );
      },
    );

  const mcp = program
    .command("mcp")
    .description("Validate, inspect, and explicitly run local stdio MCP servers.");

  mcp
    .command("list")
    .description("List and validate local MCP config without spawning a process.")
    .action(async () => {
      commandExitCode = await executeMcpList(runtime, io);
    });

  const mcpPrompts = mcp
    .command("prompts")
    .description("List or explicitly get user-controlled MCP prompts.");

  mcpPrompts
    .command("list")
    .option("--server <id>", "start only this configured MCP server")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: { json: boolean; server?: string }) => {
      commandExitCode = await executeMcpPromptsList(
        { json: options.json, ...(options.server === undefined ? {} : { serverId: options.server }) },
        runtime,
        io,
      );
    });

  mcpPrompts
    .command("get")
    .argument("<selector>", "exact <server-id>:<prompt-name>")
    .option("--arg <key=value>", "opaque prompt string argument", collectOption, [])
    .option("--json", "emit machine-readable JSON", false)
    .action(async (
      selector: string,
      options: { arg: string[]; json: boolean },
    ) => {
      commandExitCode = await executeMcpPromptGet(
        selector,
        { arguments: options.arg, json: options.json },
        runtime,
        io,
      );
    });

  mcp
    .command("inspect")
    .description("Start one approved offline MCP server and inspect its catalog.")
    .argument("<server-id>", "configured MCP server id")
    .action(async (serverId: string) => {
      commandExitCode = await executeMcpInspect(serverId, runtime, io);
    });

  sessions
    .command("resume")
    .description("Create a new run from a verified safe resume boundary.")
    .argument("<session-id>", "canonical session UUID")
    .option("--message <text>", "new user turn for a completed session")
    .option("--mode <mode>", "agent mode for the new run: plan or build")
    .option(
      "--continue-approved-plan",
      "continue the exact current approved Plan while a draft is pending",
      false,
    )
    .option("--plan-revision <n>", "exact current approved Plan revision")
    .option("--plan-sha256 <hash>", "exact current approved Plan SHA-256")
    .option("--policy-profile <id>", "select the session's exact runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option(
      "--allow-degraded-resume",
      "explicitly accept loss of provider-private continuation state",
      false,
    )
    .action(
      async (
        sessionId: string,
        options: {
          allowDegradedResume: boolean;
          continueApprovedPlan: boolean;
          message?: string;
          mode?: string;
          planRevision?: string;
          planSha256?: string;
          policyConfig?: string;
          policyProfile?: string;
        },
      ) => {
        commandExitCode = await executeSessionsResume(
          {
            allowDegradedResume: options.allowDegradedResume,
            continueApprovedPlan: options.continueApprovedPlan,
            message: options.message,
            mode: options.mode,
            planRevision: options.planRevision,
            planSha256: options.planSha256,
            policyConfig: options.policyConfig,
            policyProfile: options.policyProfile,
            sessionId,
          },
          runtime,
          io,
        );
      },
    );

  const docker = program
    .command("docker")
    .description("Inspect or prepare one built-in locked Docker artifact locally.");

  docker
    .command("status")
    .description("Inspect policy, package lock, local daemon, and already-present identity only.")
    .option("--artifact <id>", "exact built-in artifact ID")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--json", "write versioned JSON evidence", false)
    .action(async (options: { artifact?: string; policyConfig?: string; policyProfile?: string; json: boolean }) => {
      commandExitCode = await executeDockerStatus(options, runtime, io);
    });

  docker
    .command("prepare")
    .description("Run the locked anonymous base pull or trusted local build path.")
    .option("--artifact <id>", "exact built-in artifact ID")
    .option("--source <pull|build>", "explicit locked acquisition source")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--json", "write versioned JSON evidence", false)
    .action(async (options: { artifact?: string; source?: string; policyConfig?: string; policyProfile?: string; json: boolean }) => {
      commandExitCode = await executeDockerPrepare(options, runtime, io);
    });

  const sandbox = program
    .command("sandbox")
    .description("Inspect the local-only Docker isolation backend.");

  sandbox
    .command("doctor")
    .description("Validate Docker daemon and one already-present digest-pinned image.")
    .option("--docker-image <name@sha256:digest>", "trusted local digest-pinned Docker image")
    .option("--sandbox-memory-mib <mib>", "Docker memory limit (256..8192 MiB)")
    .option("--sandbox-cpus <cpus>", "Docker CPU limit (0.25..8)")
    .option("--sandbox-pids <count>", "Docker PID limit (32..1024)")
    .option("--sandbox-tmp-mib <mib>", "Docker tmpfs limit (16..1024 MiB)")
    .action(
      async (options: {
        dockerImage?: string;
        sandboxCpus?: string;
        sandboxMemoryMib?: string;
        sandboxPids?: string;
        sandboxTmpMib?: string;
      }) => {
        commandExitCode = await executeSandboxDoctor(
          {
            dockerImage: options.dockerImage,
            sandboxCpus: options.sandboxCpus,
            sandboxMemoryMiB: options.sandboxMemoryMib,
            sandboxPids: options.sandboxPids,
            sandboxTmpMiB: options.sandboxTmpMib,
          },
          runtime,
          io,
        );
      },
    );

  const evalCommand = program
    .command("eval")
    .description("Run zero-cost local reliability evaluations.");

  evalCommand
    .command("list")
    .description("Validate and list the checked-in eval suite without calling a model.")
    .option("--json", "write canonical JSON", false)
    .action(async (options: { json: boolean }) => {
      commandExitCode = await executeEvalList(runtime.evalRuntime, io, options.json);
    });

  evalCommand
    .command("run")
    .description("Run smoke/targeted evals with fake/mock or literal-loopback Ollama only.")
    .requiredOption("--suite <smoke|full>", "fixed suite selection")
    .requiredOption("--provider <id>", "fake, mock, or ollama")
    .requiredOption("--model <id>", "fixed local/test model identity")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--repetitions <count>", "attempt repetitions (1..10)")
    .option("--task <id>", "run one checked-in task as a partial suite")
    .option("--ollama-endpoint <url>", "literal-loopback Ollama endpoint")
    .option("--ollama-model-digest <sha256>", "optional exact installed-model digest assertion")
    .option("--json", "write canonical JSON", false)
    .action(async (options: { suite: string; provider: string; model: string; policyConfig?: string; policyProfile?: string; repetitions?: string; task?: string; ollamaEndpoint?: string; ollamaModelDigest?: string; json: boolean }) => {
      commandExitCode = await executeEvalRun(runtime.evalRuntime, io, options);
    });

  evalCommand
    .command("show")
    .description("Show a saved eval summary or one attempt without model/tool execution.")
    .argument("<run-id>", "eval run ID")
    .option("--attempt <task:rN>", "show one attempt")
    .option("--json", "write canonical JSON", false)
    .action(async (runId: string, options: { attempt?: string; json: boolean }) => {
      commandExitCode = await executeEvalShow(runtime.evalRuntime, io, { runId, ...options });
    });

  evalCommand
    .command("compare")
    .description("Compare two compatible saved eval runs descriptively.")
    .argument("<baseline-id>", "baseline eval run ID")
    .argument("<candidate-id>", "candidate eval run ID")
    .option("--json", "write canonical JSON", false)
    .action(async (baselineId: string, candidateId: string, options: { json: boolean }) => {
      commandExitCode = await executeEvalCompare(runtime.evalRuntime, io, { baselineId, candidateId, json: options.json });
    });

  program
    .command("doctor")
    .description("Check local readiness after resolving the effective runtime policy.")
    .option("--policy-profile <id>", "select one complete runtime policy profile")
    .option("--policy-config <absolute-path>", "load trusted user policy profiles")
    .option("--provider <provider>", "diagnose one exact provider request")
    .option("--model <model>", "diagnose one exact model request")
    .option("--ollama-endpoint <url>", "diagnose one exact literal-loopback Ollama endpoint")
    .action(async (options: {
      model?: string;
      ollamaEndpoint?: string;
      policyConfig?: string;
      policyProfile?: string;
      provider?: string;
    }) => {
      commandExitCode = await executeDoctor(runtime, io, options);
    });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
}
