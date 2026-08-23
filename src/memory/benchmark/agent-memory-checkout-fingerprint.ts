import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maximumCheckoutFiles = 50_000;
const maximumCheckoutBytes = 1024 * 1024 * 1024;

export interface AgentMemoryCheckoutFingerprintV1 {
  readonly fileCount: number;
  readonly fingerprintSha256: string;
  readonly headSha256: string;
  readonly totalBytes: number;
}

function safePath(workspaceRoot: string, relativePath: string): string {
  const target = resolve(workspaceRoot, ...relativePath.split("/"));
  const difference = relative(workspaceRoot, target);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error(
      `agent memory checkout fingerprint path escapes workspace: ${relativePath}`,
    );
  }
  return target;
}

async function git(workspaceRoot: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", [...args], {
    cwd: workspaceRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

export async function captureAgentMemoryCheckoutFingerprint(
  workspaceRoot: string,
): Promise<AgentMemoryCheckoutFingerprintV1> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const headSha256 = (
    await git(canonicalRoot, ["rev-parse", "HEAD"])
  ).toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/u.test(headSha256)) {
    throw new Error(
      "agent memory baseline requires a full Git HEAD identity",
    );
  }
  const listed = (
    await git(canonicalRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  ).toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    listed.length > maximumCheckoutFiles ||
    new Set(listed).size !== listed.length
  ) {
    throw new Error(
      "agent memory checkout inventory is duplicate or outside its file bound",
    );
  }

  const hash = createHash("sha256");
  hash.update(`agent-memory-checkout-v1\0${headSha256}\0`, "utf8");
  let totalBytes = 0;
  for (const path of listed) {
    const target = safePath(canonicalRoot, path);
    const metadata = await lstat(target);
    const containmentTarget = await realpath(
      metadata.isSymbolicLink() ? dirname(target) : target,
    );
    const containmentDifference = relative(
      canonicalRoot,
      containmentTarget,
    );
    if (
      containmentDifference === ".." ||
      containmentDifference.startsWith(`..${sep}`) ||
      isAbsolute(containmentDifference)
    ) {
      throw new Error(
        `agent memory checkout fingerprint path resolves outside workspace: ${path}`,
      );
    }
    const kind = metadata.isSymbolicLink()
      ? "symlink"
      : metadata.isFile()
        ? "file"
        : "unsupported";
    hash.update(`${path}\0${kind}\0`, "utf8");
    if (metadata.isSymbolicLink()) {
      const targetValue = await readlink(target);
      totalBytes += Buffer.byteLength(targetValue, "utf8");
      hash.update(targetValue, "utf8");
    } else if (metadata.isFile()) {
      const bytes = await readFile(target);
      totalBytes += bytes.byteLength;
      hash.update(bytes);
    } else {
      throw new Error(
        `agent memory checkout fingerprint refuses non-file Git path: ${path}`,
      );
    }
    if (totalBytes > maximumCheckoutBytes) {
      throw new Error(
        "agent memory checkout exceeds the characterization byte bound",
      );
    }
    hash.update("\0", "utf8");
  }
  return Object.freeze({
    fileCount: listed.length,
    fingerprintSha256: hash.digest("hex"),
    headSha256,
    totalBytes,
  });
}
