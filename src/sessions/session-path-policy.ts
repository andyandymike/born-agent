import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SessionPathFileSystem {
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{
    readonly dev: number;
    readonly ino: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  mkdir(
    path: string,
    options: { readonly mode: number; readonly recursive: false },
  ): Promise<void>;
  realpath(path: string): Promise<string>;
}

const nodeFileSystem: SessionPathFileSystem = {
  chmod,
  lstat,
  mkdir,
  realpath,
};

export interface SessionStoragePaths {
  readonly agentDirectory: string;
  readonly checkpointDirectory: string;
  readonly checkpointRootDirectory: string;
  readonly lockFilePath: string;
  readonly sessionDirectory: string;
  readonly sessionFilePath: string;
  readonly workspaceRealPath: string;
}

export class SessionPathError extends Error {
  constructor(
    readonly code:
      | "invalid_checkpoint_id"
      | "invalid_session_id"
      | "path_identity_changed"
      | "path_not_canonical"
      | "path_not_directory"
      | "path_not_file"
      | "path_outside_workspace"
      | "path_uses_link",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SessionPathError";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function platformKey(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith("../") &&
      !difference.startsWith("..\\") &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

export function assertCanonicalSessionId(sessionId: string): string {
  if (!CANONICAL_UUID.test(sessionId)) {
    throw new SessionPathError(
      "invalid_session_id",
      "session id must be a canonical lowercase UUID",
    );
  }
  return sessionId;
}

export function assertCanonicalCheckpointId(checkpointId: string): string {
  if (!CANONICAL_UUID.test(checkpointId)) {
    throw new SessionPathError(
      "invalid_checkpoint_id",
      "checkpoint id must be a canonical lowercase UUID",
    );
  }
  return checkpointId;
}

export class SessionPathPolicy {
  private constructor(
    readonly workspaceRealPath: string,
    private readonly workspaceIdentity: {
      readonly dev: number;
      readonly ino: number;
    },
    private readonly fileSystem: SessionPathFileSystem,
  ) {}

  static async create(
    workspace: string,
    fileSystem: SessionPathFileSystem = nodeFileSystem,
  ): Promise<SessionPathPolicy> {
    if (!isAbsolute(workspace)) {
      throw new SessionPathError(
        "path_not_canonical",
        "workspace must be an absolute canonical path",
      );
    }

    const lexical = resolve(workspace);
    const metadata = await SessionPathPolicy.assertNoLinkComponents(
      lexical,
      fileSystem,
    );
    if (!metadata.isDirectory()) {
      throw new SessionPathError(
        "path_not_directory",
        "workspace path must be a directory",
      );
    }

    const canonical = await fileSystem.realpath(lexical);
    return new SessionPathPolicy(
      canonical,
      { dev: metadata.dev, ino: metadata.ino },
      fileSystem,
    );
  }

  private static async assertNoLinkComponents(
    path: string,
    fileSystem: SessionPathFileSystem,
  ): Promise<Awaited<ReturnType<SessionPathFileSystem["lstat"]>>> {
    const root = parse(path).root;
    const suffix = path.slice(root.length);
    const segments = suffix.split(/[\\/]/u).filter((segment) => segment.length > 0);
    let current = root;
    let metadata = await fileSystem.lstat(root);
    for (const segment of segments) {
      current = join(current, segment);
      metadata = await fileSystem.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new SessionPathError(
          "path_uses_link",
          "workspace path must not use a symbolic link or junction",
        );
      }
    }
    return metadata;
  }

  async prepareSession(sessionId: string): Promise<SessionStoragePaths> {
    assertCanonicalSessionId(sessionId);
    await this.assertWorkspaceIdentity();

    const paths = this.storagePaths(sessionId);

    await this.ensurePrivateDirectory(paths.agentDirectory);
    await this.ensurePrivateDirectory(paths.sessionDirectory);
    await this.ensurePrivateDirectory(paths.checkpointRootDirectory);

    await this.assertSessionPathsSafe(paths, { allowMissingCheckpointDirectory: true });
    return paths;
  }

  async inspectSessionDirectory(): Promise<string> {
    await this.assertWorkspaceIdentity();
    const paths = this.storagePaths(
      "00000000-0000-4000-8000-000000000000",
    );
    await this.assertDirectory(paths.agentDirectory);
    await this.assertDirectory(paths.sessionDirectory);
    return paths.sessionDirectory;
  }

  async inspectExistingSession(sessionId: string): Promise<SessionStoragePaths> {
    assertCanonicalSessionId(sessionId);
    await this.assertWorkspaceIdentity();
    const paths = this.storagePaths(sessionId);
    await this.assertDirectory(paths.agentDirectory);
    await this.assertDirectory(paths.sessionDirectory);
    await this.assertDirectoryIfPresent(paths.checkpointRootDirectory);
    await this.assertDirectoryIfPresent(paths.checkpointDirectory);
    await this.assertRegularFile(paths.sessionFilePath);
    await this.assertRegularFileIfPresent(paths.lockFilePath);
    return paths;
  }

  async prepareCheckpointDirectory(sessionId: string): Promise<SessionStoragePaths> {
    const paths = await this.prepareSession(sessionId);
    await this.ensurePrivateDirectory(paths.checkpointDirectory);
    await this.assertSessionPathsSafe(paths);
    return paths;
  }

  async assertSessionPathsSafe(
    paths: SessionStoragePaths,
    options: { readonly allowMissingCheckpointDirectory?: boolean } = {},
  ): Promise<void> {
    await this.assertWorkspaceIdentity();
    for (const directory of [
      paths.agentDirectory,
      paths.sessionDirectory,
      paths.checkpointRootDirectory,
    ]) {
      await this.assertDirectory(directory);
    }

    if (!options.allowMissingCheckpointDirectory) {
      await this.assertDirectory(paths.checkpointDirectory);
    } else {
      await this.assertDirectoryIfPresent(paths.checkpointDirectory);
    }

    await this.assertRegularFileIfPresent(paths.sessionFilePath);
    await this.assertRegularFileIfPresent(paths.lockFilePath);
  }

  assertContained(path: string): void {
    if (!isContained(this.workspaceRealPath, resolve(path))) {
      throw new SessionPathError(
        "path_outside_workspace",
        "session storage path is outside the canonical workspace",
      );
    }
  }

  private storagePaths(sessionId: string): SessionStoragePaths {
    const agentDirectory = join(this.workspaceRealPath, ".bornagent");
    const sessionDirectory = join(agentDirectory, "sessions");
    const checkpointRootDirectory = join(agentDirectory, "checkpoints");
    return {
      agentDirectory,
      checkpointDirectory: join(checkpointRootDirectory, sessionId),
      checkpointRootDirectory,
      lockFilePath: join(sessionDirectory, `${sessionId}.lock`),
      sessionDirectory,
      sessionFilePath: join(sessionDirectory, `${sessionId}.jsonl`),
      workspaceRealPath: this.workspaceRealPath,
    };
  }

  private async assertWorkspaceIdentity(): Promise<void> {
    const metadata = await this.fileSystem.lstat(this.workspaceRealPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SessionPathError(
        "path_identity_changed",
        "workspace identity changed while session storage was open",
      );
    }
    const canonical = await this.fileSystem.realpath(this.workspaceRealPath);
    if (
      metadata.dev !== this.workspaceIdentity.dev ||
      metadata.ino !== this.workspaceIdentity.ino ||
      platformKey(canonical) !== platformKey(this.workspaceRealPath)
    ) {
      throw new SessionPathError(
        "path_identity_changed",
        "workspace identity changed while session storage was open",
      );
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    this.assertContained(path);
    try {
      await this.fileSystem.mkdir(path, { mode: 0o700, recursive: false });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await this.assertDirectory(path);
    if (process.platform !== "win32") {
      await this.fileSystem.chmod(path, 0o700);
    }
  }

  private async assertDirectory(path: string): Promise<void> {
    this.assertContained(path);
    const metadata = await this.fileSystem.lstat(path);
    if (metadata.isSymbolicLink()) {
      // PHASE9: Realpath equality plus lstat is deliberately fail-closed: a
      // Windows junction is a link even when its target remains in-workspace.
      throw new SessionPathError(
        "path_uses_link",
        "session storage directories must not use symbolic links or junctions",
      );
    }
    if (!metadata.isDirectory()) {
      throw new SessionPathError(
        "path_not_directory",
        "session storage path must be a directory",
      );
    }
    const canonical = await this.fileSystem.realpath(path);
    if (platformKey(canonical) !== platformKey(path)) {
      throw new SessionPathError(
        "path_uses_link",
        "session storage path must not traverse a symbolic link or junction",
      );
    }
  }

  private async assertDirectoryIfPresent(path: string): Promise<void> {
    try {
      await this.assertDirectory(path);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  private async assertRegularFileIfPresent(path: string): Promise<void> {
    this.assertContained(path);
    try {
      await this.assertRegularFile(path);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  private async assertRegularFile(path: string): Promise<void> {
    this.assertContained(path);
    const metadata = await this.fileSystem.lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new SessionPathError(
        "path_uses_link",
        "session storage files must not be symbolic links or junctions",
      );
    }
    if (!metadata.isFile()) {
      throw new SessionPathError(
        "path_not_file",
        "session storage path must be a regular file",
      );
    }
    const canonical = await this.fileSystem.realpath(path);
    if (platformKey(canonical) !== platformKey(path)) {
      throw new SessionPathError(
        "path_uses_link",
        "session storage file must not traverse a symbolic link or junction",
      );
    }
  }
}
