import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const cliPath = join(workspaceRoot, "dist", "cli.js");
const pnpmCliPath = process.env.npm_execpath;

if (!pnpmCliPath) {
  throw new Error("pack smoke must run from a pnpm script");
}

const cliSource = await readFile(cliPath, "utf8");
if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/cli.js is missing its node shebang");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-pack-smoke-"));
const installRoot = join(temporaryRoot, "install");

function runPnpm(args, cwd) {
  const result = spawnSync(process.execPath, [pnpmCliPath, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(
      [`pnpm ${args.join(" ")} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

try {
  runPnpm(["pack", "--pack-destination", temporaryRoot], workspaceRoot);
  const archiveName = (await readdir(temporaryRoot)).find((name) =>
    name.endsWith(".tgz"),
  );

  if (!archiveName) {
    throw new Error("pnpm pack did not create a tarball");
  }

  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "bornagent-pack-smoke", private: true })}\n`,
    "utf8",
  );

  // PHASE5: local_free_only smoke must never let a package-manager cache miss reach
  // a registry. Extract the local tarball and link already-installed dependencies.
  const packageRoot = join(installRoot, "node_modules", "bornagent");
  await mkdir(packageRoot, { recursive: true });
  const extraction = spawnSync(
    "tar",
    [
      "-xf",
      join(temporaryRoot, archiveName),
      "-C",
      packageRoot,
      "--strip-components=1",
    ],
    { encoding: "utf8", shell: false },
  );
  if (extraction.status !== 0) {
    throw new Error(
      ["local tarball extraction failed", extraction.stdout, extraction.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const packedManifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const requiredPhase15Assets = [
    "policies/local-free-v1.json",
    "policies/policy-schema-v1.json",
    "docker/artifacts/artifact-schema-v1.json",
    "docker/artifacts/bornagent-sandbox-node-v1.lock.json",
    "docker/artifacts/bornagent-sandbox-node-v1/Dockerfile",
    "docker/artifacts/bornagent-sandbox-node-v1/context-manifest.json",
    "docker/artifacts/bornagent-sandbox-node-v1/context/born-sandbox-exec",
  ];
  for (const relativePath of requiredPhase15Assets) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split("/")));
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 15 asset is empty: ${relativePath}`);
    }
  }
  for (const dependency of Object.keys(packedManifest.dependencies ?? {})) {
    const linkPath = join(installRoot, "node_modules", dependency);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(
      join(workspaceRoot, "node_modules", dependency),
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  const binEntry = packedManifest.bin?.born;
  if (typeof binEntry !== "string") {
    throw new Error("packed manifest is missing bin.born");
  }
  const binaryPath = join(packageRoot, binEntry);
  const result = spawnSync(process.execPath, [binaryPath, "--help"], {
    cwd: installRoot,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0 || !result.stdout.includes("Usage: born")) {
    throw new Error(
      [
        `${basename(binaryPath)} --help failed`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // PHASE15: execute from the extracted package so a source-checkout fallback
  // cannot hide a missing built-in policy or Docker artifact asset.
  const policyShow = spawnSync(
    process.execPath,
    [binaryPath, "policy", "show", "--json"],
    {
      cwd: installRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
      },
      shell: false,
    },
  );
  let policyDocument;
  try {
    policyDocument = JSON.parse(policyShow.stdout);
  } catch {
    policyDocument = null;
  }
  if (
    policyShow.status !== 0 ||
    policyDocument?.profile?.id !== "local-free-v1" ||
    policyDocument?.profile?.mode !== "local_free" ||
    policyDocument?.profile?.sha256 !==
      "424958376462d24fbe83e2c267ad50902b83b18f709e62a6a9e395b5ce8e89eb" ||
    policyDocument?.profile?.source !== "built_in" ||
    policyDocument?.modelAccess?.defaultProvider !== "ollama" ||
    policyDocument?.modelAccess?.defaultModel !== "qwen3:1.7b" ||
    policyDocument?.modelAccess?.credentialAccess !== "deny"
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} policy show --json failed`,
        policyShow.error?.message,
        policyShow.stdout,
        policyShow.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const evalList = spawnSync(process.execPath, [binaryPath, "eval", "list", "--json"], {
    cwd: installRoot,
    encoding: "utf8",
    shell: false,
  });
  let evalDocument;
  try {
    evalDocument = JSON.parse(evalList.stdout);
  } catch {
    evalDocument = null;
  }
  if (
    evalList.status !== 0 ||
    !Array.isArray(evalDocument?.tasks) ||
    evalDocument.tasks.length !== 20 ||
    evalDocument.fullSuiteExecution !== "not_run_by_policy"
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} eval list --json failed`,
        evalList.error?.message,
        evalList.stdout,
        evalList.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  process.stdout.write("pack smoke passed: extracted tarball loaded Phase 15 policy/Docker assets, ran born --help, and validated 20 bundled eval tasks without executing full eval\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
