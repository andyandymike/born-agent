import { McpCoreError } from "./mcp-errors.js";

export const MCP_ENVIRONMENT_POLICY_VERSION = "mcp-minimal-env-v1";

const RUNTIME_NAMES = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export function buildMinimalMcpEnvironment(input: {
  readonly mappings: readonly Readonly<{ source: string; target: string }>[];
  readonly sourceEnvironment: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const occupiedNames = new Set<string>();
  for (const [name, value] of Object.entries(input.sourceEnvironment)) {
    if (value !== undefined && RUNTIME_NAMES.has(name.toUpperCase())) {
      output[name] = value;
      occupiedNames.add(name.toUpperCase());
    }
  }
  const seenSources = new Set<string>();
  for (const mapping of input.mappings) {
    if (
      !/^BORN_MCP_[A-Za-z0-9_]{1,119}$/u.test(mapping.source) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(mapping.target)
    ) {
      throw new McpCoreError("mcp_config_invalid", "MCP env source must start with BORN_MCP_");
    }
    if (
      occupiedNames.has(mapping.target.toUpperCase()) ||
      seenSources.has(mapping.source)
    ) {
      throw new McpCoreError("mcp_config_invalid", "MCP env target collides with another mapping or runtime variable");
    }
    const value = input.sourceEnvironment[mapping.source];
    if (value === undefined || value.length === 0) {
      throw new McpCoreError("mcp_environment_missing", `MCP env source ${mapping.source} is missing or empty`);
    }
    output[mapping.target] = value;
    occupiedNames.add(mapping.target.toUpperCase());
    seenSources.add(mapping.source);
  }
  return Object.freeze(output);
}

export interface ReviewedOfflineMcpStart {
  readonly actionSha256: string;
  readonly serverId: string;
}

export function isReviewedOfflineMcpStart(
  action: { readonly actionSha256: string; readonly serverId: string },
  reviews: readonly ReviewedOfflineMcpStart[],
): boolean {
  // PHASE12: local stdio is not proof of offline behavior. The no-cost gate
  // accepts only an exact reviewed fixture action, never a cloud SDK or downloader.
  return reviews.some(
    (review) =>
      review.serverId === action.serverId &&
      review.actionSha256 === action.actionSha256,
  );
}
