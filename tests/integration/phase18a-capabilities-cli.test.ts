import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultCapabilityPlatform } from "../../src/capabilities/capability-platform.js";
import { runCli } from "../../src/cli/run-cli.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
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
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase18a-cli-"));
  temporary.push(value);
  return value;
}

describe("Phase 18A capabilities CLI", () => {
  it("lists, filters, shows, and diagnoses exact inert metadata in human and JSON modes", async () => {
    const roots = await createTestCapabilityRoots(await root());
    const user = await writeTestCapabilityPackage(join(roots.userRoot, "review"), {
      includeHook: true,
      includeMcp: true,
    });
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 8, [
      { enabled: true, package: user, path: "review" },
    ]);
    const createSessionWriter = vi.fn(createRuntime().createSessionWriter);
    const createModelBackend = vi.fn(createRuntime().createModelBackend);
    const runtime = createRuntime({
      createCapabilityPlatform: () => roots.platform,
      createModelBackend,
      createSessionWriter,
      cwd: roots.workspace,
    });

    const list = createMemoryIO();
    expect(
      await runCli(
        ["capabilities", "list", "--source", "user_install", "--kind", "skill", "--json"],
        list.io,
        runtime,
      ),
    ).toBe(0);
    const catalog = JSON.parse(list.readStdout()) as {
      capabilities: Array<Record<string, unknown>>;
      enablementRevision: number;
      schemaVersion: number;
    };
    expect(catalog).toMatchObject({ enablementRevision: 8, schemaVersion: 1 });
    expect(catalog.capabilities).toHaveLength(1);
    expect(catalog.capabilities[0]).toMatchObject({
      enabled: true,
      kind: "skill",
      source: "user_install",
      sourceRef: "user_install:review",
      status: "ready",
    });
    expect(String(catalog.capabilities[0]!.sourceRef)).not.toContain(roots.userRoot);

    const qualifiedId = String(catalog.capabilities[0]!.qualifiedId);
    const show = createMemoryIO();
    expect(
      await runCli(["capabilities", "show", qualifiedId, "--json"], show.io, runtime),
    ).toBe(0);
    expect(JSON.parse(show.readStdout())).toMatchObject({
      capability: {
        componentMetadata: { component_id: "review", kind: "skill" },
        componentPath: "skill.json",
        componentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        diagnostics: [],
        inventory: expect.arrayContaining([
          expect.objectContaining({ path: "bornagent.plugin.json" }),
          expect.objectContaining({ path: "skill.json" }),
        ]),
        inventorySha256: user.inventorySha256,
        manifest: { plugin_id: "acme.review", plugin_version: "1.0.0" },
        manifestSha256: user.manifestSha256,
        pluginSha256: user.pluginSha256,
        requestedEffects: [],
      },
      schemaVersion: 1,
    });

    const human = createMemoryIO();
    expect(await runCli(["capabilities", "list"], human.io, runtime)).toBe(0);
    expect(human.readStdout()).toContain("status=ready");
    expect(human.readStdout()).toContain("package=");

    const doctor = createMemoryIO();
    expect(
      await runCli(["capabilities", "doctor", "--json"], doctor.io, runtime),
    ).toBe(0);
    expect(JSON.parse(doctor.readStdout())).toMatchObject({
      componentCount: 3,
      eligiblePluginCount: 1,
      status: "valid",
    });
    expect(createSessionWriter).not.toHaveBeenCalled();
    expect(createModelBackend).not.toHaveBeenCalled();
  });

  it("maps invalid config, missing built-in assets, and digest tamper to 2/3/8", async () => {
    const roots = await createTestCapabilityRoots(await root());
    await writeFile(join(roots.userRoot, "enablement.json"), "{\"revision\":1,\"revision\":2}\n", "utf8");
    const invalid = createMemoryIO();
    expect(
      await runCli(
        ["capabilities", "doctor", "--json"],
        invalid.io,
        createRuntime({
          createCapabilityPlatform: () => roots.platform,
          cwd: roots.workspace,
        }),
      ),
    ).toBe(2);
    expect(invalid.readStdout()).toBe("");
    expect(invalid.readStderr()).toContain("capability_state_invalid");
    expect(invalid.readStderr()).not.toContain(roots.userRoot);

    const missingBuiltin = new DefaultCapabilityPlatform({
      builtinRoot: join(roots.workspace, "missing-builtin"),
      env: {},
      platform: process.platform,
      userStateRoot: join(roots.workspace, "missing-user"),
      workspace: roots.workspace,
    });
    const missing = createMemoryIO();
    expect(
      await runCli(
        ["capabilities", "doctor"],
        missing.io,
        createRuntime({
          createCapabilityPlatform: () => missingBuiltin,
          cwd: roots.workspace,
        }),
      ),
    ).toBe(3);

    await writeFile(join(roots.userRoot, "enablement.json"), "", "utf8");
    const packageValue = await writeTestCapabilityPackage(join(roots.userRoot, "review"));
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 3, [
      { enabled: true, package: packageValue, path: "review" },
    ]);
    await writeFile(join(roots.userRoot, "review", "SKILL.md"), "tampered\n", "utf8");
    const tampered = createMemoryIO();
    expect(
      await runCli(
        ["capabilities", "doctor", "--json"],
        tampered.io,
        createRuntime({
          createCapabilityPlatform: () => roots.platform,
          cwd: roots.workspace,
        }),
      ),
    ).toBe(8);
    expect(tampered.readStderr()).toContain("plugin_tampered_or_conflicting");
  });

  it("requires an absolute workspace and never scans an unlisted package", async () => {
    const roots = await createTestCapabilityRoots(await root());
    await mkdir(join(roots.workspace, "unlisted"), { recursive: true });
    await writeTestCapabilityPackage(join(roots.workspace, "unlisted", "package"));
    const runtime = createRuntime({
      createCapabilityPlatform: () => roots.platform,
      cwd: roots.workspace,
    });
    const relative = createMemoryIO();
    expect(
      await runCli(
        ["capabilities", "list", "--workspace", "relative"],
        relative.io,
        runtime,
      ),
    ).toBe(2);
    const listed = createMemoryIO();
    expect(await runCli(["capabilities", "list", "--json"], listed.io, runtime)).toBe(0);
    expect(JSON.parse(listed.readStdout()).capabilities).toEqual([]);
  });
});
