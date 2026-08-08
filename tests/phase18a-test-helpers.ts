import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "../src/completion/canonical-json.js";
import { DefaultCapabilityPlatform } from "../src/capabilities/capability-platform.js";
import { StablePackageReader } from "../src/capabilities/stable-package-reader.js";
import type { StableCapabilityPackage } from "../src/capabilities/capability-types.js";

export interface TestCapabilityPackageOptions {
  readonly componentId?: string;
  readonly displayName?: string;
  readonly extraFiles?: Readonly<Record<string, string | Uint8Array>>;
  readonly includeHook?: boolean;
  readonly includeMcp?: boolean;
  readonly includeSkill?: boolean;
  readonly pluginId?: string;
  readonly pluginVersion?: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${canonicalJson(value)}\n`, "utf8");
}

export async function writeTestCapabilityPackage(
  packageRoot: string,
  options: TestCapabilityPackageOptions = {},
): Promise<StableCapabilityPackage> {
  const componentId = options.componentId ?? "review";
  const includeHook = options.includeHook ?? false;
  const includeMcp = options.includeMcp ?? false;
  const includeSkill = options.includeSkill ?? true;
  const pluginId = options.pluginId ?? "acme.review";
  const pluginVersion = options.pluginVersion ?? "1.0.0";
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, "bornagent.plugin.json"), {
    components: {
      ...(includeHook ? { hooks: ["hook.json"] } : {}),
      ...(includeMcp ? { mcp_servers: ["mcp.json"] } : {}),
      ...(includeSkill ? { skills: ["skill.json"] } : {}),
    },
    description: "Bounded inert test capability package.",
    display_name: options.displayName ?? "Review tools",
    plugin_id: pluginId,
    plugin_version: pluginVersion,
    schema_version: 1,
  });
  if (includeSkill) {
    await writeJson(join(packageRoot, "skill.json"), {
      component_id: componentId,
      context: {
        max_entry_bytes: 4096,
        max_resource_bytes: 4096,
        max_total_resource_bytes: 8192,
      },
      description: "Review one bounded change.",
      display_name: "Review change",
      entry: "SKILL.md",
      invocation: "model_allowed",
      kind: "skill",
      schema_version: 1,
    });
    await writeFile(join(packageRoot, "SKILL.md"), "# Inert test skill\n", "utf8");
  }
  if (includeHook) {
    await writeJson(join(packageRoot, "hook.json"), {
      component_id: `${componentId}-gate`,
      description: "A declarative gate that is not executed in Phase 18A.",
      display_name: "Plan gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        message: "An approved plan is required.",
        predicate: { type: "require_plan_approval" },
        type: "declarative_gate",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: [],
      schema_version: 1,
    });
  }
  if (includeMcp) {
    await writeJson(join(packageRoot, "mcp.json"), {
      args: [],
      call_timeout_ms: 5000,
      component_id: `${componentId}-mcp`,
      cwd: "plugin_root",
      description: "An inert stdio declaration.",
      display_name: "Review MCP",
      env: [],
      executable: "server.js",
      integrity_files: ["server.js"],
      kind: "mcp_server",
      requested_effects: ["process_spawn"],
      schema_version: 1,
      startup_timeout_ms: 1000,
      transport: "stdio",
    });
    await writeFile(
      join(packageRoot, "server.js"),
      "require('node:fs').writeFileSync('phase18a-executed.txt', 'executed');\n",
      "utf8",
    );
  }
  for (const [relativePath, bytes] of Object.entries(options.extraFiles ?? {})) {
    const absolute = join(packageRoot, ...relativePath.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  return StablePackageReader.read(packageRoot);
}

export interface TestSourceEntry {
  readonly enabled: boolean;
  readonly package: StableCapabilityPackage;
  readonly path: string;
}

export async function writeTestSourceIndex(
  indexPath: string,
  revision: number,
  entries: readonly TestSourceEntry[],
): Promise<void> {
  await writeJson(indexPath, {
    packages: entries.map((entry) => ({
      enabled: entry.enabled,
      expected_plugin_sha256: entry.package.pluginSha256,
      path: entry.path,
      plugin_id: entry.package.pluginId,
      plugin_version: entry.package.pluginVersion,
    })),
    revision,
    schema_version: 1,
  });
}

export async function createTestCapabilityRoots(root: string): Promise<{
  readonly builtinRoot: string;
  readonly platform: DefaultCapabilityPlatform;
  readonly userRoot: string;
  readonly workspace: string;
}> {
  const builtinRoot = join(root, "builtin");
  const userRoot = join(root, "user");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(builtinRoot, { recursive: true }),
    mkdir(userRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await writeTestSourceIndex(join(builtinRoot, "index.json"), 1, []);
  return {
    builtinRoot,
    platform: new DefaultCapabilityPlatform({
      builtinRoot,
      env: {},
      platform: process.platform,
      userStateRoot: userRoot,
      workspace,
    }),
    userRoot,
    workspace,
  };
}
