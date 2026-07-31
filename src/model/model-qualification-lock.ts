import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  currentHostFingerprint,
  currentProcessIdentity,
  NodeProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from "../sessions/process-identity.js";
import { parseStrictJson } from "../system/strict-json.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LOCK_BYTES = 16 * 1_024;

const lockRecordSchema = z
  .object({
    createdAt: z.string().refine((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    }),
    hostFingerprint: z.string().regex(SHA256),
    identitySha256: z.string().regex(SHA256),
    nonce: z.uuid(),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().regex(SHA256),
    schemaVersion: z.literal(1),
  })
  .strict();

type QualificationLockRecord = Readonly<z.infer<typeof lockRecordSchema>>;

export interface ModelQualificationLockOptions {
  readonly hostFingerprint?: string;
  readonly minimumRecoveryAgeMs?: number;
  readonly nonce?: string;
  readonly now?: () => Date;
  readonly ownerProbe?: ProcessIdentityProbe;
  readonly processIdentity?: ProcessIdentity;
}

export class ModelQualificationLockError extends Error {
  override readonly name = "ModelQualificationLockError";

  constructor(
    readonly code:
      | "qualification_busy"
      | "qualification_lock_invalid"
      | "qualification_lock_not_owned"
      | "qualification_lock_write_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function readLock(path: string): Promise<{
  readonly bytes: Buffer;
  readonly record: QualificationLockRecord;
}> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > MAX_LOCK_BYTES
    ) {
      throw new Error("qualification lock is not a bounded regular file");
    }
    const bytes = await readFile(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { bytes, record: lockRecordSchema.parse(parseStrictJson(text)) };
  } catch (error) {
    if (error instanceof ModelQualificationLockError) throw error;
    throw new ModelQualificationLockError(
      "qualification_lock_invalid",
      "qualification lock failed strict validation",
      { cause: error },
    );
  }
}

async function writeComplete(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesWritten <= 0) {
      throw new ModelQualificationLockError(
        "qualification_lock_write_failed",
        "qualification lock write stalled",
      );
    }
    offset += result.bytesWritten;
  }
}

export class ModelQualificationLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly record: QualificationLockRecord,
    private readonly recoveredPath: string | null,
  ) {}

  static async acquire(
    root: string,
    identitySha256: string,
    options: ModelQualificationLockOptions = {},
  ): Promise<ModelQualificationLock> {
    if (!SHA256.test(identitySha256)) {
      throw new TypeError("qualification lock identity must be lowercase SHA-256");
    }
    const path = join(root, `${identitySha256}.lock`);
    const now = options.now ?? (() => new Date());
    const ownIdentity = options.processIdentity ?? currentProcessIdentity();
    const hostFingerprint = options.hostFingerprint ?? currentHostFingerprint();
    const ownerProbe = options.ownerProbe ?? new NodeProcessIdentityProbe(ownIdentity);
    const minimumRecoveryAgeMs = options.minimumRecoveryAgeMs ?? 30_000;
    if (
      !Number.isSafeInteger(minimumRecoveryAgeMs) ||
      minimumRecoveryAgeMs < 0
    ) {
      throw new RangeError("minimumRecoveryAgeMs must be a non-negative integer");
    }
    const record = lockRecordSchema.parse({
      createdAt: now().toISOString(),
      hostFingerprint,
      identitySha256,
      nonce: options.nonce ?? randomUUID(),
      pid: ownIdentity.pid,
      processStartIdentity: ownIdentity.startIdentity,
      schemaVersion: 1,
    });
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let recoveredPath: string | null = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, "wx", 0o600);
        await writeComplete(handle, encoded);
        await handle.sync();
        await handle.close();
        handle = undefined;
        const lock = new ModelQualificationLock(path, record, recoveredPath);
        await lock.assertOwned();
        if (recoveredPath !== null) await unlink(recoveredPath).catch(() => undefined);
        return lock;
      } catch (error) {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
          await unlink(path).catch(() => undefined);
        }
        if (!isErrorCode(error, "EEXIST")) throw error;
      }

      const existing = await readLock(path);
      if (existing.record.identitySha256 !== identitySha256) {
        throw new ModelQualificationLockError(
          "qualification_lock_invalid",
          "qualification lock belongs to another identity",
        );
      }
      if (existing.record.hostFingerprint !== hostFingerprint) {
        throw new ModelQualificationLockError(
          "qualification_busy",
          "qualification lock owner cannot be proven inactive",
        );
      }
      const owner = await ownerProbe.probe({
        pid: existing.record.pid,
        startIdentity: existing.record.processStartIdentity,
      });
      if (owner === "matching" || owner === "unknown") {
        throw new ModelQualificationLockError(
          "qualification_busy",
          "qualification is already active or its owner is unresolved",
        );
      }
      const age = now().getTime() - Date.parse(existing.record.createdAt);
      if (!Number.isFinite(age) || age < minimumRecoveryAgeMs) {
        throw new ModelQualificationLockError(
          "qualification_busy",
          "dead-owner proof exists but the lock is inside the startup race window",
        );
      }
      const current = await readFile(path);
      if (!current.equals(existing.bytes)) {
        throw new ModelQualificationLockError(
          "qualification_busy",
          "qualification lock changed during owner assessment",
        );
      }
      const stale = join(root, `.${identitySha256}.${existing.record.nonce}.stale`);
      try {
        await rename(path, stale);
        recoveredPath = stale;
      } catch (error) {
        if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EEXIST")) continue;
        throw error;
      }
    }
    throw new ModelQualificationLockError(
      "qualification_busy",
      "qualification lock acquisition did not converge",
    );
  }

  async assertOwned(): Promise<void> {
    if (this.released) {
      throw new ModelQualificationLockError(
        "qualification_lock_not_owned",
        "qualification lock has already been released",
      );
    }
    const current = await readLock(this.path);
    if (
      current.record.nonce !== this.record.nonce ||
      current.record.identitySha256 !== this.record.identitySha256 ||
      current.record.processStartIdentity !== this.record.processStartIdentity
    ) {
      throw new ModelQualificationLockError(
        "qualification_lock_not_owned",
        "qualification lock ownership changed",
      );
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.assertOwned();
    await unlink(this.path);
    this.released = true;
  }
}
