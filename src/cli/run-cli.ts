import { Command, CommanderError } from "commander";

import { executeAgent } from "../commands/agent.js";
import { executeChat } from "../commands/chat.js";
import { executeDoctor } from "../commands/doctor.js";
import type { CliIO, CliRuntime } from "./types.js";

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
    .option("--provider <provider>", "model provider: openai or ollama")
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
    .option("--verbose", "write step and budget metadata to stderr", false)
    .addHelpText(
      "after",
      "\nSecurity: tasks and allowed tool observations are saved locally in .bornagent/sessions; do not paste secrets.\n",
    )
    .action(
      async (
        task: string,
        options: {
          commandApproval?: string;
          commandTimeoutMs?: string;
          completionPolicy?: string;
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
            commandApproval: options.commandApproval,
            commandTimeoutMs: options.commandTimeoutMs,
            completionPolicy: options.completionPolicy,
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
    .option("--provider <provider>", "model provider: openai or ollama")
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
