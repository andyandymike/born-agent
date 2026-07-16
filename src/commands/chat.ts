import { runStreamingChat } from "../chat/run-streaming-chat.js";
import type { ChatCommandOptions } from "../chat/types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { ConsoleEventRenderer } from "../render/console-event-renderer.js";

export async function executeChat(
  options: ChatCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  const renderer = new ConsoleEventRenderer(io, options.verbose);
  return runStreamingChat(options, runtime, renderer);
}
