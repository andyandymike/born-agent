import { normalizeAssistantText, runChat } from "../chat/run-chat.js";
import type {
  ChatCommandOptions,
  ChatResponse,
  ChatRuntime,
} from "../chat/types.js";
import type { CliIO } from "../cli/types.js";

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatVerbose(
  provider: string,
  response: ChatResponse,
  elapsedMs: number,
): string {
  const fields = [
    `provider=${oneLine(provider)}`,
    `model=${oneLine(response.model)}`,
    response.providerResponseId === undefined
      ? undefined
      : `response_id=${oneLine(response.providerResponseId)}`,
    response.usage === undefined
      ? undefined
      : `input_tokens=${response.usage.inputTokens}`,
    response.usage === undefined
      ? undefined
      : `output_tokens=${response.usage.outputTokens}`,
    response.usage === undefined
      ? undefined
      : `total_tokens=${response.usage.totalTokens}`,
    `elapsed_ms=${Math.round(elapsedMs)}`,
  ].filter((value): value is string => value !== undefined);

  return `${fields.join(" ")}\n`;
}

export async function executeChat(
  options: ChatCommandOptions,
  runtime: ChatRuntime,
  io: CliIO,
): Promise<number> {
  const result = await runChat(options, runtime);

  if (!result.ok) {
    io.stderr.write(`${result.error}\n`);
    return result.exitCode;
  }

  io.stdout.write(normalizeAssistantText(result.response.text));
  if (options.verbose) {
    io.stderr.write(
      formatVerbose(result.provider, result.response, result.elapsedMs),
    );
  }
  return 0;
}
