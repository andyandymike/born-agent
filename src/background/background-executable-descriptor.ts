import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { BackgroundError } from "./background-errors.js";
import { backgroundExecutableDescriptorSchema, type BackgroundExecutableDescriptorV1 } from "./background-schema.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_FILES = 4_096;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stableFile(path: string, maximumBytes: number): Promise<{ readonly bytes: Buffer; readonly canonicalPath: string }> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) {
      throw new BackgroundError("background_executable_unsealed", "background executable component is not a bounded unique regular file");
    }
    const canonicalPath = await realpath(path);
    handle = await open(path, "r");
    const openedBefore = await handle.stat();
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const after = await lstat(path);
    if (
      bytes.byteLength !== openedAfter.size || before.dev !== openedBefore.dev || before.ino !== openedBefore.ino ||
      openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino || openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs || openedBefore.ctimeMs !== openedAfter.ctimeMs ||
      after.dev !== openedAfter.dev || after.ino !== openedAfter.ino || after.size !== openedAfter.size ||
      after.mtimeMs !== openedAfter.mtimeMs || after.ctimeMs !== openedAfter.ctimeMs
    ) {
      throw new BackgroundError("worker_launch_stale", "background executable component changed while being hashed");
    }
    return Object.freeze({ bytes: Buffer.from(bytes), canonicalPath });
  } catch (error) {
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("background_executable_unsealed", "background executable component could not be read", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inventory(root: string, directory: string, state: { bytes: number; files: number }): Promise<readonly { readonly bytes: number; readonly path: string; readonly sha256: string }[]> {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const result: { bytes: number; path: string; sha256: string }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = `${directory}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new BackgroundError("background_executable_unsealed", "built package inventory contains an unsupported entry");
    }
    if (entry.isDirectory()) result.push(...await inventory(root, relativePath, state));
    else {
      const file = await stableFile(join(root, ...relativePath.split("/")), 32 * 1024 * 1024);
      state.files += 1;
      state.bytes += file.bytes.byteLength;
      if (state.files > MAX_PACKAGE_FILES || state.bytes > MAX_PACKAGE_BYTES) {
        throw new BackgroundError("background_executable_unsealed", "built package inventory exceeds its fixed bound");
      }
      result.push(Object.freeze({ bytes: file.bytes.byteLength, path: relativePath, sha256: hash(file.bytes) }));
    }
  }
  return result;
}

export interface SealedBackgroundExecutableV1 {
  readonly cliEntryPath: string;
  readonly descriptor: BackgroundExecutableDescriptorV1;
  readonly descriptorSha256: string;
  readonly nodeExecutablePath: string;
  readonly packageRoot: string;
}

export async function sealBackgroundExecutable(input: {
  readonly cliEntryPath: string;
  readonly nodeExecutablePath: string;
  readonly nodeVersion: string;
}): Promise<SealedBackgroundExecutableV1> {
  const cliPath = resolve(input.cliEntryPath);
  if (basename(dirname(cliPath)).toLocaleLowerCase("en-US") !== "dist" || basename(cliPath).toLocaleLowerCase("en-US") !== "cli.js") {
    throw new BackgroundError("background_executable_unsealed", "background execution requires the built dist/cli.js entry");
  }
  const packageRoot = resolve(dirname(cliPath), "..");
  const relativeEntry = relative(packageRoot, cliPath).replaceAll("\\", "/");
  if (relativeEntry !== "dist/cli.js") throw new BackgroundError("background_executable_unsealed", "CLI entry is outside the current package root");
  const [node, cli, packageFile] = await Promise.all([
    stableFile(resolve(input.nodeExecutablePath), MAX_EXECUTABLE_BYTES),
    stableFile(cliPath, 32 * 1024 * 1024),
    stableFile(join(packageRoot, "package.json"), 1024 * 1024),
  ]);
  let packageJson: unknown;
  try {
    packageJson = parseStrictJson(packageFile.bytes.toString("utf8"));
  } catch (error) {
    throw new BackgroundError("background_executable_unsealed", "package.json is not strict JSON", { cause: error });
  }
  if (
    typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson) ||
    (packageJson as { name?: unknown }).name !== "bornagent" || typeof (packageJson as { version?: unknown }).version !== "string"
  ) {
    throw new BackgroundError("background_executable_unsealed", "built CLI package identity is not bornagent");
  }
  const state = { bytes: packageFile.bytes.byteLength, files: 1 };
  const dist = await inventory(packageRoot, "dist", state);
  if (!dist.some((entry) => entry.path === "dist/cli.js" && entry.sha256 === hash(cli.bytes))) {
    throw new BackgroundError("background_executable_unsealed", "built CLI entry is absent from the sealed package inventory");
  }
  const packageRootInventorySha256 = sha256Canonical([
    { bytes: packageFile.bytes.byteLength, path: "package.json", sha256: hash(packageFile.bytes) },
    ...dist,
  ]);
  const descriptor = backgroundExecutableDescriptorSchema.parse({
    cliEntryPathSha256: hash(cli.canonicalPath),
    cliEntrySha256: hash(cli.bytes),
    nodeExecutablePathSha256: hash(node.canonicalPath),
    nodeExecutableSha256: hash(node.bytes),
    nodeVersion: input.nodeVersion,
    packageName: "bornagent",
    packageRootInventorySha256,
    packageVersion: (packageJson as { version: string }).version,
    schemaVersion: 1,
    workerProtocolVersion: 1,
  });
  return Object.freeze({
    cliEntryPath: cli.canonicalPath,
    descriptor: Object.freeze(descriptor),
    descriptorSha256: sha256Canonical(descriptor),
    nodeExecutablePath: node.canonicalPath,
    packageRoot,
  });
}

export async function revalidateBackgroundExecutable(sealed: SealedBackgroundExecutableV1): Promise<void> {
  const current = await sealBackgroundExecutable({
    cliEntryPath: sealed.cliEntryPath,
    nodeExecutablePath: sealed.nodeExecutablePath,
    nodeVersion: sealed.descriptor.nodeVersion,
  });
  if (current.descriptorSha256 !== sealed.descriptorSha256) {
    throw new BackgroundError("worker_launch_stale", "sealed background executable changed before ownership handoff");
  }
}
