import type { McpServerStartActionIdentity } from "./mcp-action-identity.js";
import type { LoadedMcpServerConfig } from "./mcp-config-loader.js";
import type { McpIntegrityManifest } from "./mcp-integrity-manifest.js";

const REQUIRED_FIXTURE_FILES = Object.freeze([
  "fixtures/mcp/server.mjs",
  "package.json",
  "pnpm-lock.yaml",
]);
const REVIEWED_SHA256 = Object.freeze({
  "fixtures/mcp/server.mjs": "9093c8cbf78b9bc29b0d1ae82f2ed75fb6b28af951aa1c3ef786070f53ad3037",
  "package.json": "08d16733823a4b2dcbce80845482abc168174235a1d490a927c99d9a8afa72db",
  "pnpm-lock.yaml": "cddadcf3bc9c49f9279f5d0c1a9478d07d7837350e821d9f5df74f9f37062668",
} as const);

export function isCheckedInOfflineFixture(input: {
  readonly action: McpServerStartActionIdentity;
  readonly config: LoadedMcpServerConfig;
  readonly manifest: McpIntegrityManifest;
}): boolean {
  // PHASE12: stdio only describes framing, not what the child does. The
  // zero-cost acceptance gate therefore recognizes one content-bound,
  // checked-in fixture and rejects cloud SDKs, downloaders, and remote APIs.
  return (
    input.action.serverId === "fixture" &&
    input.action.canonicalCwd === "." &&
    input.action.argv.length === 2 &&
    input.action.argv[0] === "node" &&
    input.action.argv[1]?.replaceAll("\\", "/") === "fixtures/mcp/server.mjs" &&
    input.config.env.length === 0 &&
    input.manifest.binding === "explicit" &&
    input.manifest.entries.map((entry) => entry.path).join("\0") ===
      REQUIRED_FIXTURE_FILES.join("\0") &&
    input.manifest.entries.every(
      (entry) =>
        REVIEWED_SHA256[entry.path as keyof typeof REVIEWED_SHA256] === entry.sha256,
    )
  );
}
