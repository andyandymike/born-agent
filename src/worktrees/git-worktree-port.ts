import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { sanitizeChildEnvironment } from "../security/child-environment.js";
import { WorktreeError } from "./worktree-errors.js";
import type { RepositoryIdentityV1 } from "./worktree-schema.js";

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export interface GitTrackedEntryV1 {
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly path: string;
}

export interface GitRepositoryObservationV1 {
  readonly commonDir: string;
  readonly identity: RepositoryIdentityV1;
  readonly originRoot: string;
  readonly statusBytes: Buffer;
  readonly tracked: readonly GitTrackedEntryV1[];
}

export interface GitWorktreeListEntryV1 {
  readonly bare: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly locked: boolean;
  readonly path: string;
}

export interface GitWorktreePort {
  addNoCheckout(input: { readonly baseCommit: string; readonly originRoot: string; readonly worktreePath: string }): Promise<void>;
  list(originRoot: string): Promise<readonly GitWorktreeListEntryV1[]>;
  lock(originRoot: string, worktreePath: string): Promise<void>;
  observe(originRoot: string): Promise<GitRepositoryObservationV1>;
  remove(originRoot: string, worktreePath: string, force: boolean): Promise<void>;
  unlock(originRoot: string, worktreePath: string): Promise<void>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) throw new WorktreeError("worktree_git_unavailable", "Git returned an invalid path");
  return resolve(trimmed);
}

function sanitizeGitDetail(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe = codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    return unsafe ? "?" : character;
  }).join("");
}

function parseTracked(bytes: Buffer, objectFormat: "sha1" | "sha256"): readonly GitTrackedEntryV1[] {
  const values = bytes.toString("utf8").split("\0").filter((value) => value.length > 0);
  const result = values.map((value): GitTrackedEntryV1 => {
    const tab = value.indexOf("\t");
    if (tab <= 0) throw new WorktreeError("worktree_git_unavailable", "Git tracked-file record is malformed");
    const header = value.slice(0, tab).split(" ");
    const path = value.slice(tab + 1);
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    if (
      header.length !== 3 ||
      !["100644", "100755"].includes(header[0] ?? "") ||
      !new RegExp(`^[a-f0-9]{${String(expectedLength)}}$`, "u").test(header[1] ?? "") ||
      header[2] !== "0" ||
      path.length === 0 || path.includes("\\") || path.startsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new WorktreeError("worktree_promotion_unsupported", "repository contains an unsupported tracked entry");
    }
    return Object.freeze({ mode: header[0] as "100644" | "100755", objectId: header[1]!, path });
  });
  if (new Set(result.map((entry) => entry.path.toLocaleLowerCase("en-US"))).size !== result.length) {
    throw new WorktreeError("worktree_promotion_unsupported", "tracked paths contain a case-fold collision");
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path, "en")));
}

function parseWorktreeList(text: string): readonly GitWorktreeListEntryV1[] {
  const records = text.replace(/\r\n/gu, "\n").trim().split(/\n\n+/u).filter(Boolean);
  return Object.freeze(records.map((record) => {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    let locked = false;
    for (const line of record.split("\n")) {
      const separator = line.indexOf(" ");
      const key = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1);
      if (key === "worktree") path = canonicalGitPath(value);
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value;
      else if (key === "bare") bare = true;
      else if (key === "detached") detached = true;
      else if (key === "locked") locked = true;
    }
    if (path === null) throw new WorktreeError("worktree_git_unavailable", "Git worktree record has no path");
    return Object.freeze({ bare, branch, detached, head, locked, path });
  }));
}

