import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { sanitizeChildEnvironment } from "../security/child-environment.js";
import { canonicalRelativePath, type SourceEnumeration, type SourceEnumerator } from "./source-enumerator.js";

const execFile = promisify(nodeExecFile);
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface GitSourceRunner {
  run(args: readonly string[], signal: AbortSignal): Promise<Buffer>;
}

class NodeGitSourceRunner implements GitSourceRunner {
  constructor(
    private readonly workspace: string,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async run(args: readonly string[], signal: AbortSignal): Promise<Buffer> {
    const result = await execFile("git", [...args], {
      cwd: this.workspace,
      encoding: "buffer",
      env: sanitizeChildEnvironment(this.environment),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      signal,
      timeout: 10_000,
      windowsHide: true,
    });
    return Buffer.from(result.stdout);
  }
}

function nulFields(value: Uint8Array): readonly string[] {
  return Buffer.from(value)
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

export class GitSourceEnumerator implements SourceEnumerator {
  private readonly runner: GitSourceRunner;

  constructor(
    workspace: string,
    environment: Readonly<Record<string, string | undefined>> = process.env,
    runner?: GitSourceRunner,
  ) {
    this.runner = runner ?? new NodeGitSourceRunner(workspace, environment);
  }

  async enumerate(signal: AbortSignal): Promise<SourceEnumeration | null> {
    try {
      const inside = (await this.runner.run(["rev-parse", "--is-inside-work-tree"], signal))
        .toString("utf8")
        .trim();
      if (inside !== "true") return null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }

    const [files, deletedFiles, indexFacts, statusFacts] = await Promise.all([
      this.runner.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], signal),
      this.runner.run(["ls-files", "-z", "--deleted", "--", "."], signal),
      this.runner.run(["ls-files", "-s", "-z", "--", "."], signal),
      this.runner.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."], signal),
    ]);
    let head: string | null = null;
    try {
      const candidate = (await this.runner.run(["rev-parse", "--verify", "HEAD"], signal))
        .toString("utf8")
        .trim()
        .toLowerCase();
      if (/^[a-f0-9]{40,64}$/u.test(candidate)) head = candidate;
    } catch (error) {
      if (signal.aborted) throw error;
    }

    const invalid: string[] = [];
    const deleted = new Set(
      nulFields(deletedFiles)
        .map((path) => canonicalRelativePath(path))
        .filter((path): path is string => path !== null),
    );
    const paths = nulFields(files)
      .map((path) => {
        const canonical = canonicalRelativePath(path);
        if (canonical === null) invalid.push(path);
        return canonical;
      })
      .filter((path): path is string => path !== null && !deleted.has(path));
    const digest = createHash("sha256")
      .update("git-index-v1\0", "utf8")
      .update(indexFacts)
      .update("\0git-status-v2\0", "utf8")
      .update(statusFacts)
      .digest("hex");
    return Object.freeze({
      gitHeadOid: head,
      gitIndexSha256: digest,
      paths: Object.freeze(paths),
      skipped: invalid.length === 0 ? Object.freeze({}) : Object.freeze({ invalid_git_path: invalid.length }),
      sourceKind: "git_worktree" as const,
    });
  }
}
