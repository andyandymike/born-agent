import { Command, CommanderError } from "commander";

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
    .command("chat")
    .description("Stream a response with at most one read-only tool call.")
    .argument("<prompt>", "text prompt to send; do not paste API keys")
    .option("--provider <provider>", "model provider: openai or ollama")
    .option("--model <model>", "override the provider model")
    .option("--timeout-ms <milliseconds>", "request timeout in milliseconds")
    .option("--no-tools", "disable read-only workspace tools")
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
