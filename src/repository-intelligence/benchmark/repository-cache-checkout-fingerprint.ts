import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function safePath(workspaceRoot: string, relativePath: string): string {
  const target = resolve(workspaceRoot, ...relativePath.split("/"));
  const difference = relative(workspaceRoot, target);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new Error(`checkout fingerprint path escapes workspace: ${relativePath}`);
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

export interface RepositoryCacheCheckoutFingerprintV1 {
  readonly fingerprintSha256: string;
  readonly headSha256: string;
}

export async function captureRepositoryCacheCheckoutFingerprint(
  workspaceRoot: string,
): Promise<RepositoryCacheCheckoutFingerprintV1> {
  const canonicalRoot = resolve(workspaceRoot);
  const headSha256 = (await git(canonicalRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/u.test(headSha256)) throw new Error("repository cache benchmark requires a full Git HEAD identity");
  const listed = (await git(canonicalRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(listed).size !== listed.length) throw new Error("Git checkout inventory contains duplicate paths");
  const hash = createHash("sha256");
  hash.update(`repository-cache-checkout-v1\0${headSha256}\0`, "utf8");
  for (const path of listed) {
    const target = safePath(canonicalRoot, path);
    const metadata = await lstat(target);
    hash.update(`${path}\0${metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "unsupported"}\0`, "utf8");
    if (metadata.isSymbolicLink()) {
      hash.update(await readlink(target), "utf8");
    } else if (metadata.isFile()) {
      hash.update(await readFile(target));
    } else {
      throw new Error(`checkout fingerprint refuses non-file Git path: ${path}`);
    }
    hash.update("\0", "utf8");
  }
  return Object.freeze({ fingerprintSha256: hash.digest("hex"), headSha256 });
}
