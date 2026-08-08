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
  const requiredPhase17Assets = [
    "policies/repository-intelligence/assets-lock-v1.json",
    "policies/repository-intelligence/engine-v1.json",
    "evals/repository-intelligence/suite-v1.json",
  ];
  for (const relativePath of requiredPhase17Assets) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split("/")));
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 17 asset is empty: ${relativePath}`);
    }
  }
  const capabilityIndex = JSON.parse(
    await readFile(
      join(packageRoot, "capabilities", "builtin", "index.json"),
      "utf8",
    ),
  );
  if (
    capabilityIndex.schema_version !== 1 ||
    capabilityIndex.revision !== 1 ||
    !Array.isArray(capabilityIndex.packages) ||
    capabilityIndex.packages.length !== 0
  ) {
    throw new Error("packed Phase 18A built-in capability index is not exact");
  }
  const requiredPhase18ReviewPackAssets = [
    "fixtures/capability-platform/m9-review-pack/bornagent.plugin.json",
    "fixtures/capability-platform/m9-review-pack/hooks/protect-generated/hook.json",
    "fixtures/capability-platform/m9-review-pack/hooks/record-outcome/hook.json",
    "fixtures/capability-platform/m9-review-pack/hooks/record-outcome/observer.mjs",
    "fixtures/capability-platform/m9-review-pack/mcp/docs/server.json",
    "fixtures/capability-platform/m9-review-pack/mcp/docs/server.mjs",
    "fixtures/capability-platform/m9-review-pack/mcp/docs/resources/guide.md",
    "fixtures/capability-platform/m9-review-pack/skills/explain-evidence/skill.json",
    "fixtures/capability-platform/m9-review-pack/skills/explain-evidence/SKILL.md",
    "fixtures/capability-platform/m9-review-pack/skills/review-change/skill.json",
    "fixtures/capability-platform/m9-review-pack/skills/review-change/SKILL.md",
    "fixtures/capability-platform/m9-review-pack/skills/review-change/references/checklist.md",
  ];
  for (const relativePath of requiredPhase18ReviewPackAssets) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split("/")));
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 18 M9 review-pack asset is empty: ${relativePath}`);
    }
  }
  const repositoryEngine = JSON.parse(
    await readFile(
      join(packageRoot, "policies", "repository-intelligence", "engine-v1.json"),
      "utf8",
    ),
  );
  const repositoryAssets = JSON.parse(
    await readFile(
      join(
        packageRoot,
        "policies",
        "repository-intelligence",
        "assets-lock-v1.json",
      ),
      "utf8",
    ),
  );
  if (
    packedManifest.dependencies?.typescript !== "6.0.3" ||
    repositoryEngine.status !== "accepted" ||
    repositoryEngine.engineIdentity?.adapterVersion !==
      "bornagent-typescript-adapter-v2" ||
    repositoryEngine.engineIdentity?.engineVersion !== "6.0.3" ||
    repositoryEngine.engineIdentity?.identitySha256 !==
      "8a8ea1e72dcb01ddbb4385e634897306b2c16468ebd82213b986d8f6d83e0922" ||
    repositoryEngine.correctnessGatePassed !== true ||
    repositoryEngine.freshnessGatePassed !== true ||
    repositoryEngine.securityGatePassed !== true ||
    repositoryEngine.contextReductionGatePassed !== true ||
    repositoryAssets.networkRequired !== false ||
    repositoryAssets.repositoryConfigAllowed !== false ||
    repositoryAssets.repositoryPluginsAllowed !== false ||
    repositoryAssets.assets?.[0]?.name !== "typescript" ||
    repositoryAssets.assets?.[0]?.version !== "6.0.3"
  ) {
    throw new Error("packed Phase 17 engine decision/assets are not exact");
  }
  const repositorySuite = JSON.parse(
    await readFile(
      join(packageRoot, "evals", "repository-intelligence", "suite-v1.json"),
      "utf8",
    ),
  );
  const repositoryTaskRoot = join(
    packageRoot,
    "evals",
    "repository-intelligence",
    "tasks",
  );
  const repositoryTaskNames = (await readdir(repositoryTaskRoot)).sort();
  const repositoryCaseNames = (repositorySuite.cases ?? [])
    .map((item) => item.id)
    .sort();
  if (
    repositorySuite.id !== "repository-intelligence-v1" ||
    repositorySuite.suiteVersion !== 1 ||
    repositorySuite.smokeCaseIds?.length !== 8 ||
    repositoryCaseNames.length !== 20 ||
    JSON.stringify(repositoryTaskNames) !== JSON.stringify(repositoryCaseNames)
  ) {
    throw new Error("packed Phase 17 repository suite is incomplete");
  }
  for (const taskName of repositoryTaskNames) {
    await readFile(join(repositoryTaskRoot, taskName, "query.json"), "utf8");
    await readFile(
      join(repositoryTaskRoot, taskName, "grader", "expected.json"),
      "utf8",
    );
    if ((await readdir(join(repositoryTaskRoot, taskName, "workspace"))).length === 0) {
      throw new Error(`packed Phase 17 workspace is empty: ${taskName}`);
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

  const capabilityDoctor = spawnSync(
    process.execPath,
    [binaryPath, "capabilities", "doctor", "--json"],
    {
      cwd: installRoot,
      encoding: "utf8",
      env: {
        LOCALAPPDATA: join(temporaryRoot, "state"),
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        XDG_STATE_HOME: join(temporaryRoot, "state"),
      },
      shell: false,
    },
  );
  let capabilityDocument;
  try {
    capabilityDocument = JSON.parse(capabilityDoctor.stdout);
  } catch {
    capabilityDocument = null;
  }
  if (
    capabilityDoctor.status !== 0 ||
    capabilityDocument?.status !== "valid" ||
    capabilityDocument?.eligiblePluginCount !== 0 ||
    capabilityDocument?.componentCount !== 0 ||
    capabilityDocument?.sourceRevisions?.builtin !== 1
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} capabilities doctor --json failed`,
        capabilityDoctor.error?.message,
        capabilityDoctor.stdout,
        capabilityDoctor.stderr,
      ]
        .filter(Boolean)
      .join("\n"),
    );
  }

  const reviewPackRoot = join(
    packageRoot,
    "fixtures",
    "capability-platform",
    "m9-review-pack",
  );
  const pluginInspect = spawnSync(
    process.execPath,
    [binaryPath, "plugins", "inspect", reviewPackRoot, "--json"],
    {
      cwd: installRoot,
      encoding: "utf8",
      env: {
        LOCALAPPDATA: join(temporaryRoot, "state"),
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        XDG_STATE_HOME: join(temporaryRoot, "state"),
      },
      shell: false,
    },
  );
  let pluginDocument;
  try {
    pluginDocument = JSON.parse(pluginInspect.stdout);
  } catch {
    pluginDocument = null;
  }
  if (
    pluginInspect.status !== 0 ||
    pluginDocument?.status !== "valid_schema" ||
    pluginDocument?.pluginId !== "bornagent.m9-review-pack" ||
    pluginDocument?.pluginVersion !== "1.0.0" ||
    pluginDocument?.pluginSha256 !==
      "431500c152a4e6a654818b1fef513c4c5335133adcab1c00b90a4f90ec66c65d" ||
    pluginDocument?.sourceSnapshotSha256 !== pluginDocument?.pluginSha256 ||
    pluginDocument?.components?.length !== 5
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} plugins inspect M9 review pack --json failed`,
        pluginInspect.error?.message,
        pluginInspect.stdout,
        pluginInspect.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  process.stdout.write("pack smoke passed: extracted tarball loaded Phase 15 policy/Docker assets, the exact Phase 17 engine/corpus, the Phase 18A built-in capability index, and the exact Phase 18 M9 review pack; ran born --help, inspected the packed Plugin, and validated 20 bundled eval tasks without executing full eval\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
