import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(import.meta.dirname, "..");
const cliPath = join(workspaceRoot, "dist", "cli.js");
const pnpmCliPath = process.env.npm_execpath;
const scriptArguments = process.argv.slice(2).filter((value) => value !== "--");
const repositoryCacheInstalledSmoke = scriptArguments.includes("--repository-cache-installed-smoke");

function installedSmokeOptions() {
  if (!repositoryCacheInstalledSmoke) {
    if (scriptArguments.length !== 0) throw new TypeError("pack smoke received unknown arguments");
    return null;
  }
  const positional = scriptArguments.filter(
    (value) => value !== "--repository-cache-installed-smoke" && value !== "--delete-cache-and-replay",
  );
  const values = new Map();
  for (let index = 0; index < positional.length; index += 2) {
    const key = positional[index];
    const value = positional[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new TypeError("repository cache installed smoke expects unique flag/value pairs");
    }
    values.set(key, value);
  }
  if (
    !scriptArguments.includes("--delete-cache-and-replay") ||
    values.get("--commands") !== "status,index,outline,symbol,references" ||
    typeof values.get("--report") !== "string" ||
    [...values.keys()].some((key) => key !== "--commands" && key !== "--report")
  ) {
    throw new TypeError("repository cache installed smoke requires the exact five commands, --delete-cache-and-replay, and --report");
  }
  const report = resolve(workspaceRoot, values.get("--report"));
  const difference = relative(workspaceRoot, report);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`) ||
      !difference.split(sep).join("/").startsWith(".bornagent/evals/repository-cache/")) {
    throw new TypeError("repository cache installed smoke report must remain below .bornagent/evals/repository-cache");
  }
  return Object.freeze({ report });
}

const installedOptions = installedSmokeOptions();

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

function runCommand(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env,
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${executable} ${args.join(" ")} failed`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  const m10FixtureRoot = join(
    packageRoot,
    "fixtures",
    "task-orchestration",
    "m10-durable-graph",
  );
  const requiredPhase19Assets = [
    "fixture.json",
    "graph.json",
    "expected/graph-projection.json",
    "expected/outcome-summary.json",
    "expected/promotion-manifest.json",
    "model-scripts/core-build-node.json",
    "model-scripts/inspect-node.json",
    "model-scripts/ui-build-node.json",
    "workers/crash-points.json",
    "repository-template/.gitattributes",
    "repository-template/AGENTS.md",
    "repository-template/filter-sentinel.txt",
    "repository-template/package.json",
    "repository-template/scripts/verify.mjs",
    "repository-template/src/core/clamp.mjs",
    "repository-template/src/ui/AGENTS.md",
    "repository-template/src/ui/format.mjs",
    "repository-template/tests/fixture.test.mjs",
  ];
  for (const relativePath of requiredPhase19Assets) {
    const bytes = await readFile(
      join(m10FixtureRoot, ...relativePath.split("/")),
    );
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 19 M10 fixture asset is empty: ${relativePath}`);
    }
  }
  const m10Fixture = JSON.parse(
    await readFile(join(m10FixtureRoot, "fixture.json"), "utf8"),
  );
  const m10GraphProjection = JSON.parse(
    await readFile(
      join(m10FixtureRoot, "expected", "graph-projection.json"),
      "utf8",
    ),
  );
  if (
    m10Fixture.id !== "m10-durable-graph-v1" ||
    m10Fixture.networkRequired !== false ||
    m10Fixture.remoteProvidersAllowed !== false ||
    m10Fixture.expectedGraphSha256 !== m10GraphProjection.graphSha256 ||
    m10GraphProjection.nodeOrder?.length !== 4
  ) {
    throw new Error("packed Phase 19 M10 fixture identity is not exact");
  }
  const internalWorkerBytes = await readFile(
    join(packageRoot, "dist", "commands", "internal-graph-worker.js"),
  );
  if (internalWorkerBytes.byteLength === 0) {
    throw new Error("packed Phase 19 internal Graph worker is empty");
  }
  const m11FixtureRoot = join(
    packageRoot,
    "fixtures",
    "controlled-subagents",
    "m11-canonical",
  );
  const requiredPhase20Assets = [
    "fixture.json",
    "delegation-template.json",
    "expected/outcome-summary.json",
    "workers/crash-points.json",
    "repository-template/gitignore.txt",
    "repository-template/README.md",
    "repository-template/src/fact.txt",
  ];
  for (const relativePath of requiredPhase20Assets) {
    const bytes = await readFile(
      join(m11FixtureRoot, ...relativePath.split("/")),
    );
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 20 M11 fixture asset is empty: ${relativePath}`);
    }
  }
  const m11Fixture = JSON.parse(
    await readFile(join(m11FixtureRoot, "fixture.json"), "utf8"),
  );
  if (
    m11Fixture.id !== "m11-controlled-subagents-v1" ||
    m11Fixture.delegationCount !== 2 ||
    m11Fixture.maximumConcurrentChildren !== 2 ||
    m11Fixture.networkRequired !== false ||
    m11Fixture.remoteProvidersAllowed !== false ||
    m11Fixture.model?.executionBackend !== "canonical_fake"
  ) {
    throw new Error("packed Phase 20 M11 fixture identity is not exact");
  }
  for (const relativePath of [
    "dist/commands/internal-delegation-child.js",
    "dist/delegation/runtime/canonical-fake-child-backend.js",
    "dist/delegation/runtime/canonical-phase20-fixture.js",
    "dist/delegation/runtime/child-session-shard.js",
  ]) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split("/")));
    if (bytes.byteLength === 0) {
      throw new Error(`packed Phase 20 runtime is empty: ${relativePath}`);
    }
  }
  const internalHookSupervisorBytes = await readFile(
    join(packageRoot, "dist", "commands", "internal-hook-command-supervisor.js"),
  );
  if (internalHookSupervisorBytes.byteLength === 0) {
    throw new Error("packed Phase 18 internal Hook supervisor is empty");
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

  // ML1: exercise the installed tarball's actual codec/store, close every
  // handle, reopen in a fresh store instance, then inspect it through the
  // packed CLI. CI runs this same path on Windows and Linux.
  const ml1RepositoryRoot = join(temporaryRoot, "ml1-repository");
  const ml1StateRoot = join(temporaryRoot, "ml1-state");
  await mkdir(ml1RepositoryRoot, { recursive: true });
  const [
    { sha256Canonical: packedSha256Canonical },
    { ControlArtifactStore: PackedControlArtifactStore },
    { loadOrCreateHostControlAuthority: loadPackedMl1Authority },
    { RepositoryRegistry: PackedRepositoryRegistry },
    { createMl1EpisodeRecordV1: createPackedMl1Episode },
    { SqliteEpisodeStore: PackedSqliteEpisodeStore },
  ] = await Promise.all([
    import(pathToFileURL(join(packageRoot, "dist", "completion", "canonical-json.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "control-artifact-store.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "host-control-identity.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "repository-registry.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "memory", "core", "ml1-episode-record.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "memory", "store", "sqlite-episode-store.js")).href),
  ]);
  const ml1Authority = await loadPackedMl1Authority({ root: ml1StateRoot });
  const ml1Repositories = new PackedRepositoryRegistry(
    new PackedControlArtifactStore(ml1Authority.paths, ml1Authority.integrityKey),
    ml1Authority.identity,
    ml1Authority.paths,
  );
  const ml1Registration = (await ml1Repositories.register({
    expectedHead: await ml1Repositories.head(),
    operationId: randomUUID(),
    root: ml1RepositoryRoot,
  })).registration;
  const ml1Scope = {
    applicationRepositoryId: ml1Registration.repositoryId,
    canonicalRootIdentitySha256: ml1Registration.canonicalRootIdentitySha256,
    ownerPrincipalId: ml1Authority.localOwner.principalId,
  };
  const ml1Source = {
    endEventId: "pack-probe-end",
    endRawSha256: "b".repeat(64),
    endSequence: 2,
    kind: "session_run_range",
    rangeSha256: "c".repeat(64),
    runId: "pack-probe-run",
    sessionId: "pack-probe-session",
    startEventId: "pack-probe-start",
    startRawSha256: "a".repeat(64),
    startSequence: 1,
  };
  const ml1Completion = {
    evidenceSha256: null,
    mode: "model_final",
    reportSha256: null,
    steps: 1,
    toolCalls: 0,
  };
  const ml1Task = "installed package SQLite reopen probe";
  const ml1Record = createPackedMl1Episode({
    completion: ml1Completion,
    kind: "episode",
    occurredAt: "2026-08-26T00:00:00.000Z",
    origin: "deterministic_episode",
    recordId: `episode_${packedSha256Canonical({ schema_version: 1, scope: ml1Scope, source: ml1Source })}`,
    schemaVersion: 1,
    scope: ml1Scope,
    source: ml1Source,
    taskInputSha256: sha256(ml1Task),
    taskPreview: ml1Task,
    text: [
      `Task: ${ml1Task}`,
      "Outcome: completed",
      "Completion mode: model_final",
      "Steps: 1",
      "Tool calls: 0",
      "Evidence: none",
    ].join("\n"),
  });
  const ml1FirstStore = await PackedSqliteEpisodeStore.create({ stateRoot: ml1StateRoot });
  const ml1Ingest = await ml1FirstStore.ingestEpisode(ml1Record);
  ml1FirstStore.close();
  const ml1SecondStore = await PackedSqliteEpisodeStore.create({ stateRoot: ml1StateRoot });
  const ml1Readback = await ml1SecondStore.getEpisode({ recordId: ml1Record.recordId, scope: ml1Scope });
  ml1SecondStore.close();
  if (ml1Ingest.status !== "inserted" || ml1Readback?.recordSha256 !== ml1Record.recordSha256) {
    throw new Error("installed ML1 SQLite close/reopen probe changed its logical episode");
  }
  const ml1Environment = { ...process.env, BORN_CONTROL_STATE_ROOT: ml1StateRoot };
  const ml1Status = JSON.parse(runCommand(
    process.execPath,
    [binaryPath, "memory", "status", "--json"],
    ml1RepositoryRoot,
    ml1Environment,
  ));
  const ml1Show = JSON.parse(runCommand(
    process.execPath,
    [binaryPath, "memory", "show", ml1Record.recordId, "--json"],
    ml1RepositoryRoot,
    ml1Environment,
  ));
  if (
    ml1Status.episodeCount !== 1 || ml1Status.logicalSha256 === undefined ||
    ml1Show.record?.recordSha256 !== ml1Record.recordSha256 || ml1Show.sourceStatus !== "stale"
  ) {
    throw new Error("installed ML1 memory CLI did not inspect the reopened logical episode");
  }

  // RIC4: exercise the real binary from the extracted tarball. This is kept in
  // the ordinary pack smoke too, so the release path cannot silently omit the
  // selected v2 cache implementation.
  const repositorySmokeRoot = join(temporaryRoot, "repository-cache-smoke");
  await mkdir(repositorySmokeRoot, { recursive: true });
  await writeFile(
    join(repositorySmokeRoot, "sample.ts"),
    "export function answer(): number { return 42; }\nexport const observed = answer();\n",
    "utf8",
  );
  const runRepositoryCommand = (args) => runCommand(process.execPath, [binaryPath, ...args], repositorySmokeRoot);
  const statusBefore = JSON.parse(runRepositoryCommand(["repo", "status", "--json"]));
  if (statusBefore.indexState !== "idle") throw new Error("installed repository cache status created or selected an unexpected index");
  const firstIndex = JSON.parse(runRepositoryCommand(["repo", "index", "--json"]));
  const firstOutlineSource = runRepositoryCommand(["repo", "query", "outline", "--max-depth", "2", "--limit", "100"]);
  const firstSymbolSource = runRepositoryCommand(["repo", "query", "symbol", "answer", "--limit", "20"]);
  const firstSymbols = JSON.parse(firstSymbolSource);
  const symbolId = firstSymbols.result?.[0]?.symbolId;
  if (typeof symbolId !== "string") throw new Error("installed repository symbol query did not return answer");
  const firstReferencesSource = runRepositoryCommand(["repo", "query", "references", symbolId, "--limit", "50"]);
  const cacheRoot = join(repositorySmokeRoot, ".bornagent", "cache", "repository-intelligence");
  const parentKey = await readFile(join(cacheRoot, "navigation-integrity.key"));
  const legacyKey = await readFile(join(cacheRoot, "v1", "navigation-integrity.key"));
  if (!parentKey.equals(legacyKey)) throw new Error("installed repository cache migration keys disagree");
  await rm(join(cacheRoot, "v2"), { force: true, recursive: true });
  const statusDeleted = JSON.parse(runRepositoryCommand(["repo", "status", "--json"]));
  if (statusDeleted.indexState !== "idle") throw new Error("installed repository cache delete did not remove the v2 index");
  const secondIndex = JSON.parse(runRepositoryCommand(["repo", "index", "--json"]));
  const secondOutlineSource = runRepositoryCommand(["repo", "query", "outline", "--max-depth", "2", "--limit", "100"]);
  const secondSymbolSource = runRepositoryCommand(["repo", "query", "symbol", "answer", "--limit", "20"]);
  const secondSymbols = JSON.parse(secondSymbolSource);
  const secondSymbolId = secondSymbols.result?.[0]?.symbolId;
  const secondReferencesSource = runRepositoryCommand(["repo", "query", "references", secondSymbolId, "--limit", "50"]);
  if (
    firstIndex.generationSha256 !== secondIndex.generationSha256 ||
    firstOutlineSource !== secondOutlineSource ||
    firstSymbolSource !== secondSymbolSource ||
    firstReferencesSource !== secondReferencesSource ||
    !(await readFile(join(cacheRoot, "navigation-integrity.key"))).equals(parentKey) ||
    !(await readFile(join(cacheRoot, "v1", "navigation-integrity.key"))).equals(legacyKey)
  ) {
    throw new Error("installed repository cache delete/rebuild changed its generation, query result, or key identity");
  }
  if (installedOptions !== null) {
    const body = {
      candidate: "production_v2",
      commandOutputSha256: {
        index: sha256(JSON.stringify({ first: firstIndex, second: secondIndex })),
        outline: sha256(firstOutlineSource),
        references: sha256(firstReferencesSource),
        status: sha256(JSON.stringify({ before: statusBefore, deleted: statusDeleted })),
        symbol: sha256(firstSymbolSource),
      },
      commands: ["status", "index", "outline", "symbol", "references"],
      deleteCacheAndReplay: true,
      generationSha256: firstIndex.generationSha256,
      schemaVersion: 1,
      status: "pass",
    };
    const report = { ...body, reportSha256: sha256(JSON.stringify(body)) };
    await mkdir(dirname(installedOptions.report), { recursive: true });
    const temporaryReport = `${installedOptions.report}.${String(process.pid)}.tmp`;
    await writeFile(temporaryReport, `${JSON.stringify(report)}\n`, "utf8");
    await rm(installedOptions.report, { force: true });
    await rename(temporaryReport, installedOptions.report);
    process.stdout.write(`${JSON.stringify({ path: relative(workspaceRoot, installedOptions.report).split(sep).join("/"), reportSha256: report.reportSha256, status: "pass" })}\n`);
  }

  const delegationHelp = spawnSync(
    process.execPath,
    [binaryPath, "delegations", "--help"],
    { cwd: installRoot, encoding: "utf8", shell: false },
  );
  if (
    delegationHelp.status !== 0 ||
    !delegationHelp.stdout.includes("start") ||
    !delegationHelp.stdout.includes("doctor") ||
    !delegationHelp.stdout.includes("receipt")
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} delegations --help failed`,
        delegationHelp.error?.message,
        delegationHelp.stdout,
        delegationHelp.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const packedGraphValidate = spawnSync(
    process.execPath,
    [
      binaryPath,
      "graph",
      "validate",
      "--file",
      "fixtures/task-orchestration/m10-durable-graph/graph.json",
      "--json",
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  let packedGraphDocument;
  try {
    packedGraphDocument = JSON.parse(packedGraphValidate.stdout);
  } catch {
    packedGraphDocument = null;
  }
  if (
    packedGraphValidate.status !== 0 ||
    packedGraphDocument?.command !== "graph.validate" ||
    packedGraphDocument?.result?.canonical !== true ||
    packedGraphDocument?.result?.graphSha256 !==
      m10Fixture.expectedGraphSha256 ||
    packedGraphDocument?.result?.nodeCount !== 4
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} graph validate M10 fixture --json failed`,
        packedGraphValidate.error?.message,
        packedGraphValidate.stdout,
        packedGraphValidate.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const m10RepositoryRoot = join(temporaryRoot, "m10-repository");
  await cp(
    join(m10FixtureRoot, "repository-template"),
    m10RepositoryRoot,
    { recursive: true },
  );
  const m10GitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: m10Fixture.fixedGit.authorDate,
    GIT_COMMITTER_DATE: m10Fixture.fixedGit.committerDate,
    GIT_CONFIG_NOSYSTEM: "1",
    LOCALAPPDATA: join(temporaryRoot, "state"),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    XDG_STATE_HOME: join(temporaryRoot, "state"),
  };
  runCommand("git", ["init", "--initial-branch=main"], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["config", "core.autocrlf", "false"], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["config", "commit.gpgsign", "false"], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["config", "user.name", m10Fixture.fixedGit.name], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["config", "user.email", m10Fixture.fixedGit.email], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["add", "--all"], m10RepositoryRoot, m10GitEnvironment);
  runCommand("git", ["commit", "--no-verify", "-m", "M10 canonical baseline"], m10RepositoryRoot, m10GitEnvironment);

  const m11RepositoryRoot = join(temporaryRoot, "m11-repository");
  await cp(
    join(m11FixtureRoot, "repository-template"),
    m11RepositoryRoot,
    { recursive: true },
  );
  await rename(
    join(m11RepositoryRoot, "gitignore.txt"),
    join(m11RepositoryRoot, ".gitignore"),
  );
  const m11StateRoot = join(temporaryRoot, "m11-state");
  const m11Environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-10T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-10T00:00:00Z",
    GIT_CONFIG_NOSYSTEM: "1",
    LOCALAPPDATA: m11StateRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    XDG_STATE_HOME: m11StateRoot,
  };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "BORN_BACKGROUND_WORKER",
    "BORN_DELEGATION_CHILD_STATE_ROOT",
    "BORN_MODEL",
    "BORN_OLLAMA_BASE_URL",
    "BORN_PROVIDER",
    "BORN_WORKER_STATE_ROOT",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OLLAMA_HOST",
    "OPENAI_API_KEY",
  ]) {
    delete m11Environment[key];
  }
  runCommand("git", ["init", "--initial-branch=main"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["config", "core.autocrlf", "false"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["config", "commit.gpgsign", "false"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["config", "user.name", "BornAgent M11 Fixture"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["config", "user.email", "m11-fixture@bornagent.local"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["add", "--all"], m11RepositoryRoot, m11Environment);
  runCommand("git", ["commit", "--no-verify", "-m", "M11 canonical baseline"], m11RepositoryRoot, m11Environment);
  const {
    createCanonicalPhase20CodingFixture,
    createCanonicalPhase20Fixture,
  } = await import(pathToFileURL(
    join(
      packageRoot,
      "dist",
      "delegation",
      "runtime",
      "canonical-phase20-fixture.js",
    ),
  ).href);
  const m11Prepared = await createCanonicalPhase20Fixture({
    count: 2,
    environment: m11Environment,
    platform: process.platform,
    workspace: m11RepositoryRoot,
  });
  if (
    m11Prepared.fixtureId !== m11Fixture.id ||
    m11Prepared.delegationIds.length !== 2 ||
    m11Prepared.networkRequired !== false ||
    m11Prepared.remoteProvidersAllowed !== false
  ) {
    throw new Error("packed Phase 20 fixture preparation is not exact");
  }
  const delegationStart = spawnSync(
    process.execPath,
    [
      binaryPath,
      "delegations",
      "start",
      "--session",
      m11Prepared.sessionId,
      "--delegation",
      m11Prepared.delegationIds[0],
      "--json",
    ],
    {
      cwd: m11RepositoryRoot,
      encoding: "utf8",
      env: m11Environment,
      shell: false,
      timeout: 90_000,
    },
  );
  let delegationStartDocument;
  try {
    delegationStartDocument = JSON.parse(delegationStart.stdout);
  } catch {
    delegationStartDocument = null;
  }
  if (
    delegationStart.status !== 0 ||
    delegationStartDocument?.command !== "delegations.start" ||
    delegationStartDocument?.result?.results?.length !== 2 ||
    delegationStartDocument?.result?.results?.some((item) => item.status !== "succeeded") ||
    delegationStartDocument?.result?.deferred?.length !== 0
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} delegations start M11 fixture --json failed`,
        delegationStart.error?.message,
        delegationStart.stdout,
        delegationStart.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  // PHASE21: prove that an installed CLI mutation closed through the Host-owned
  // application journal. Everything below is imported from the extracted
  // tarball; a source-checkout fallback cannot satisfy this evidence chain.
  const [
    { resolveControlStateRoot: resolvePackedControlStateRoot },
    { ControlStatePaths: PackedControlStatePaths },
    { ControlOperationJournal: PackedControlOperationJournal },
    { loadOrCreateHostControlAuthority: loadPackedHostControlAuthority },
    { SessionPathPolicy: PackedPhase21SessionPathPolicy },
  ] = await Promise.all([
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "control-state-root.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "control-state-paths.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "control-operation-journal.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "control-plane", "host-control-identity.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "sessions", "session-path-policy.js")).href),
  ]);
  const packedControlStateRoot = resolvePackedControlStateRoot({
    env: m11Environment,
    platform: process.platform,
  });
  const packedControlPaths = await PackedControlStatePaths.create(packedControlStateRoot);
  const packedControlJournal = new PackedControlOperationJournal(packedControlPaths);
  const packedControlOperations = await packedControlJournal.list();
  const packedDelegationOperations = packedControlOperations.filter((operation) =>
    operation.actionKind === "delegation.start" &&
    operation.target.kind === "existing_resource" &&
    operation.target.resourceScope.kind === "session" &&
    operation.target.resourceScope.sessionId === m11Prepared.sessionId
  );
  const packedDelegationOperation = packedDelegationOperations[0];
  const packedAuthority = await loadPackedHostControlAuthority({ root: packedControlStateRoot });
  const primary = packedDelegationOperation?.primaryDomainRecord;
  const packedSessionPaths = await (await PackedPhase21SessionPathPolicy.create(m11RepositoryRoot))
    .inspectExistingSession(m11Prepared.sessionId);
  const packedSessionText = await readFile(packedSessionPaths.sessionFilePath, "utf8");
  const packedSessionLines = packedSessionText.endsWith("\n")
    ? packedSessionText.slice(0, -1).split("\n")
    : [];
  const primaryRawLine = primary?.sequence === null || primary?.sequence === undefined
    ? undefined
    : packedSessionLines[primary.sequence - 1];
  let primaryRawEvent;
  try {
    primaryRawEvent = primaryRawLine === undefined ? null : JSON.parse(primaryRawLine);
  } catch {
    primaryRawEvent = null;
  }
  const authenticatedOrigin = primaryRawEvent?.data?.origin;
  const applicationCommit = authenticatedOrigin?.application_commit;
  if (
    packedDelegationOperations.length !== 1 ||
    packedDelegationOperation?.state !== "completed" ||
    packedDelegationOperation.ownerClaim !== null ||
    packedDelegationOperation.resultArtifact === null ||
    packedDelegationOperation.resolvedResourceScope?.kind !== "session" ||
    packedDelegationOperation.resolvedResourceScope.sessionId !== m11Prepared.sessionId ||
    primary?.ownerKind !== "session" ||
    primary.ledgerId !== `session:${m11Prepared.sessionId}` ||
    primaryRawLine === undefined ||
    sha256(primaryRawLine) !== primary.recordSha256 ||
    primaryRawEvent?.event_id !== primary.recordId ||
    primaryRawEvent?.session_id !== m11Prepared.sessionId ||
    primaryRawEvent?.session_seq !== primary.sequence ||
    !packedDelegationOperation.domainRecordRefs.some((reference) =>
      reference.recordId === primary.recordId &&
      reference.recordSha256 === primary.recordSha256
    ) ||
    packedAuthority.localOwner.kind !== "human" ||
    packedAuthority.localOwner.principalId !== "local_owner" ||
    !packedAuthority.localOwnerScopes.includes("session.mutate") ||
    authenticatedOrigin?.kind !== "authenticated_surface" ||
    authenticatedOrigin.authentication_id !== packedAuthority.localOwner.authenticationId ||
    authenticatedOrigin.surface !== "cli" ||
    applicationCommit?.schema_version !== 1 ||
    applicationCommit.operation_id !== packedDelegationOperation.operationId ||
    applicationCommit.action_kind !== "delegation.start" ||
    applicationCommit.principal_id !== packedAuthority.localOwner.principalId ||
    applicationCommit.prepared_action_sha256 !== packedDelegationOperation.preparedActionSha256
  ) {
    throw new Error(`packed Phase 21A application evidence is incomplete: ${JSON.stringify({
      actionKind: packedDelegationOperation?.actionKind,
      authenticatedOrigin,
      operationCount: packedDelegationOperations.length,
      operationId: packedDelegationOperation?.operationId,
      primary,
      primaryRawSha256: primaryRawLine === undefined ? null : sha256(primaryRawLine),
      principalId: packedAuthority.localOwner.principalId,
      state: packedDelegationOperation?.state,
    })}`);
  }
  const { SessionCatalog: PackedSessionCatalog } = await import(pathToFileURL(
    join(packageRoot, "dist", "sessions", "session-catalog.js"),
  ).href);
  const m11Session = await new PackedSessionCatalog(m11RepositoryRoot).read(
    m11Prepared.sessionId,
  );
  const m11Projection = m11Session.delegations;
  const m11Barrier = m11Projection.barriers.at(-1);
  if (
    m11Projection.trackingMode !== "phase20" ||
    m11Projection.revisions.length !== 2 ||
    m11Projection.revisions.some((revision) =>
      revision.status !== "accepted" ||
      revision.receipt?.status !== "succeeded" ||
      revision.receipt.claimStatuses.some((claim) => claim.status !== "verified")) ||
    m11Projection.maximumObservedActiveChildren !== 2 ||
    m11Projection.activeActorSlots.length !== 0 ||
    m11Projection.activeConflictClaims.length !== 0 ||
    m11Projection.waitingApprovals.length !== 0 ||
    m11Barrier?.status !== "released" ||
    m11Barrier.terminalStatus !== "completed" ||
    m11Barrier.receiptSha256s.length !== 2 ||
    m11Session.runs.filter((run) =>
      run.started.data.delegated_child_binding !== undefined &&
      run.status === "completed").length !== 2
  ) {
    throw new Error("packed Phase 20 M11 terminal projection is incomplete");
  }
  const delegationDoctor = spawnSync(
    process.execPath,
    [binaryPath, "delegations", "doctor", "--session", m11Prepared.sessionId, "--json"],
    {
      cwd: m11RepositoryRoot,
      encoding: "utf8",
      env: m11Environment,
      shell: false,
      timeout: 30_000,
    },
  );
  let delegationDoctorDocument;
  try {
    delegationDoctorDocument = JSON.parse(delegationDoctor.stdout);
  } catch {
    delegationDoctorDocument = null;
  }
  if (
    delegationDoctor.status !== 0 ||
    delegationDoctorDocument?.command !== "delegations.doctor" ||
    delegationDoctorDocument?.result?.valid !== true ||
    delegationDoctorDocument?.result?.operations?.length !== 2 ||
    delegationDoctorDocument?.result?.operations?.some((item) => item.state !== "reconciled")
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} delegations doctor M11 fixture --json failed`,
        delegationDoctor.error?.message,
        delegationDoctor.stdout,
        delegationDoctor.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const backgroundGraphFile = "phase20-background-graph.json";
  await writeFile(
    join(m11RepositoryRoot, ".git", "info", "exclude"),
    `${backgroundGraphFile}\n`,
    "utf8",
  );
  const m11BackgroundStateRoot = join(temporaryRoot, "m11-background-state");
  const m11BackgroundEnvironment = {
    ...m11Environment,
    LOCALAPPDATA: m11BackgroundStateRoot,
    XDG_STATE_HOME: m11BackgroundStateRoot,
  };
  const backgroundFixture = await createCanonicalPhase20Fixture({
    count: 0,
    environment: m11BackgroundEnvironment,
    platform: process.platform,
    workspace: m11RepositoryRoot,
  });
  let backgroundSession = await new PackedSessionCatalog(m11RepositoryRoot).read(
    backgroundFixture.sessionId,
  );
  const backgroundGoal = backgroundSession.taskState.goals.at(-1);
  const backgroundPlan = backgroundSession.taskState.plans.at(-1);
  if (backgroundGoal === undefined || backgroundPlan === undefined) {
    throw new Error("packed Phase 20 background fixture has no exact Goal/Plan binding");
  }
  const backgroundBudget = {
    maxArtifactBytes: 512 * 1024,
    maxAttempts: 2,
    maxChangedBytes: 32 * 1024,
    maxChangedFiles: 4,
    maxCommandExecutions: 2,
    maxCommandOutputBytes: 256 * 1024,
    maxDurationMs: 240_000,
    maxModelSteps: 8,
    maxReportedTokens: 4096,
  };
  const backgroundGraphPath = join(m11RepositoryRoot, backgroundGraphFile);
  const backgroundGraphId = randomUUID();
  await writeFile(backgroundGraphPath, JSON.stringify({
    binding: {
      goalId: backgroundGoal.content.goalId,
      goalRevision: backgroundGoal.content.revision,
      planId: backgroundPlan.content.planId,
      planRevision: backgroundPlan.content.revision,
      planSha256: backgroundPlan.planSha256,
      sessionId: backgroundFixture.sessionId,
    },
    graphBudget: backgroundBudget,
    graphId: backgroundGraphId,
    nodes: [{
      agent: { mode: "plan", taskProfile: "read-only" },
      budget: backgroundBudget,
      dependsOn: [],
      kind: "agent",
      nodeId: "inspect",
      objective: "Coordinate two packed background read-only children.",
      planItemIds: ["verify-controlled-subagent-contract"],
      requiredCapabilities: [
        `workspace:phase20-background-readonly@1.0.0/skill/gate#sha256:${"0".repeat(64)}`,
      ],
      retry: { automaticOn: [], maxAttempts: 1 },
      sequence: 1,
      title: "Packed worker controlled delegation",
      workspace: { declaredPathPrefixes: ["src"], mode: "origin_read_only" },
    }],
    schemaVersion: 1,
    title: "Packed Phase 20 background worker fixture",
  }), "utf8");
  const backgroundGraphReplace = spawnSync(
    process.execPath,
    [binaryPath, "graph", "replace", backgroundFixture.sessionId, "--file", backgroundGraphFile, "--json"],
    { cwd: m11RepositoryRoot, encoding: "utf8", env: m11BackgroundEnvironment, shell: false },
  );
  if (backgroundGraphReplace.status !== 0) {
    throw new Error([
      `${basename(binaryPath)} graph replace packed Phase 20 background fixture failed`,
      backgroundGraphReplace.error?.message,
      backgroundGraphReplace.stdout,
      backgroundGraphReplace.stderr,
    ].filter(Boolean).join("\n"));
  }
  backgroundSession = await new PackedSessionCatalog(m11RepositoryRoot).read(
    backgroundFixture.sessionId,
  );
  const backgroundGraph = backgroundSession.taskGraph.currentDraft;
  if (backgroundGraph === null) {
    throw new Error("packed Phase 20 background Graph draft identity is missing");
  }
  const backgroundGraphApprove = spawnSync(
    process.execPath,
    [
      binaryPath,
      "graph",
      "approve",
      backgroundFixture.sessionId,
      "--revision",
      String(backgroundGraph.revision),
      "--sha256",
      backgroundGraph.graphSha256,
      "--json",
    ],
    { cwd: m11RepositoryRoot, encoding: "utf8", env: m11BackgroundEnvironment, shell: false },
  );
  if (backgroundGraphApprove.status !== 0) {
    throw new Error([
      `${basename(binaryPath)} graph approve packed Phase 20 background fixture failed`,
      backgroundGraphApprove.error?.message,
      backgroundGraphApprove.stdout,
      backgroundGraphApprove.stderr,
    ].filter(Boolean).join("\n"));
  }
  const backgroundDelegationIds = [];
  for (const sequence of [1, 2]) {
    const prepared = await createCanonicalPhase20CodingFixture({
      graphId: backgroundGraph.graphId,
      graphRevision: backgroundGraph.revision,
      graphSha256: backgroundGraph.graphSha256,
      goalId: backgroundGoal.content.goalId,
      goalObjective: backgroundGoal.content.objective,
      goalRevision: backgroundGoal.content.revision,
      managedWorkspaceBaselineSha256: backgroundGraph.graphSha256,
      managedWorkspaceId: randomUUID(),
      nodeId: "inspect",
      planId: backgroundPlan.content.planId,
      planRevision: backgroundPlan.content.revision,
      planSha256: backgroundPlan.planSha256,
      sequence,
      sessionId: backgroundFixture.sessionId,
      taskProfile: "read-only",
      workspace: m11RepositoryRoot,
    });
    backgroundDelegationIds.push(prepared.delegationId);
  }
  const backgroundGraphEnqueue = spawnSync(
    process.execPath,
    [
      binaryPath,
      "graph",
      "enqueue",
      backgroundFixture.sessionId,
      "--revision",
      String(backgroundGraph.revision),
      "--sha256",
      backgroundGraph.graphSha256,
      "--runtime-profile",
      "local-free",
      "--background",
      "--json",
    ],
    { cwd: m11RepositoryRoot, encoding: "utf8", env: m11BackgroundEnvironment, shell: false },
  );
  if (backgroundGraphEnqueue.status !== 0) {
    throw new Error([
      `${basename(binaryPath)} graph enqueue packed Phase 20 background fixture failed`,
      backgroundGraphEnqueue.error?.message,
      backgroundGraphEnqueue.stdout,
      backgroundGraphEnqueue.stderr,
    ].filter(Boolean).join("\n"));
  }
  const backgroundGraphRun = spawnSync(
    process.execPath,
    [binaryPath, "graph", "run", backgroundFixture.sessionId, "--background", "--json"],
    {
      cwd: m11RepositoryRoot,
      encoding: "utf8",
      env: m11BackgroundEnvironment,
      shell: false,
      timeout: 45_000,
    },
  );
  if (backgroundGraphRun.status !== 0) {
    throw new Error([
      `${basename(binaryPath)} graph run packed Phase 20 background fixture failed`,
      backgroundGraphRun.error?.message,
      backgroundGraphRun.stdout,
      backgroundGraphRun.stderr,
    ].filter(Boolean).join("\n"));
  }
  let backgroundGraphRunDocument;
  try {
    backgroundGraphRunDocument = JSON.parse(backgroundGraphRun.stdout);
  } catch {
    backgroundGraphRunDocument = null;
  }
  const backgroundOperationId = backgroundGraphRunDocument?.result?.operationId;
  const backgroundWorkerId = backgroundGraphRunDocument?.result?.workerId;
  if (typeof backgroundOperationId !== "string" || typeof backgroundWorkerId !== "string") {
    throw new Error("packed Phase 20 background worker launch receipt is invalid");
  }
  const {
    BackgroundOperationStore: PackedBackgroundOperationStore,
    resolveWorkerUserStateRoot: resolvePackedWorkerUserStateRoot,
  } = await import(pathToFileURL(
    join(packageRoot, "dist", "background", "background-operation-store.js"),
  ).href);
  const packedBackgroundOperationStore = await PackedBackgroundOperationStore.openExisting({
    operationId: backgroundOperationId,
    repositoryId: backgroundFixture.repositoryId,
    root: resolvePackedWorkerUserStateRoot({
      env: m11BackgroundEnvironment,
      platform: process.platform,
    }),
  });
  const { reconstructMultiRunSession: reconstructPackedSession } = await import(pathToFileURL(
    join(packageRoot, "dist", "sessions", "reconstruct-multi-run-session.js"),
  ).href);
  const { readStoredSession: readPackedStoredSession } = await import(pathToFileURL(
    join(packageRoot, "dist", "sessions", "read-stored-session.js"),
  ).href);
  const { SessionPathPolicy: PackedSessionPathPolicy } = await import(pathToFileURL(
    join(packageRoot, "dist", "sessions", "session-path-policy.js"),
  ).href);
  const backgroundPaths = await (
    await PackedSessionPathPolicy.create(m11RepositoryRoot)
  ).inspectExistingSession(backgroundFixture.sessionId);
  let packedBackgroundTerminal = null;
  let lastPackedBackgroundObservation = null;
  for (let observation = 0; observation < 900; observation += 1) {
    const observed = reconstructPackedSession(
      await readPackedStoredSession(backgroundPaths.sessionFilePath),
    );
    const revisions = backgroundDelegationIds.map((delegationId) =>
      observed.delegations.revisions.find((candidate) => candidate.delegationId === delegationId));
    let sessionLock = null;
    try {
      sessionLock = (await readFile(backgroundPaths.lockFilePath, "utf8")).trim();
    } catch {
      sessionLock = null;
    }
    const heartbeat = await packedBackgroundOperationStore.readHeartbeat();
    lastPackedBackgroundObservation = {
      activeActorSlots: observed.delegations.activeActorSlots.length,
      activeConflictClaims: observed.delegations.activeConflictClaims.length,
      background: observed.background.current?.status ?? null,
      delegations: revisions.map((revision) => ({
        binding: revision === undefined ? null : {
          graphId: revision.binding.graphId,
          graphRevision: revision.binding.graphRevision,
          graphSha256: revision.binding.graphSha256,
        },
        envelope: revision?.envelope?.envelopeSha256 ?? null,
        profile: revision?.content.authorityRequest.taskProfile ?? null,
        receipt: revision?.receipt?.status ?? null,
        status: revision?.status ?? null,
      })),
      graph: observed.taskExecution === null ? null : {
        graphId: observed.taskExecution.graph.graphId,
        graphRevision: observed.taskExecution.graph.revision,
        graphSha256: observed.taskExecution.graph.graphSha256,
        status: observed.taskExecution.status,
      },
      maximumObservedActiveChildren: observed.delegations.maximumObservedActiveChildren,
      heartbeat: heartbeat === null ? null : {
        lastDurableSessionSeq: heartbeat.lastDurableSessionSeq,
        sequence: heartbeat.sequence,
        workerPid: heartbeat.workerPid,
      },
      packSmokePid: process.pid,
      sessionLock,
      startedChildren: observed.events.filter((event) =>
        event.scope === "session" && event.type === "delegation.child.started").length,
      worker: observed.background.workers.at(-1)?.status ?? null,
    };
    if (
      observed.background.current === null &&
      revisions.every((revision) =>
        revision?.status === "accepted" && revision.receipt?.status === "succeeded")
    ) {
      packedBackgroundTerminal = await new PackedSessionCatalog(m11RepositoryRoot).read(
        backgroundFixture.sessionId,
      );
      break;
    }
    if (observed.background.current?.status === "reconciliation_required") {
      // Preserve the first durable reconciliation terminal and let the shared
      // failure block below report the operation journal, handoff, receipt,
      // worker liveness, and exact projected resources together.
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (
    packedBackgroundTerminal === null ||
    packedBackgroundTerminal.delegations.maximumObservedActiveChildren !== 2 ||
    packedBackgroundTerminal.delegations.activeActorSlots.length !== 0 ||
    packedBackgroundTerminal.delegations.activeConflictClaims.length !== 0 ||
    packedBackgroundTerminal.events.filter((event) =>
      event.scope === "session" && event.type === "delegation.child.started").length !== 2 ||
    packedBackgroundTerminal.background.workers.at(-1)?.status !== "terminal"
  ) {
    const failureDiagnostic = await packedBackgroundOperationStore.readFailureDiagnostic(
      backgroundWorkerId,
    );
    const handoff = await packedBackgroundOperationStore.readHandoff();
    const terminalReceipt = await packedBackgroundOperationStore.readTerminalReceipt(
      backgroundWorkerId,
    );
    const failedWorkerPid = lastPackedBackgroundObservation?.heartbeat?.workerPid;
    let workerAlive = null;
    if (Number.isSafeInteger(failedWorkerPid) && failedWorkerPid > 0) {
      try {
        process.kill(failedWorkerPid, 0);
        workerAlive = true;
      } catch (error) {
        if (error?.code === "ESRCH") workerAlive = false;
      }
    }
    throw new Error(`packed Phase 19 worker did not close two packed Phase 20 children: ${JSON.stringify({
      failureDiagnostic,
      handoff,
      lastObservation: lastPackedBackgroundObservation,
      lockedTerminal: packedBackgroundTerminal === null ? null : {
        activeActorSlots: packedBackgroundTerminal.delegations.activeActorSlots.length,
        activeConflictClaims: packedBackgroundTerminal.delegations.activeConflictClaims.length,
        maximumObservedActiveChildren: packedBackgroundTerminal.delegations.maximumObservedActiveChildren,
        startedChildren: packedBackgroundTerminal.events.filter((event) =>
          event.scope === "session" && event.type === "delegation.child.started").length,
        worker: packedBackgroundTerminal.background.workers.at(-1)?.status ?? null,
      },
      terminalReceipt,
      workerAlive,
    })}`);
  }
  const terminalWorkerPid = lastPackedBackgroundObservation?.heartbeat?.workerPid;
  if (!Number.isSafeInteger(terminalWorkerPid) || terminalWorkerPid <= 0) {
    throw new Error("packed Phase 19 worker terminal observation has no valid worker PID");
  }
  let terminalWorkerExited = false;
  let terminalHandoff = await packedBackgroundOperationStore.readHandoff();
  for (let observation = 0; observation < 200; observation += 1) {
    terminalHandoff = await packedBackgroundOperationStore.readHandoff();
    try {
      process.kill(terminalWorkerPid, 0);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      terminalWorkerExited = true;
    }
    if (terminalWorkerExited && terminalHandoff?.state === "terminal") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!terminalWorkerExited || terminalHandoff?.state !== "terminal") {
    throw new Error(`packed Phase 19 worker left an incomplete OS lifecycle: ${JSON.stringify({
      handoff: terminalHandoff,
      terminalWorkerExited,
      terminalWorkerPid,
    })}`);
  }

  const graphDoctor = spawnSync(
    process.execPath,
    [binaryPath, "graph", "doctor", "--json"],
    {
      cwd: m10RepositoryRoot,
      encoding: "utf8",
      env: m10GitEnvironment,
      shell: false,
    },
  );
  let graphDoctorDocument;
  try {
    graphDoctorDocument = JSON.parse(graphDoctor.stdout);
  } catch {
    graphDoctorDocument = null;
  }
  if (
    graphDoctor.status !== 0 ||
    graphDoctorDocument?.command !== "graph.doctor" ||
    graphDoctorDocument?.result?.valid !== true ||
    graphDoctorDocument?.result?.foreground?.deterministicSingleActive !== true ||
    graphDoctorDocument?.result?.worktrees?.managed !== true ||
    graphDoctorDocument?.result?.worktrees?.promotion !== true ||
    graphDoctorDocument?.result?.background?.valid !== true
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} graph doctor --json failed`,
        graphDoctor.error?.message,
        graphDoctor.stdout,
        graphDoctor.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const graphWorkerDoctor = spawnSync(
    process.execPath,
    [binaryPath, "graph", "worker", "doctor", "--json"],
    {
      cwd: m10RepositoryRoot,
      encoding: "utf8",
      env: m10GitEnvironment,
      shell: false,
    },
  );
  let graphWorkerDoctorDocument;
  try {
    graphWorkerDoctorDocument = JSON.parse(graphWorkerDoctor.stdout);
  } catch {
    graphWorkerDoctorDocument = null;
  }
  if (
    graphWorkerDoctor.status !== 0 ||
    graphWorkerDoctorDocument?.command !== "graph.worker.doctor" ||
    graphWorkerDoctorDocument?.result?.valid !== true ||
    graphWorkerDoctorDocument?.result?.descriptor?.workerProtocolVersion !== 1 ||
    graphWorkerDoctorDocument?.result?.descriptor?.packageName !== "bornagent"
  ) {
    throw new Error(
      [
        `${basename(binaryPath)} graph worker doctor --json failed`,
        graphWorkerDoctor.error?.message,
        graphWorkerDoctor.stdout,
        graphWorkerDoctor.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const hookStateBase = join(temporaryRoot, "hook-state");
  const capabilityStateRoot = process.platform === "win32"
    ? join(hookStateBase, "BornAgent", "capabilities")
    : join(hookStateBase, "bornagent", "capabilities");
  const hookOperationRoot = join(capabilityStateRoot, "hooks", "operations", "v1");
  const hookScriptPath = join(temporaryRoot, "packed-hook.mjs");
  const hookScript = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection',evidence:['packed-supervisor:captured']})));\n";
  await writeFile(hookScriptPath, hookScript, "utf8");
  const hookInput = Buffer.from('{"event":"pack-smoke"}', "utf8");
  const hookRawNonce = "a".repeat(43);
  const hookSessionId = randomUUID();
  const hookRunId = randomUUID();
  const hookInvocationId = randomUUID();
  const hookActionSha256 = "1".repeat(64);
  const hookIdentitySha256 = "2".repeat(64);
  const { HookCommandOperationStore } = await import(pathToFileURL(
    join(packageRoot, "dist", "hooks", "hook-command-operation-store.js"),
  ).href);
  const hookStore = await HookCommandOperationStore.create({
    invocationId: hookInvocationId,
    root: hookOperationRoot,
    runId: hookRunId,
    sessionId: hookSessionId,
  });
  await hookStore.createRequested({
    actionSha256: hookActionSha256,
    createdAt: new Date().toISOString(),
    failurePolicy: "fail_closed",
    hookIdentitySha256,
    inputSha256: sha256(hookInput),
    invocationId: hookInvocationId,
    mode: "gate",
    nonceSha256: sha256(hookRawNonce),
    requestedEventId: randomUUID(),
    runId: hookRunId,
    schemaVersion: 1,
    sessionId: hookSessionId,
    sessionLockNonceSha256: "9".repeat(64),
    state: "requested",
    terminalEventId: randomUUID(),
  });
  const hookBootstrap = {
    actionSha256: hookActionSha256,
    argv: [],
    cwd: temporaryRoot,
    environment: {
      BORN_HOOK_DEPTH: "1",
      BORN_HOOK_PROTOCOL: "1",
      BORN_HOOK_SUPPRESSED: "1",
    },
    executablePath: process.execPath,
    executableSha256: sha256(await readFile(process.execPath)),
    hookIdentitySha256,
    inputBase64: hookInput.toString("base64"),
    inputSha256: sha256(hookInput),
    invocationId: hookInvocationId,
    mode: "gate",
    protocolVersion: 1,
    rawNonce: hookRawNonce,
    scriptPath: hookScriptPath,
    scriptSha256: sha256(hookScript),
    secrets: ["pack-smoke-secret-sentinel"],
    timeoutMs: 5_000,
  };
  const hookSupervisorEnvironment = {
    BORN_HOOK_SUPERVISOR: "1",
    LOCALAPPDATA: hookStateBase,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    XDG_STATE_HOME: hookStateBase,
  };
  for (const key of Object.keys(hookSupervisorEnvironment)) {
    if (hookSupervisorEnvironment[key] === undefined) delete hookSupervisorEnvironment[key];
  }
  const hookSupervisor = spawn(process.execPath, [
    binaryPath,
    "internal",
    "hook-command-supervisor",
    "--session",
    hookSessionId,
    "--run",
    hookRunId,
    "--invocation",
    hookInvocationId,
  ], {
    cwd: packageRoot,
    env: hookSupervisorEnvironment,
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let hookSupervisorStderr = "";
  hookSupervisor.stderr.on("data", (chunk) => {
    hookSupervisorStderr += chunk.toString("utf8");
  });
  const hookReceipts = [];
  const capturedReceipt = new Promise((resolveReceipt, rejectReceipt) => {
    const timer = setTimeout(() => {
      if (hookSupervisor.connected) hookSupervisor.disconnect();
      rejectReceipt(new Error("packed Hook supervisor capture timed out"));
    }, 15_000);
    hookSupervisor.on("message", (message) => {
      hookReceipts.push(message);
      if (message?.kind !== "captured") return;
      clearTimeout(timer);
      resolveReceipt(message);
    });
    hookSupervisor.once("error", (error) => {
      clearTimeout(timer);
      rejectReceipt(error);
    });
    hookSupervisor.once("exit", (exitCode, signal) => {
      if (hookReceipts.some((message) => message?.kind === "captured")) return;
      clearTimeout(timer);
      rejectReceipt(new Error(`packed Hook supervisor exited before capture (${String(exitCode)}/${String(signal)})`));
    });
  });
  await new Promise((resolveSend, rejectSend) => {
    hookSupervisor.send(hookBootstrap, (error) => {
      if (error == null) resolveSend();
      else rejectSend(error);
    });
  });
  await capturedReceipt;
  const hookSupervisorExit = await new Promise((resolveExit, rejectExit) => {
    if (hookSupervisor.exitCode !== null || hookSupervisor.signalCode !== null) {
      resolveExit({ exitCode: hookSupervisor.exitCode, signal: hookSupervisor.signalCode });
      return;
    }
    const timer = setTimeout(() => rejectExit(new Error("packed Hook supervisor did not exit")), 15_000);
    hookSupervisor.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolveExit({ exitCode, signal });
    });
  });
  const packedHookRecord = await hookStore.read();
  if (
    hookSupervisorExit.exitCode !== 0 ||
    hookSupervisorExit.signal !== null ||
    hookSupervisorStderr.length !== 0 ||
    hookReceipts.map((message) => message?.kind).join(",") !== "started,captured" ||
    packedHookRecord?.state !== "captured" ||
    packedHookRecord.capture?.kind !== "gate" ||
    packedHookRecord.capture?.decision !== "no_objection" ||
    JSON.stringify(packedHookRecord).includes("pack-smoke-secret-sentinel")
  ) {
    throw new Error([
      "packed internal Hook supervisor did not produce one redacted durable capture",
      hookSupervisorStderr,
      JSON.stringify(hookReceipts),
      JSON.stringify(packedHookRecord),
    ].filter(Boolean).join("\n"));
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

  process.stdout.write("pack smoke passed: extracted tarball loaded Phase 15 policy/Docker assets, the exact Phase 17 engine/corpus, the Phase 18A built-in capability index, the exact Phase 18 M9 review pack, the Phase 19 M10 canonical Graph fixture, and the Phase 20 M11 controlled-subagent fixture; passed the installed ML1 SQLite close/reopen and memory status/show probe, ran born/delegations help and the installed repository-cache five-command delete/rebuild replay, executed the packed Hook supervisor, validated the packed Graph hash, passed Graph/worker doctor, launched two foreground and two Phase19-worker-owned offline real delegated child processes through sealed handshakes and isolated session shards, accepted four verified receipts, released every parent barrier and actor/conflict claim, verified the installed Phase 21A delegation mutation against its completed Host journal operation, local principal, authenticated application origin, and primary raw-line SHA-256, inspected the packed Plugin, and validated 20 bundled eval tasks without executing full eval\n");
} finally {
  await rm(temporaryRoot, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}
