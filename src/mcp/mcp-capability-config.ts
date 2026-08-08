import { resolve } from "node:path";

import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import type { CapabilitySnapshotV1, FrozenCapabilityRecord } from "../capabilities/capability-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { LoadedMcpServerConfig } from "./mcp-config-loader.js";
import { McpCoreError } from "./mcp-errors.js";

function select(
  snapshot: CapabilitySnapshotV1,
  selector: string,
): FrozenCapabilityRecord | undefined {
  const enabled = snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.components)
    .filter((component) => component.enabled && component.identity.kind === "mcp_server");
  const exact = enabled.find((component) => component.identity.qualifiedId === selector);
  if (exact !== undefined) return exact;
  const matches = enabled.filter((component) =>
    component.identity.componentId === selector ||
    `${component.identity.pluginId}/${component.identity.componentId}` === selector
  );
  if (matches.length > 1) {
    throw new McpCoreError("mcp_config_invalid", `ambiguous frozen MCP capability selector: ${selector}`);
  }
  return matches[0];
}

export async function createFrozenCapabilityMcpConfig(input: {
  readonly content: FrozenCapabilityContentSource;
  readonly hostExecutable: string;
  readonly selector: string;
  readonly snapshot: CapabilitySnapshotV1;
  readonly workspace: string;
}): Promise<LoadedMcpServerConfig | undefined> {
  const record = select(input.snapshot, input.selector);
  if (record === undefined) return undefined;
  if (record.metadata.kind !== "mcp_server") {
    throw new McpCoreError("mcp_config_invalid", "frozen MCP component metadata is inconsistent");
  }
  const serverId = record.identity.componentId;
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(serverId)) {
    throw new McpCoreError(
      "mcp_config_invalid",
      "frozen MCP component_id must fit the bounded runtime server ID grammar",
    );
  }
  const declared = [...new Set([
    record.metadata.executable,
    ...record.metadata.integrity_files,
  ])];
  const captured = await Promise.all(
    declared.map((path) => input.content.readComponentFile(record.identity, path)),
  );
  const executable = captured[0]!;
  const integrity = captured.map((file) => file.path).sort();
  const packageRoot = executable.packageRoot;
  const logicalArgs = [
    `capability:${record.identity.qualifiedId}/${record.metadata.executable}`,
    ...record.metadata.args,
  ];
  const configSha256 = sha256Canonical({
    args: logicalArgs,
    capabilityIdentity: record.identity,
    callTimeoutMs: record.metadata.call_timeout_ms,
    cwd: record.metadata.cwd,
    env: record.metadata.env,
    executableSha256: executable.sha256,
    integrity: captured.map((file) => ({ path: file.path, sha256: file.sha256 })),
    startupTimeoutMs: record.metadata.startup_timeout_ms,
    transport: "stdio",
  });
  return Object.freeze({
    args: Object.freeze(logicalArgs),
    callTimeoutMs: record.metadata.call_timeout_ms,
    canonicalCwd: record.metadata.cwd,
    configSha256,
    env: Object.freeze(record.metadata.env.map((mapping) => Object.freeze({ ...mapping }))),
    executable: input.hostExecutable,
    executionCwd:
      record.metadata.cwd === "workspace_root"
        ? resolve(input.workspace)
        : resolve(packageRoot),
    integrityFiles: Object.freeze(integrity),
    integrityRoot: packageRoot,
    origin: "capability_snapshot",
    revalidate: async () => {
      const current = await Promise.all(
        declared.map((path) => input.content.readComponentFile(record.identity, path)),
      );
      if (
        current.some((file, index) =>
          file.sha256 !== captured[index]?.sha256 ||
          file.path !== captured[index]?.path ||
          file.packageRoot !== packageRoot
        )
      ) {
        throw new McpCoreError(
          "mcp_config_invalid",
          "frozen MCP component bytes changed after selection",
        );
      }
    },
    serverId,
    spawnArgs: Object.freeze([executable.absolutePath, ...record.metadata.args]),
    startupTimeoutMs: record.metadata.startup_timeout_ms,
    transport: "stdio",
  });
}
