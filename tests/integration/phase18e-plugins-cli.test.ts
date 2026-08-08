import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultCapabilityPlatform } from "../../src/capabilities/capability-platform.js";
import { runCli } from "../../src/cli/run-cli.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { PluginLifecycle } from "../../src/plugins/plugin-lifecycle.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 18E plugins CLI", () => {
  it("keeps inspect/session-free, requires enable confirmation, and exposes exact future-run state", async () => {
    const base = await mkdtemp(join(tmpdir(), "bornagent-phase18e-cli-"));
    temporary.push(base);
    const workspace = join(base, "workspace");
    const builtinRoot = join(base, "builtin");
    const userRoot = join(base, "user");
    await Promise.all([mkdir(workspace), mkdir(builtinRoot)]);
    await writeFile(join(builtinRoot, "index.json"), `${canonicalJson({ packages: [], revision: 1, schema_version: 1 })}\n`, "utf8");
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
    const platform = new DefaultCapabilityPlatform({
      builtinRoot,
      env: {},
      platform: process.platform,
      pluginLifecycle: lifecycle,
      userStateRoot: userRoot,
      workspace,
    });
    const createSessionWriter = vi.fn(createRuntime().createSessionWriter);
    const runtime = createRuntime({
      createCapabilityPlatform: () => platform,
      createPluginLifecycle: () => lifecycle,
      createSessionWriter,
      cwd: workspace,
    });
    const source = resolve("fixtures/capability-platform/m9-review-pack");

    const inspect = createMemoryIO();
    expect(await runCli(["plugins", "inspect", source, "--json"], inspect.io, runtime)).toBe(0);
    const digest = String(JSON.parse(inspect.readStdout()).pluginSha256);

    const install = createMemoryIO();
    expect(await runCli([
      "plugins",
      "install",
      source,
      "--expect-sha256",
      digest,
      "--json",
    ], install.io, runtime)).toBe(0);
    const selector = String(JSON.parse(install.readStdout()).exactSelector);

    const missingConfirmation = createMemoryIO();
    expect(await runCli(["plugins", "enable", selector, "--json"], missingConfirmation.io, runtime)).toBe(2);
    expect((await lifecycle.list())[0]?.enabled).toBe(false);

    const enabled = createMemoryIO();
    expect(await runCli(["plugins", "enable", selector, "--yes", "--json"], enabled.io, runtime)).toBe(0);
    expect(JSON.parse(enabled.readStdout())).toMatchObject({ afterRevision: 1, pendingNextRun: true });
    expect(enabled.readStderr()).toContain("grants no effects");

    const capabilities = createMemoryIO();
    expect(await runCli([
      "capabilities",
      "list",
      "--source",
      "user_install",
      "--json",
    ], capabilities.io, runtime)).toBe(0);
    expect(JSON.parse(capabilities.readStdout()).capabilities).toHaveLength(5);
    expect(createSessionWriter).not.toHaveBeenCalled();
  });
});