export class NodeGitWorktreePort implements GitWorktreePort {
  constructor(private readonly options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly executable?: string;
    readonly timeoutMs?: number;
  }) {}

  async #run(cwd: string, argv: readonly string[]): Promise<Buffer> {
    const executable = this.options.executable ?? "git";
    return new Promise<Buffer>((resolveRun, reject) => {
      const child = spawn(executable, argv, {
        cwd,
        env: sanitizeChildEnvironment({
          GIT_ASKPASS: "",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          PATH: this.options.environment.PATH,
          Path: this.options.environment.Path,
          SystemRoot: this.options.environment.SystemRoot,
          TEMP: this.options.environment.TEMP,
          TMP: this.options.environment.TMP,
          WINDIR: this.options.environment.WINDIR,
        }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error !== undefined) reject(error);
        else resolveRun(Buffer.concat(stdout));
      };
      const capture = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > MAX_GIT_OUTPUT) {
          child.kill("SIGKILL");
          finish(new WorktreeError("worktree_git_unavailable", "Git output exceeded its fixed bound"));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => finish(new WorktreeError("worktree_git_unavailable", "Git could not be started", { cause: error })));
      child.once("close", (code, signal) => {
        if (settled) return;
        if (code !== 0 || signal !== null) {
          const privateValues = [cwd, ...argv.filter((value) => /^[A-Za-z]:[\\/]|^\//u.test(value))]
            .sort((left, right) => right.length - left.length);
          let detail = sanitizeGitDetail(Buffer.concat(stderr).toString("utf8"));
          for (const value of privateValues) detail = detail.replaceAll(value, "<managed-path>");
          detail = detail.trim().slice(0, 512);
          finish(new WorktreeError("worktree_git_unavailable", `Git ${argv.slice(0, 2).join(" ")} failed (${String(code ?? signal ?? "unknown")})${detail.length === 0 ? "" : `: ${detail}`}`));
        } else finish();
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new WorktreeError("worktree_git_unavailable", "Git command timed out"));
      }, this.options.timeoutMs ?? 30_000);
    });
  }

  async observe(originRoot: string): Promise<GitRepositoryObservationV1> {
    const root = canonicalGitPath((await this.#run(originRoot, ["rev-parse", "--show-toplevel"])).toString("utf8"));
    const commonRaw = (await this.#run(root, ["rev-parse", "--git-common-dir"])).toString("utf8").trim();
    const commonDir = canonicalGitPath(resolve(root, commonRaw));
    const objectFormatRaw = (await this.#run(root, ["rev-parse", "--show-object-format"])).toString("utf8").trim();
    if (objectFormatRaw !== "sha1" && objectFormatRaw !== "sha256") {
      throw new WorktreeError("worktree_git_unavailable", "Git object format is unsupported");
    }
    const baseCommit = (await this.#run(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim();
    const statusBytes = await this.#run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const trackedBytes = await this.#run(root, ["ls-files", "-z", "--stage"]);
    const identity = Object.freeze({
      baseCommit,
      gitCommonDirSha256: sha256(commonDir),
      objectFormat: objectFormatRaw,
      originRootSha256: sha256(root),
      repositoryId: sha256(`${root}\0${commonDir}\0${objectFormatRaw}`),
      schemaVersion: 1 as const,
    });
    return Object.freeze({
      commonDir,
      identity,
      originRoot: root,
      statusBytes,
      tracked: parseTracked(trackedBytes, objectFormatRaw),
    });
  }

  async list(originRoot: string): Promise<readonly GitWorktreeListEntryV1[]> {
    return parseWorktreeList((await this.#run(originRoot, ["worktree", "list", "--porcelain"])).toString("utf8"));
  }

  async addNoCheckout(input: { readonly baseCommit: string; readonly originRoot: string; readonly worktreePath: string }): Promise<void> {
    await this.#run(input.originRoot, ["worktree", "add", "--detach", "--no-checkout", input.worktreePath, input.baseCommit]);
  }

  async lock(originRoot: string, worktreePath: string): Promise<void> {
    await this.#run(originRoot, ["worktree", "lock", worktreePath]);
  }

  async unlock(originRoot: string, worktreePath: string): Promise<void> {
    await this.#run(originRoot, ["worktree", "unlock", worktreePath]);
  }

  async remove(originRoot: string, worktreePath: string, force: boolean): Promise<void> {
    await this.#run(originRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
  }
}
