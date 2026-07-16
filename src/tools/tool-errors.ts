import { redactSensitiveText } from "../security/redact.js";
import {
  MAX_TOOL_OUTPUT_BYTES,
  type ToolError,
  type ToolExecution,
} from "./tool-types.js";

export function toolError(
  category: ToolError["category"],
  code: string,
  message: string,
  retryable = false,
): ToolError {
  return { category, code, message, retryable };
}

export function serializeToolError(
  error: ToolError,
  secrets: readonly (string | undefined)[] = [],
): ToolExecution {
  const safeError = {
    ...error,
    message: redactSensitiveText(error.message, secrets),
  };
  const output = JSON.stringify({ error: safeError, ok: false });
  if (Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    return serializeToolError(
      toolError("system", "tool_error_too_large", "tool error is too large"),
    );
  }
  return { error: safeError, ok: false, output, truncated: false };
}
