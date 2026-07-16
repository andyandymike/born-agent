import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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

  runPnpm(
    [
      "add",
      join(temporaryRoot, archiveName),
      "--ignore-scripts",
      "--store-dir",
      join(workspaceRoot, ".cache", "pnpm-store"),
    ],
    installRoot,
  );

  const binaryName = process.platform === "win32" ? "born.cmd" : "born";
  const binaryPath = join(installRoot, "node_modules", ".bin", binaryName);
  const result = spawnSync(binaryPath, ["--help"], {
    cwd: installRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
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

  process.stdout.write("pack smoke passed: local tarball installed and born --help ran\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
