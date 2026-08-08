import { Command, CommanderError } from "commander";

import { executeAgent } from "../commands/agent.js";
import { executeChat } from "../commands/chat.js";
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
import { executeMcpInspect, executeMcpList } from "../commands/mcp.js";
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

  const capabilities = program
    .command("capabilities")
    .description("Inspect the exact local capability catalog without executing components.");

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
          taskProfile?: string;
          verbose: boolean;
        },
      ) => {
        commandExitCode = await executeAgent(
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
        commandExitCode = await executeChat(
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
