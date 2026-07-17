import { Command, CommanderError } from "commander";

import { executeAgent } from "../commands/agent.js";
import { executeChat } from "../commands/chat.js";
import { executeDoctor } from "../commands/doctor.js";
import { executeModels } from "../commands/models.js";
import {
  executeSessionsList,
  executeSessionsResume,
  executeSessionsShow,
} from "../commands/sessions.js";
import type { CliIO, CliRuntime } from "./types.js";
import { executeTui } from "../tui/run-tui.js";

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

  program
    .command("agent")
    // PHASE4: agent 是独立命令；chat 继续保留 Phase 3 的最多一次工具往返，避免语义偷换。
    .description("Run a budgeted coding AgentLoop over the workspace.")
    .argument("<task>", "repository task to answer; do not paste API keys")
    .option("--provider <provider>", "model provider: openai, anthropic, or ollama")
    .option("--model <model>", "override the provider model")
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
          maxDurationMs?: string;
          maxCommandOutputBytes?: string;
          maxSteps?: string;
          maxTokens?: string;
          maxToolOutputBytes?: string;
          model?: string;
          provider?: string;
          reportFormat?: string;
          requireVerification?: string;
          requestTimeoutMs?: string;
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
            maxDurationMs: options.maxDurationMs,
            maxCommandOutputBytes: options.maxCommandOutputBytes,
            maxSteps: options.maxSteps,
            maxTokens: options.maxTokens,
            maxToolOutputBytes: options.maxToolOutputBytes,
            model: options.model,
            provider: options.provider,
            reportFormat: options.reportFormat,
            requireVerification: options.requireVerification,
            requestTimeoutMs: options.requestTimeoutMs,
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
          provider?: string;
          timeoutMs?: string;
          tools: boolean;
          verbose: boolean;
        },
      ) => {
        commandExitCode = await executeChat(
          {
            model: options.model,
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
          maxCommandOutputBytes?: string;
          maxDurationMs?: string;
          maxSteps?: string;
          maxTokens?: string;
          maxToolOutputBytes?: string;
          model?: string;
          provider?: string;
          reportFormat?: string;
          requireVerification?: string;
          requestTimeoutMs?: string;
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
            maxCommandOutputBytes: options.maxCommandOutputBytes,
            maxDurationMs: options.maxDurationMs,
            maxSteps: options.maxSteps,
            maxTokens: options.maxTokens,
            maxToolOutputBytes: options.maxToolOutputBytes,
            model: options.model,
            provider: options.provider,
            reportFormat: options.reportFormat,
            requireVerification: options.requireVerification,
            requestTimeoutMs: options.requestTimeoutMs,
            resumeSessionId: options.resume,
            task,
            taskProfile: options.taskProfile,
          },
          runtime,
          io,
        );
      },
    );

  program
    .command("models")
    .description("List the versioned local model capability catalog.")
    .option("--provider <provider>", "filter by provider")
    .option("--json", "write the versioned JSON document", false)
    .option(
      "--refresh-local",
      "query literal-loopback Ollama /api/tags with a short timeout",
      false,
    )
    .action(
      async (options: {
        json: boolean;
        provider?: string;
        refreshLocal: boolean;
      }) => {
        commandExitCode = await executeModels(
          {
            json: options.json,
            provider: options.provider,
            refreshLocal: options.refreshLocal,
          },
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

  sessions
    .command("resume")
    .description("Create a new run from a verified safe resume boundary.")
    .argument("<session-id>", "canonical session UUID")
    .option("--message <text>", "new user turn for a completed session")
    .option(
      "--allow-degraded-resume",
      "explicitly accept loss of provider-private continuation state",
      false,
    )
    .action(
      async (
        sessionId: string,
        options: { allowDegradedResume: boolean; message?: string },
      ) => {
        commandExitCode = await executeSessionsResume(
          {
            allowDegradedResume: options.allowDegradedResume,
            message: options.message,
            sessionId,
          },
          runtime,
          io,
        );
      },
    );

  program
    .command("doctor")
    .description("Check whether the local environment is ready.")
    .action(async () => {
      commandExitCode = await executeDoctor(runtime, io);
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
