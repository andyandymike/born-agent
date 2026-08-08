import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultCapabilityPlatform } from "../../src/capabilities/capability-platform.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { PluginLifecycle } from "../../src/plugins/plugin-lifecycle.js";
import { writeTestCapabilityPackage } from "../phase18a-test-helpers.js";

const RUN_ID = "20000000-0000-4000-8000-000000000018";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "bornagent-phase18e-lifecycle-"));
  temporary.push(base);
  const workspace = join(base, "workspace");
  const userRoot = join(base, "user-state");
  const builtinRoot = join(base, "builtin");
  await Promise.all([mkdir(workspace), mkdir(builtinRoot)]);
  await writeFile(join(builtinRoot, "index.json"), `${canonicalJson({
    packages: [],
    revision: 1,
    schema_version: 1,
  })}\n`, "utf8");
  let counter = 0;
  const randomUUID = () => {
    counter += 1;
    return `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  const lifecycle = new PluginLifecycle({
    isProcessAlive: (pid) => pid === process.pid,
    now: () => "2026-08-08T00:00:00.000Z",
    randomUUID,
    root: userRoot,
    workspace,
  });
  return { base, builtinRoot, lifecycle, userRoot, workspace };
}

describe("Phase 18E local Plugin lifecycle", () => {
  it("inspects without writes, installs disabled, freezes enabled bytes, leases, disables, and removes logically", async () => {
    const value = await fixture();
    const source = resolve("fixtures/capability-platform/m9-review-pack");
    const inspection = await value.lifecycle.inspect(source);
    expect(inspection).toMatchObject({
      pluginId: "bornagent.m9-review-pack",
      status: "valid_schema",
    });
    await expect(access(value.userRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await value.lifecycle.install(source, inspection.pluginSha256);
    expect(installed).toMatchObject({ changed: true, deduplicated: false, pendingNextRun: false });
    expect((await value.lifecycle.list())[0]).toMatchObject({ enabled: false });

    const enabled = await value.lifecycle.enable(installed.exactSelector);
    expect(enabled).toMatchObject({ beforeRevision: 0, afterRevision: 1, pendingNextRun: true });
    const platform = new DefaultCapabilityPlatform({
      builtinRoot: value.builtinRoot,
      env: {},
      platform: process.platform,
      pluginLifecycle: value.lifecycle,
      userStateRoot: value.userRoot,
      workspace: value.workspace,
    });
    const snapshot = await platform.createSnapshot("2026-08-08T00:00:00.000Z");
    expect(snapshot.plugins.some((plugin) => plugin.pluginSha256 === inspection.pluginSha256)).toBe(true);
    const leases = await platform.acquireContentLeases(snapshot, RUN_ID);
    expect(leases).toHaveLength(1);

    await value.lifecycle.disable(installed.exactSelector);
    const frozenSkill = snapshot.plugins
      .flatMap((plugin) => plugin.components)
      .find((component) => component.identity.componentId === "review-change")!;
    const content = await platform.createContentSource(snapshot).readComponentFile(
      frozenSkill.identity,
      "SKILL.md",
    );
    expect(Buffer.from(content.bytes).toString("utf8")).toContain("# Review change");

    const removed = await value.lifecycle.remove(installed.exactSelector);
    expect(removed).toMatchObject({ changed: true, retainedContent: true });
    expect(await value.lifecycle.list()).toHaveLength(0);
    await expect(access(join(
      value.userRoot,
      "store",
      "v1",
      "sha256",
      inspection.pluginSha256,
      "bornagent.plugin.json",
    ))).resolves.toBeUndefined();
    await leases[0]!.release();

    const audit = await readFile(join(value.userRoot, "audit", "v1", "events.jsonl"), "utf8");
    expect(audit.trim().split("\n").map((line) => JSON.parse(line).operation)).toEqual([
      "installed",
      "enabled",
      "disabled",
      "removed",
    ]);
    await expect(value.lifecycle.install(source, inspection.pluginSha256)).resolves.toMatchObject({
      changed: true,
      exactSelector: installed.exactSelector,
      retainedContent: true,
    });
  });

  it("deduplicates exact installs, rejects enablement conflicts, and fails closed on store tamper", async () => {
    const value = await fixture();
    const firstSource = join(value.workspace, "first");
    const secondSource = join(value.workspace, "second");
    const firstPackage = await writeTestCapabilityPackage(firstSource, {
      pluginId: "acme.collision",
      pluginVersion: "1.0.0",
    });
    const secondPackage = await writeTestCapabilityPackage(secondSource, {
      extraFiles: { "SKILL.md": "# Different exact bytes\n" },
      pluginId: "acme.collision",
      pluginVersion: "1.0.0",
    });
    const first = await value.lifecycle.install(firstSource, firstPackage.pluginSha256);
    await expect(value.lifecycle.install(firstSource, firstPackage.pluginSha256)).resolves.toMatchObject({
      changed: false,
      deduplicated: true,
    });
    const second = await value.lifecycle.install(secondSource, secondPackage.pluginSha256);
    await value.lifecycle.enable(first.exactSelector);
    await expect(value.lifecycle.enable(second.exactSelector)).rejects.toMatchObject({
      code: "plugin_enablement_conflict",
    });

    await writeFile(join(
      value.userRoot,
      "store",
      "v1",
      "sha256",
      firstPackage.pluginSha256,
      "SKILL.md",
    ), "tampered\n", "utf8");
    await expect(value.lifecycle.show(first.exactSelector)).rejects.toMatchObject({
      code: "plugin_tampered",
    });
  });
});
