import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type RenameDurabilityCapability =
  | "parent_directory_sync"
  | "windows_installed_file_sync";

export interface RenameDurabilityPort {
  readonly capability: RenameDurabilityCapability;
  install(
    tempPath: string,
    targetPath: string,
    expectedBytes: Uint8Array,
  ): Promise<void>;
}

export class RenameDurabilityError extends Error {
  constructor(
    readonly code:
      | "cross_directory_rename"
      | "installed_identity_invalid"
      | "installed_readback_mismatch",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "RenameDurabilityError";
  }
}

function pathKey(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class NodeRenameDurabilityPort implements RenameDurabilityPort {
  readonly capability: RenameDurabilityCapability;

  constructor(private readonly platform: string = process.platform) {
    this.capability =
      platform === "win32"
        ? "windows_installed_file_sync"
        : "parent_directory_sync";
  }

  async install(
    tempPath: string,
    targetPath: string,
    expectedBytes: Uint8Array,
  ): Promise<void> {
    const parent = dirname(targetPath);
    if (pathKey(dirname(tempPath)) !== pathKey(parent)) {
      throw new RenameDurabilityError(
        "cross_directory_rename",
        "durable rename requires a temp file in the target directory",
      );
    }

    await rename(tempPath, targetPath);

    // PHASE9: POSIX persists the renamed directory entry with parent fsync.
    // Node cannot open a Windows directory for FlushFileBuffers, so the
    // Windows capability reopens the installed name, syncs that exact file
    // handle, and verifies namespace identity plus byte-for-byte readback. If
    // either platform cannot complete its advertised proof, the caller stops.
    const installedHandle = await open(targetPath, "r+");
    try {
      await installedHandle.sync();
    } finally {
      await installedHandle.close();
    }

    const metadata = await lstat(targetPath);
    const canonical = await realpath(targetPath);
    const expectedCanonical = join(
      await realpath(parent),
      basename(targetPath),
    );
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      pathKey(canonical) !== pathKey(expectedCanonical)
    ) {
      throw new RenameDurabilityError(
        "installed_identity_invalid",
        "installed durable file is not the expected regular non-link target",
      );
    }
    const readback = await readFile(targetPath);
    if (!readback.equals(expectedBytes)) {
      throw new RenameDurabilityError(
        "installed_readback_mismatch",
        "installed durable file failed byte-for-byte readback",
      );
    }

    if (this.platform !== "win32") {
      const directoryHandle = await open(parent, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  }
}
