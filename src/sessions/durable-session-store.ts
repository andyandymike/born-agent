import { lstat, open, type FileHandle } from "node:fs/promises";

import {
  recoverSessionTail,
  type StoredLineDecoder,
  type TailRecoveryResult,
} from "./tail-recovery.js";
import {
  SessionLock,
  type SessionLockAcquireOptions,
  type SessionLockRecovery,
} from "./session-lock.js";
import { SessionPathPolicy } from "./session-path-policy.js";

export interface DurableSessionStoreOpenOptions<T> {
  readonly decoder: StoredLineDecoder<T>;
  readonly lock?: SessionLockAcquireOptions;
  readonly policy?: SessionPathPolicy;
  readonly sessionId: string;
  readonly workspace: string;
}

export interface DurableAppendReceipt {
  readonly bytes: number;
  readonly lineNumber: number;
}

export class DurableSessionStoreError extends Error {
  constructor(
    readonly code:
      | "append_write_incomplete"
      | "encoded_line_invalid"
      | "session_store_closed"
      | "session_store_poisoned"
      | "session_store_poisoned_lock_preserved",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "DurableSessionStoreError";
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEncodedLine(encoded: string | Uint8Array): Buffer {
  const bytes =
    typeof encoded === "string" ? Buffer.from(encoded, "utf8") : Buffer.from(encoded);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DurableSessionStoreError(
      "encoded_line_invalid",
      "stored event encoding must be valid UTF-8",
      { cause: error },
    );
  }
  if (text.length === 0 || text.includes("\n") || text.includes("\r")) {
    throw new DurableSessionStoreError(
      "encoded_line_invalid",
      "stored event encoding must be exactly one unterminated JSON line",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new DurableSessionStoreError(
      "encoded_line_invalid",
      "stored event encoding must be one JSON object",
      { cause: error },
    );
  }
  if (!isJsonObject(parsed)) {
    throw new DurableSessionStoreError(
      "encoded_line_invalid",
      "stored event encoding must be one JSON object",
    );
  }
  return bytes;
}

export class DurableSessionStore<T> {
  readonly path: string;
  readonly tailRecovery: TailRecoveryResult<T>;
  private closed = false;
  private lineCount: number;
  private poisoned = false;

  private constructor(
    private readonly policy: SessionPathPolicy,
    private readonly lock: SessionLock,
    private readonly handle: FileHandle,
    private readonly handleIdentity: { readonly dev: number; readonly ino: number },
    tailRecovery: TailRecoveryResult<T>,
  ) {
    this.path = lock.paths.sessionFilePath;
    this.tailRecovery = tailRecovery;
    this.lineCount = tailRecovery.lineCount;
  }

  static async open<T>(
    options: DurableSessionStoreOpenOptions<T>,
  ): Promise<DurableSessionStore<T>> {
    const policy =
      options.policy ?? (await SessionPathPolicy.create(options.workspace));
    const lock = await SessionLock.acquire(
      policy,
      options.sessionId,
      options.lock,
    );
    let handle: FileHandle | undefined;
    try {
      const tailRecovery = await recoverSessionTail({
        decoder: options.decoder,
        lock,
        policy,
      });
      handle = await open(lock.paths.sessionFilePath, "a", 0o600);
      if (process.platform !== "win32") {
        await handle.chmod(0o600);
      }
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new DurableSessionStoreError(
          "encoded_line_invalid",
          "session storage target is not a regular file",
        );
      }
      await policy.assertSessionPathsSafe(lock.paths, {
        allowMissingCheckpointDirectory: true,
      });
      const store = new DurableSessionStore(
        policy,
        lock,
        handle,
        { dev: metadata.dev, ino: metadata.ino },
        tailRecovery,
      );
      handle = undefined;
      return store;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  get isPoisoned(): boolean {
    return this.poisoned;
  }

  get lockRecovery(): SessionLockRecovery | undefined {
    return this.lock.recovery;
  }

  get nextPhysicalLine(): number {
    return this.lineCount + 1;
  }

  async withOwnedLock<R>(
    action: (lock: SessionLock) => Promise<R>,
  ): Promise<R> {
    if (this.closed) {
      throw new DurableSessionStoreError(
        "session_store_closed",
        "durable session store is closed",
      );
    }
    if (this.poisoned) {
      throw new DurableSessionStoreError(
        "session_store_poisoned",
        "durable session store cannot authorize checkpoint storage after an append failure",
      );
    }
    await this.lock.assertOwned();
    return action(this.lock);
  }

  async appendEncodedLine(
    encoded: string | Uint8Array,
  ): Promise<DurableAppendReceipt> {
    if (this.closed) {
      throw new DurableSessionStoreError(
        "session_store_closed",
        "durable session store is closed",
      );
    }
    if (this.poisoned) {
      throw new DurableSessionStoreError(
        "session_store_poisoned",
        "durable session store cannot continue after an append failure",
      );
    }

    const eventBytes = normalizeEncodedLine(encoded);
    const lineBytes = Buffer.allocUnsafe(eventBytes.byteLength + 1);
    eventBytes.copy(lineBytes, 0);
    lineBytes[lineBytes.byteLength - 1] = 0x0a;

    try {
      await this.assertOpenFileIdentity();
      const result = await this.handle.write(
        lineBytes,
        0,
        lineBytes.byteLength,
        null,
      );
      if (result.bytesWritten !== lineBytes.byteLength) {
        throw new DurableSessionStoreError(
          "append_write_incomplete",
          "durable session append was incomplete",
        );
      }
      // PHASE9: A successful write only updates kernel buffers. The event may
      // become renderable or authorize a side effect only after this sync has
      // made the one-buffer JSONL append durable.
      await this.handle.sync();
      this.lineCount += 1;
      return { bytes: lineBytes.byteLength, lineNumber: this.lineCount };
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.handle.close();
    if (this.poisoned) {
      throw new DurableSessionStoreError(
        "session_store_poisoned_lock_preserved",
        "append failed; writer lock was preserved for stale-owner recovery",
      );
    }
    await this.lock.release();
  }

  private async assertOpenFileIdentity(): Promise<void> {
    await this.lock.assertOwned();
    await this.policy.assertSessionPathsSafe(this.lock.paths, {
      allowMissingCheckpointDirectory: true,
    });
    const metadata = await this.handle.stat();
    const pathMetadata = await lstat(this.path);
    if (
      metadata.dev !== this.handleIdentity.dev ||
      metadata.ino !== this.handleIdentity.ino ||
      pathMetadata.dev !== this.handleIdentity.dev ||
      pathMetadata.ino !== this.handleIdentity.ino ||
      pathMetadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !pathMetadata.isFile()
    ) {
      throw new DurableSessionStoreError(
        "session_store_poisoned",
        "open session file identity changed before append",
      );
    }
  }
}
