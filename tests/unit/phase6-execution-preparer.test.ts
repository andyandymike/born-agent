import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionPreparer } from "../../src/execution/execution-preparer.js";
import {
  createDefaultExecutableRegistry,
  ExecutableRegistry,
} from "../../src/execution/executable-registry.js";
import {
  filterExecutionEnvironment,
  OFFLINE_NODE_GUARD_IDENTITY,
  OFFLINE_NODE_GUARD_SHA256,
} from "../../src/execution/environment-filter.js";
import { ExecutionPreparationError } from "../../src/execution/execution-types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase6-"));
  temporaryDirectories.push(workspace);
  await mkdir(join(workspace, "fixture"));
  await writeFile(
    join(workspace, "fixture", "print-args.mjs"),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    "utf8",
  );
  return workspace;
}

function registry(): ExecutableRegistry {
  return createDefaultExecutableRegistry({
    execPath: process.execPath,
    hostEnvironment: process.env,
    platform: process.platform,
    versionIdentities: { node: process.version },
  });
}

describe("Phase 6 execution preparation", () => {
  it("binds exact argv and reviewed script bytes, then reports stale input", async () => {
    const workspace = await createWorkspace();
    const preparer = await ExecutionPreparer.create({
      hostEnvironment: process.env,
      platform: process.platform,
      registry: registry(),
      workspace,
    });
    const prepared = await preparer.prepare({
      args: ["print-args.mjs", ";", "|", ">", "$()", "&"],
      cwd: "fixture",
      executable: "node",
      outputLimitBytes: 16_384,
      purpose: "inspect",
      timeoutMs: 1000,
    });

    expect(prepared.actionIdentity.argv).toEqual([
      "print-args.mjs",
      ";",
      "|",
      ">",
      "$()",
      "&",
    ]);
    expect(prepared.actionIdentity.canonicalCwd).toBe("fixture");
    expect(prepared.actionIdentity.actionSha256).toBe(prepared.actionSha256);
    expect(prepared.actionIdentity.executionInputsSha256).toBe(
      prepared.executionInputsSha256,
    );
    expect(
      prepared.actionIdentity.executionInputs.runnerConfigHashes.map(
        (entry) => entry.canonicalPath,
      ),
    ).toEqual([OFFLINE_NODE_GUARD_IDENTITY, "fixture/print-args.mjs"]);
    expect(
      prepared.actionIdentity.executionInputs.runnerConfigHashes.find(
        (entry) => entry.canonicalPath === OFFLINE_NODE_GUARD_IDENTITY,
      )?.sha256,
    ).toBe(OFFLINE_NODE_GUARD_SHA256);
    expect(await prepared.revalidate()).toBe("current");

    await writeFile(
      join(workspace, "fixture", "print-args.mjs"),
      'process.stdout.write("changed");\n',
      "utf8",
    );
    expect(await prepared.revalidate()).toBe("stale");
  });

  it("rejects absolute and escaping cwd values", async () => {
    const workspace = await createWorkspace();
    const preparer = await ExecutionPreparer.create({
      hostEnvironment: process.env,
      platform: process.platform,
      registry: registry(),
      workspace,
    });
    const base = {
      args: ["print-args.mjs"],
      executable: "node",
      outputLimitBytes: 16_384,
      purpose: "inspect" as const,
      timeoutMs: 1000,
    };

    await expect(
      preparer.prepare({ ...base, cwd: resolve(workspace, "fixture") }),
    ).rejects.toMatchObject({ code: "cwd_outside_workspace" });
    await expect(
      preparer.prepare({ ...base, cwd: relative(workspace, join(workspace, "..")) }),
    ).rejects.toMatchObject({ code: "cwd_outside_workspace" });
    await expect(
      preparer.prepare({ ...base, args: ["print-args.mjs", "../outside"], cwd: "fixture" }),
    ).rejects.toMatchObject({ code: "external_path_argument_denied" });
    await expect(
      preparer.prepare({ ...base, args: ["print-args.mjs", "file:///outside"], cwd: "fixture" }),
    ).rejects.toMatchObject({ code: "external_path_argument_denied" });
  });

  it("binds package lifecycle bodies, manifest, lockfile, and manager binary", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        scripts: {
          postverify: "node fixture/print-args.mjs post",
          preverify: "node fixture/print-args.mjs pre",
          verify: "node fixture/print-args.mjs verify",
        },
      }),
      "utf8",
    );
    await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const packageRegistry = new ExecutableRegistry({
      execPath: process.execPath,
      hostEnvironment: process.env,
      platform: process.platform,
      resolvedFiles: { pnpm: process.execPath },
      versionIdentities: { pnpm: "fixture-pnpm" },
    });
    const preparer = await ExecutionPreparer.create({
      hostEnvironment: process.env,
      platform: process.platform,
      registry: packageRegistry,
      workspace,
    });
    const prepared = await preparer.prepare({
      args: ["run", "verify"],
      cwd: null,
      executable: "pnpm",
      outputLimitBytes: 16_384,
      purpose: "verify",
      timeoutMs: 1000,
    });

    expect(prepared.actionIdentity.packageManager).toMatchObject({
      logicalName: "pnpm",
      version: "fixture-pnpm",
    });
    expect(prepared.actionIdentity.lifecycleScripts).toMatchObject({
      scriptName: "verify",
    });
    expect(prepared.actionIdentity.executionInputs.manifestSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(prepared.actionIdentity.executionInputs.lockfileSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(prepared.review.lifecycleScripts).toEqual([
      { body: "node fixture/print-args.mjs pre", name: "preverify" },
      { body: "node fixture/print-args.mjs verify", name: "verify" },
      { body: "node fixture/print-args.mjs post", name: "postverify" },
    ]);

    await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: changed\n", "utf8");
    expect(await prepared.revalidate()).toBe("stale");
  });

  it("starts child environment empty and excludes credentials and proxies", () => {
    const filtered = filterExecutionEnvironment({
      hostEnvironment: {
        ANTHROPIC_API_KEY: "paid-secret",
        GIT_ASKPASS: "credential-helper",
        HOME: "/safe/home",
        HTTPS_PROXY: "http://credential@proxy.invalid",
        OPENAI_API_KEY: "paid-secret",
        PATH: "/safe/bin",
        SERVICE_TOKEN: "secret",
      },
      platform: "linux",
    });

    expect(filtered.values).toMatchObject({
      CI: "1",
      COREPACK_ENABLE_NETWORK: "0",
      HOME: "/safe/home",
      NO_COLOR: "1",
      PATH: "/safe/bin",
    });
    expect(filtered.values.NODE_OPTIONS).toMatch(/^--import=data:text\/javascript,/u);
    expect(filtered.values.NODE_OPTIONS).not.toContain(" ");
    expect(Object.keys(filtered.values)).not.toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "GIT_ASKPASS",
        "HTTPS_PROXY",
        "OPENAI_API_KEY",
        "SERVICE_TOKEN",
      ]),
    );
  });
});

describe("Phase 6 executable registry", () => {
  it.each([
    ["node", ["-e", "console.log('no')"]],
    ["node", ["--require", "./unreviewed.cjs", "reviewed.mjs"]],
    ["git", ["push"]],
    ["git", ["commit", "-m", "no"]],
    ["git", ["-c", "alias.safe=!danger", "safe"]],
    ["npm", ["install"]],
    ["pnpm", ["publish"]],
    ["corepack", ["enable"]],
  ])("hard-denies %s %j", async (executable, args) => {
    await expect(registry().resolve(executable, args)).rejects.toBeInstanceOf(
      ExecutionPreparationError,
    );
  });

  it("denies unregistered interpreters and resolves injected node", async () => {
    await expect(registry().resolve("powershell", ["-Command", "x"])).rejects.toMatchObject(
      { code: "unknown_executable" },
    );
    const resolvedNode = await registry().resolve("node", ["--version"]);
    expect(resolvedNode.logicalName).toBe("node");
    expect(resolvedNode.bytesSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
