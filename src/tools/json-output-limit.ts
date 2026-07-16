import { MAX_TOOL_OUTPUT_BYTES } from "./tool-types.js";

export function fitsToolOutput(value: Readonly<Record<string, unknown>>): boolean {
  return (
    Buffer.byteLength(JSON.stringify({ ...value, ok: true }), "utf8") <=
    MAX_TOOL_OUTPUT_BYTES
  );
}
