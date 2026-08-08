import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatQualifiedCapabilityId,
  parseQualifiedCapabilityId,
} from "../../src/capabilities/capability-id.js";
import {
  CapabilityRegistryBuilder,
} from "../../src/capabilities/capability-registry.js";
import {
  BuiltinCapabilitySource,
  UserInstallCapabilitySource,
  WorkspaceCapabilitySource,
} from "../../src/capabilities/capability-source.js";
import type {
  CapabilitySource,
  CapabilitySourceDiscovery,
} from "../../src/capabilities/capability-types.js";
import {
  createTestCapabilityRoots,
  writeTestCapabilityPackage,
  writeTestSourceIndex,
} from "../phase18a-test-helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase18a-registry-"));
  temporary.push(value);
  return value;
}

describe("Phase 18A deterministic capability registry", () => {
  it("discovers all explicit sources without source precedence and preserves enablement", async () => {
    const roots = await createTestCapabilityRoots(await root());
    const builtin = await writeTestCapabilityPackage(
      join(roots.builtinRoot, "builtin-review"),
      { componentId: "review", pluginId: "builtin.review" },
    );
    const user = await writeTestCapabilityPackage(join(roots.userRoot, "user-review"), {
      componentId: "review",
      includeHook: true,
      includeMcp: true,
      pluginId: "user.review",
    });
    const workspacePackage = await writeTestCapabilityPackage(
      join(roots.workspace, "tools", "workspace-review"),
      { componentId: "review", pluginId: "workspace.review" },
    );
    await writeTestSourceIndex(join(roots.builtinRoot, "index.json"), 2, [
      { enabled: true, package: builtin, path: "builtin-review" },
    ]);
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 7, [
      { enabled: true, package: user, path: "user-review" },
    ]);
    await mkdir(join(roots.workspace, ".bornagent"), { recursive: true });
    await writeTestSourceIndex(
      join(roots.workspace, ".bornagent", "capabilities.json"),
      3,
      [{ enabled: false, package: workspacePackage, path: "tools/workspace-review" }],
    );

    const registry = await roots.platform.buildRegistry();
    expect(registry.list().map((record) => record.identity.source)).toEqual([
      "builtin",
      "user_install",
      "user_install",
      "user_install",
      "workspace",
    ]);
    expect(registry.list(undefined, true)).toHaveLength(4);
    expect(registry.catalog.sourceRevisions).toEqual({
      builtin: 2,
      user_install: 7,
      workspace: 3,
    });
    const mcp = registry.list("mcp_server")[0]!;
    expect(mcp.requestedEffects).toEqual(["process_spawn"]);
    expect(mcp).not.toHaveProperty("grantedEffects");
    expect(registry.catalog.diagnostics).toContainEqual(
      expect.objectContaining({ code: "capability_workspace_content_untrusted" }),
    );
    expect(() => registry.resolveUniqueReadOnly("review")).toThrow(
      /ambiguous/u,
    );
    expect(registry.getExact(mcp.identity.qualifiedId)).toBe(mcp);
  });

  it("deduplicates exact bytes but rejects same source/id/version with different bytes", async () => {
    const roots = await createTestCapabilityRoots(await root());
    const first = await writeTestCapabilityPackage(join(roots.userRoot, "first"));
    const duplicate = await writeTestCapabilityPackage(join(roots.userRoot, "duplicate"));
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 1, [
      { enabled: true, package: duplicate, path: "duplicate" },
      { enabled: true, package: first, path: "first" },
    ]);
    const deduplicated = await roots.platform.buildRegistry();
    expect(deduplicated.catalog.plugins).toHaveLength(1);
    expect(deduplicated.catalog.diagnostics).toContainEqual(
      expect.objectContaining({ code: "capability_duplicate_exact_identity" }),
    );

    const conflicting = await writeTestCapabilityPackage(join(roots.userRoot, "conflict"), {
      extraFiles: { "different.txt": "different bytes" },
    });
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 2, [
      { enabled: true, package: first, path: "first" },
      { enabled: true, package: conflicting, path: "conflict" },
    ]);
    await expect(roots.platform.buildRegistry()).rejects.toMatchObject({
      code: "plugin_tampered_or_conflicting",
    });
  });

  it("fails with exit 8 when exact enablement bytes or identity are stale", async () => {
    const roots = await createTestCapabilityRoots(await root());
    const stable = await writeTestCapabilityPackage(join(roots.userRoot, "review"));
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 1, [
      { enabled: true, package: stable, path: "review" },
    ]);
    await writeFile(join(roots.userRoot, "review", "SKILL.md"), "tampered\n", "utf8");
    await expect(roots.platform.buildRegistry()).rejects.toMatchObject({
      code: "plugin_tampered_or_conflicting",
      exitCode: 8,
    });

    const current = await writeTestCapabilityPackage(join(roots.userRoot, "other"), {
      pluginId: "other.review",
    });
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 2, [
      { enabled: true, package: current, path: "other" },
    ]);
    const raw = JSON.parse(
      await readFile(join(roots.userRoot, "enablement.json"), "utf8"),
    ) as { packages: Array<Record<string, unknown>> };
    raw.packages[0]!.plugin_id = "wrong.review";
    await writeFile(
      join(roots.userRoot, "enablement.json"),
      `${JSON.stringify(raw)}\n`,
      "utf8",
    );
    await expect(roots.platform.buildRegistry()).rejects.toMatchObject({
      code: "plugin_tampered_or_conflicting",
      exitCode: 8,
    });
  });

  it("rechecks enablement after package reads and fails on a concurrent revision", async () => {
    const base = await root();
    const packageValue = await writeTestCapabilityPackage(join(base, "package"));
    let calls = 0;
    const source: CapabilitySource = {
      discover: async (): Promise<CapabilitySourceDiscovery> => {
        calls += 1;
        const revision = calls === 1 ? 1 : 2;
        return {
          candidates: [{
            enabled: true,
            enablementRevision: revision,
            expectedPluginId: packageValue.pluginId,
            expectedPluginSha256: packageValue.pluginSha256,
            expectedPluginVersion: packageValue.pluginVersion,
            packageRoot: packageValue.packageRoot,
            source: "user_install",
            sourceRef: "user_install:package",
          }],
          revision,
          source: "user_install",
        };
      },
    };
    await expect(new CapabilityRegistryBuilder([source]).build()).rejects.toMatchObject({
      code: "capability_source_unstable",
    });
  });

  it("round-trips only full exact capability IDs", () => {
    const value = formatQualifiedCapabilityId({
      componentId: "review",
      componentSha256: "a".repeat(64),
      kind: "skill",
      pluginId: "acme.review",
      pluginVersion: "1.0.0",
      source: "user_install",
    });
    expect(parseQualifiedCapabilityId(value)).toEqual({
      componentId: "review",
      componentSha256: "a".repeat(64),
      kind: "skill",
      pluginId: "acme.review",
      pluginVersion: "1.0.0",
      source: "user_install",
    });
    expect(() => parseQualifiedCapabilityId("acme.review/review")).toThrow(
      /exact source/u,
    );
  });

  it("keeps source adapters deterministic regardless of constructor order", async () => {
    const roots = await createTestCapabilityRoots(await root());
    const value = await writeTestCapabilityPackage(join(roots.userRoot, "review"));
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 4, [
      { enabled: true, package: value, path: "review" },
    ]);
    const forward = await new CapabilityRegistryBuilder([
      new BuiltinCapabilitySource(roots.builtinRoot),
      new UserInstallCapabilitySource(roots.userRoot),
      new WorkspaceCapabilitySource(roots.workspace),
    ]).build();
    const reverse = await new CapabilityRegistryBuilder([
      new WorkspaceCapabilitySource(roots.workspace),
      new UserInstallCapabilitySource(roots.userRoot),
      new BuiltinCapabilitySource(roots.builtinRoot),
    ]).build();
    expect(reverse.catalog).toEqual(forward.catalog);
  });
});
