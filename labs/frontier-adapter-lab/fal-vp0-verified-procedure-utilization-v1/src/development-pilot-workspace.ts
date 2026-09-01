import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { StablePackageReader } from "../../../../src/capabilities/stable-package-reader.js";
import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type {
  DevelopmentPilotArm,
  DevelopmentPilotCase,
  DevelopmentPilotFixture,
} from "./development-pilot-fixture.js";
import { VP0_DEVELOPMENT_PILOT_SELECTOR } from "./development-pilot-fixture.js";

const execFileAsync = promisify(execFile);
const FIXED_SOURCE_COMMIT_DATE = "2026-08-31T00:00:00.000Z";

function rawSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function developmentPilotGitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  // The paid-provider key authorizes only the model transport. Git receives a
  // minimal process environment so hooks, helpers, or future Git behavior can
  // never inherit provider credentials or unrelated host secrets.
  return Object.freeze({
    COMSPEC: source.COMSPEC,
    GIT_AUTHOR_DATE: FIXED_SOURCE_COMMIT_DATE,
    GIT_COMMITTER_DATE: FIXED_SOURCE_COMMIT_DATE,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: source.PATH,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

export function developmentPilotVerifierEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  // Verifiers need only executable lookup and the platform's temporary/system
  // roots. In particular, provider credentials belong exclusively to the model
  // transport and must never cross this child-process boundary.
  return Object.freeze({
    COMSPEC: source.COMSPEC,
    PATH: source.PATH,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
    env: developmentPilotGitEnvironment(process.env),
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function writeNew(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

async function publicTreeSnapshot(root: string): Promise<Readonly<{
  readonly filePaths: readonly string[];
  readonly sha256: string;
}>> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("development pilot copied public tree contains a non-file entry");
    }
  };
  await visit(root);
  const publicTree = await Promise.all(files.sort().map(async (path) => ({
    path: relative(root, path).split(sep).join("/"),
    sha256: rawSha256(await readFile(path)),
  })));
  return Object.freeze({
    filePaths: Object.freeze(publicTree.map((entry) => entry.path)),
    sha256: sha256Canonical(publicTree),
  });
}

export interface DevelopmentPilotCapabilityEnvironment {
  readonly builtinRoot: string;
  readonly carrierContentSha256: string | null;
  readonly pluginSha256: string | null;
  readonly selector: typeof VP0_DEVELOPMENT_PILOT_SELECTOR | null;
  readonly skillSelections: readonly (typeof VP0_DEVELOPMENT_PILOT_SELECTOR)[];
  readonly userStateRoot: string;
}

async function createCapabilityEnvironment(input: Readonly<{
  readonly arm: DevelopmentPilotArm;
  readonly fixture: DevelopmentPilotFixture;
  readonly root: string;
}>): Promise<DevelopmentPilotCapabilityEnvironment> {
  const builtinRoot = join(input.root, "builtin");
  const userStateRoot = join(input.root, "user");
  await Promise.all([
    mkdir(builtinRoot, { recursive: true }),
    mkdir(userStateRoot, { recursive: true }),
  ]);
  await writeNew(join(builtinRoot, "index.json"), `${canonicalJson({
    packages: [],
    revision: 1,
    schema_version: 1,
  })}\n`);
  if (input.arm === "baseline") {
    await writeNew(join(userStateRoot, "enablement.json"), `${canonicalJson({
      packages: [],
      revision: 1,
      schema_version: 1,
    })}\n`);
    return Object.freeze({
      builtinRoot,
      carrierContentSha256: null,
      pluginSha256: null,
      selector: null,
      skillSelections: Object.freeze([]),
      userStateRoot,
    });
  }

  const packageRoot = join(userStateRoot, "procedure-carrier");
  await mkdir(packageRoot, { recursive: true });
  const manifest = canonicalJson({
    components: { skills: ["skill.json"] },
    description: "Development-only VP0 generic clamp procedure carrier.",
    display_name: "VP0 development procedure carrier",
    plugin_id: "bornagent.fal-vp0-development",
    plugin_version: "1.0.0",
    schema_version: 1,
  });
  const skill = canonicalJson({
    component_id: "procedure-carrier",
    context: {
      max_entry_bytes: 8 * 1024,
      max_resource_bytes: 1,
      max_total_resource_bytes: 1,
    },
    description: "One advisory generic clamp boundary procedure.",
    display_name: "Generic clamp boundary procedure",
    entry: "SKILL.md",
    invocation: "user_only",
    kind: "skill",
    schema_version: 1,
  });
  await Promise.all([
    writeNew(join(packageRoot, "bornagent.plugin.json"), `${manifest}\n`),
    writeNew(join(packageRoot, "skill.json"), `${skill}\n`),
    writeNew(join(packageRoot, "SKILL.md"), input.fixture.procedure),
  ]);
  const stable = await StablePackageReader.read(packageRoot);
  await writeNew(join(userStateRoot, "enablement.json"), `${canonicalJson({
    packages: [{
      enabled: true,
      expected_plugin_sha256: stable.pluginSha256,
      path: "procedure-carrier",
      plugin_id: stable.pluginId,
      plugin_version: stable.pluginVersion,
    }],
    revision: 1,
    schema_version: 1,
  })}\n`);
  return Object.freeze({
    builtinRoot,
    carrierContentSha256: input.fixture.procedureRawSha256,
    pluginSha256: stable.pluginSha256,
    selector: VP0_DEVELOPMENT_PILOT_SELECTOR,
    skillSelections: Object.freeze([VP0_DEVELOPMENT_PILOT_SELECTOR]),
    userStateRoot,
  });
}

export interface DevelopmentPilotAttemptWorkspace {
  readonly arm: DevelopmentPilotArm;
  readonly baselineCommit: string;
  readonly baselineSourceStateSha256: string;
  readonly capability: DevelopmentPilotCapabilityEnvironment;
  readonly caseId: DevelopmentPilotCase["caseId"];
  readonly initialTargetSha256: string;
  readonly initialVerifierFailureObserved: true;
  readonly publicFilePaths: readonly string[];
  readonly publicTreeSha256: string;
  readonly root: string;
  readonly targetRelativePath: string;
  readonly workspace: string;
}

export async function createDevelopmentPilotAttemptWorkspace(input: Readonly<{
  readonly arm: DevelopmentPilotArm;
  readonly attemptRoot: string;
  readonly case: DevelopmentPilotCase;
  readonly fixture: DevelopmentPilotFixture;
}>): Promise<DevelopmentPilotAttemptWorkspace> {
  const workspace = join(input.attemptRoot, "workspace");
  await mkdir(dirname(workspace), { recursive: true });
  await cp(input.case.publicRoot, workspace, { errorOnExist: true, recursive: true });
  const copiedPublicTree = await publicTreeSnapshot(workspace);
  if (copiedPublicTree.sha256 !== input.case.publicTreeSha256) {
    throw new Error("development pilot copied public tree drifted during workspace creation");
  }
  const target = join(workspace, ...input.case.targetRelativePath.split("/"));
  if (rawSha256(await readFile(target)) !== input.case.initialSourceSha256) {
    throw new Error("development pilot initial target bytes drifted during workspace creation");
  }
  let initialVerifierFailureObserved = false;
  try {
    await execFileAsync(input.case.verifier.argv[0], [input.case.verifier.argv[1]], {
      cwd: workspace,
      encoding: "utf8",
      env: developmentPilotVerifierEnvironment(process.env),
      windowsHide: true,
    });
  } catch (error) {
    initialVerifierFailureObserved =
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "number" && error.code !== 0;
  }
  if (!initialVerifierFailureObserved) {
    throw new Error("development pilot public case does not have a reproducible failing verifier");
  }
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await git(workspace, ["init", "--quiet"]);
  await git(workspace, ["config", "user.email", "vp0-development@example.invalid"]);
  await git(workspace, ["config", "user.name", "FAL VP0 Development Pilot"]);
  await git(workspace, ["config", "core.autocrlf", "false"]);
  await git(workspace, ["add", "--all"]);
  await git(workspace, [
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    `VP0 development ${input.case.caseId} baseline`,
  ]);
  const baselineCommit = await git(workspace, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baselineCommit)) {
    throw new Error("development pilot baseline commit is invalid");
  }
  const capability = await createCapabilityEnvironment({
    arm: input.arm,
    fixture: input.fixture,
    root: join(input.attemptRoot, "capabilities"),
  });
  const baselineSourceStateSha256 = sha256Canonical({
    baselineCommit,
    caseId: input.case.caseId,
    initialTargetSha256: input.case.initialSourceSha256,
    initialVerifierFailureObserved: true,
    publicTreeSha256: input.case.publicTreeSha256,
    targetRelativePath: input.case.targetRelativePath,
  });
  return Object.freeze({
    arm: input.arm,
    baselineCommit,
    baselineSourceStateSha256,
    capability,
    caseId: input.case.caseId,
    initialTargetSha256: input.case.initialSourceSha256,
    initialVerifierFailureObserved: true,
    publicFilePaths: copiedPublicTree.filePaths,
    publicTreeSha256: copiedPublicTree.sha256,
    root: input.attemptRoot,
    targetRelativePath: input.case.targetRelativePath,
    workspace,
  });
}

export interface DevelopmentPilotFreshVerification {
  readonly changedPaths: readonly string[];
  readonly diffSha256: string;
  readonly finalSourceStateSha256: string;
  readonly finalTargetSha256: string;
  readonly verifierExitCode: 0;
  readonly verifierStdoutSha256: string;
}

export async function verifyDevelopmentPilotAttemptWorkspace(
  caseInput: DevelopmentPilotCase,
  attempt: DevelopmentPilotAttemptWorkspace,
): Promise<DevelopmentPilotFreshVerification> {
  const target = join(attempt.workspace, ...caseInput.targetRelativePath.split("/"));
  const finalSource = await readFile(target, "utf8");
  if (
    finalSource !== caseInput.exactFinalSource ||
    rawSha256(finalSource) !== caseInput.exactFinalSourceSha256
  ) {
    throw new Error("development pilot target does not match exact fixed bytes");
  }
  const [tracked, untracked, diff] = await Promise.all([
    git(attempt.workspace, ["diff", "--name-only", "HEAD", "--"]),
    git(attempt.workspace, ["ls-files", "--others", "--exclude-standard"]),
    git(attempt.workspace, ["diff", "--binary", "HEAD", "--"]),
  ]);
  const changed = [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/u).filter(Boolean))].sort();
  if (changed.length !== 1 || changed[0] !== caseInput.targetRelativePath) {
    throw new Error("development pilot changed paths exceed the exact public target");
  }
  const verifier = await execFileAsync(
    caseInput.verifier.argv[0],
    [caseInput.verifier.argv[1]],
    {
      cwd: attempt.workspace,
      encoding: "utf8",
      env: developmentPilotVerifierEnvironment(process.env),
      windowsHide: true,
    },
  );
  const diffSha256 = rawSha256(diff);
  return Object.freeze({
    changedPaths: Object.freeze([caseInput.targetRelativePath]),
    diffSha256,
    finalSourceStateSha256: sha256Canonical({
      baselineCommit: attempt.baselineCommit,
      changedPaths: [caseInput.targetRelativePath],
      diffSha256,
      finalTargetSha256: caseInput.exactFinalSourceSha256,
    }),
    finalTargetSha256: caseInput.exactFinalSourceSha256,
    verifierExitCode: 0,
    verifierStdoutSha256: rawSha256(verifier.stdout),
  });
}
