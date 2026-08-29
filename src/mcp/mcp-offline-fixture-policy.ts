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
  // FAL-EM0: this remains a frozen byte oracle. The reviewed package scripts
  // expose only local, explicit frontier-lab baseline commands.
  "package.json": "f1816aa6a349bc22fcb65d4015ebf92f58d53e27b75309292b318a1b252d26d1",
  "pnpm-lock.yaml": "cddadcf3bc9c49f9279f5d0c1a9478d07d7837350e821d9f5df74f9f37062668",
} as const);

const PHASE18_REQUIRED_FIXTURE_FILES = Object.freeze([
  "fixtures/mcp/phase18-server/resources/guide.md",
  "fixtures/mcp/phase18-server/resources/large.txt",
  "fixtures/mcp/phase18-server/server.mjs",
  "package.json",
  "pnpm-lock.yaml",
]);
const PHASE18_REVIEWED_SHA256 = Object.freeze({
  "fixtures/mcp/phase18-server/resources/guide.md": "687e67e92fb08155e839600ccf1e3c4c279543a5d9ecab32e48378b97620fab8",
  "fixtures/mcp/phase18-server/resources/large.txt": "29300fac5e5817c9cf9dc0a6c01b93ab88799a1b8f6996e325f4855dd0bc7417",
  "fixtures/mcp/phase18-server/server.mjs": "b1957b5fb498edc6b3a6adb338e85612a156d447e42241f51bb5dfce75aa31c8",
  "package.json": "f1816aa6a349bc22fcb65d4015ebf92f58d53e27b75309292b318a1b252d26d1",
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
  const phase12 = (
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
  const phase18 = (
    input.action.serverId === "phase18" &&
    input.action.canonicalCwd === "." &&
    input.action.argv.length === 2 &&
    input.action.argv[0] === "node" &&
    input.action.argv[1]?.replaceAll("\\", "/") ===
      "fixtures/mcp/phase18-server/server.mjs" &&
    input.config.env.length === 0 &&
    input.manifest.binding === "explicit" &&
    input.manifest.entries.map((entry) => entry.path).join("\0") ===
      PHASE18_REQUIRED_FIXTURE_FILES.join("\0") &&
    input.manifest.entries.every(
      (entry) =>
        PHASE18_REVIEWED_SHA256[
          entry.path as keyof typeof PHASE18_REVIEWED_SHA256
        ] === entry.sha256,
    )
  );
  return phase12 || phase18;
}
