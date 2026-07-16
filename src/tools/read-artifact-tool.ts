import { z } from "zod";

import {
  ArtifactError,
  MAX_ARTIFACT_READ_BYTES,
} from "../artifacts/artifact-types.js";
import type { ArtifactReader } from "../artifacts/artifact-reader.js";
import { toolError } from "./tool-errors.js";
import type { ToolDefinition, ToolRawResult } from "./tool-types.js";

const READ_ARTIFACT_TOOL_OUTPUT_BYTES =
  MAX_ARTIFACT_READ_BYTES * 2 + 8 * 1024;

export const readArtifactInputSchema = z
  .object({
    artifact_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .describe("Required. A current-session sha256 artifact id."),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_ARTIFACT_READ_BYTES)
      .describe("Required. At most 65536 UTF-8 source bytes to read."),
    offset_bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Required. A zero-based UTF-8 byte boundary."),
  })
  .strict();

type ReadArtifactInput = z.infer<typeof readArtifactInputSchema>;

function artifactFailure(error: ArtifactError): ToolRawResult {
  switch (error.code) {
    case "artifact_id_invalid":
    case "artifact_limit_invalid":
    case "artifact_offset_invalid":
    case "artifact_offset_not_utf8_boundary":
      return {
        error: toolError(
          "invalid_arguments",
          error.code,
          "artifact read arguments are invalid",
        ),
        ok: false,
      };
    case "artifact_not_allowlisted":
      return {
        error: toolError(
          "permission",
          error.code,
          "artifact is not referenced by the current session",
        ),
        ok: false,
      };
    case "artifact_reference_invalid":
      return {
        error: toolError(
          "tool",
          error.code,
          "artifact reference is invalid",
        ),
        ok: false,
      };
    case "artifact_missing":
      return {
        error: toolError(
          "not_found",
          error.code,
          "artifact content or metadata is missing",
        ),
        ok: false,
      };
    case "artifact_corrupt":
    case "artifact_metadata_corrupt":
      return {
        error: toolError(
          "tool",
          error.code,
          "artifact integrity verification failed",
        ),
        ok: false,
      };
    case "artifact_not_text":
    case "artifact_source_binary":
    case "artifact_source_invalid_utf8":
      return {
        error: toolError(
          "tool",
          error.code,
          "artifact is not supported UTF-8 text",
        ),
        ok: false,
      };
    case "artifact_budget_invalid":
    case "artifact_path_unsafe":
    case "artifact_persist_failed":
      return {
        error: toolError(
          "system",
          error.code,
          "artifact storage could not be read safely",
        ),
        ok: false,
      };
  }
}

export function createReadArtifactTool(
  reader: ArtifactReader,
): ToolDefinition<ReadArtifactInput> {
  return {
    capability: "read",
    description:
      "Read a bounded UTF-8 slice of an artifact referenced by the current session. Offsets are byte offsets and must be UTF-8 boundaries.",
    execute: async (input, context) => {
      if (context.signal.aborted) {
        return {
          error: toolError(
            "cancelled",
            "tool_cancelled",
            "artifact read was cancelled",
          ),
          ok: false,
        };
      }
      try {
        const result = await reader.read({
          artifactId: input.artifact_id,
          maxBytes: input.max_bytes,
          offsetBytes: input.offset_bytes,
        });
        if (context.signal.aborted) {
          return {
            error: toolError(
              "cancelled",
              "tool_cancelled",
              "artifact read was cancelled",
            ),
            ok: false,
          };
        }
        const truncated = !result.eof;
        return {
          ok: true,
          truncated,
          value: {
            artifact_id: result.artifactId,
            content: result.content,
            content_bytes: result.contentBytes,
            eof: result.eof,
            media_type: result.mediaType,
            next_offset_bytes: result.nextOffsetBytes,
            offset_bytes: result.offsetBytes,
            sha256: result.sha256,
            source_bytes: result.sourceBytes,
            truncated,
          },
        };
      } catch (error) {
        if (error instanceof ArtifactError) return artifactFailure(error);
        return {
          error: toolError(
            "system",
            "artifact_read_failed",
            "artifact could not be read safely",
          ),
          ok: false,
        };
      }
    },
    inputSchema: readArtifactInputSchema,
    // PHASE10: read_artifact returns structured data and lets ToolRegistry make
    // the one canonical JSON string. That registry output is therefore exactly
    // what a call event records and what the next model request observes.
    maxOutputBytes: READ_ARTIFACT_TOOL_OUTPUT_BYTES,
    name: "read_artifact",
  };
}
