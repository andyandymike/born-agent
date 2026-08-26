import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import {
  currentHostFingerprint,
  currentProcessIdentity,
  NodeProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from "../sessions/process-identity.js";
import { parseStrictJson } from "../system/strict-json.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

const MAX_LOCK_BYTES = 16 * 1024;
// PHASE17: 高负载Windows runner上的cold build可能持锁超过5秒；这里仍保持
// 60秒hard cap和AbortSignal取消，但给一次正常跨进程发布留下足够余量，避免
// 第二个CLI在exact generation即将完成时误报repository_index_busy。
const DEFAULT_WRITER_WAIT_MS = 15_000;

const indexLockRecordSchema = z
  .object({
    createdAt: z.string().datetime({ offset: false }),
    hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    nonce: z.uuid(),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
    rootIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    schemaVersion: z.literal(1),
  })
  .strict();

type RepositoryIndexLockRecord = Readonly<z.infer<typeof indexLockRecordSchema>>;

export interface RepositoryIndexLockOptions {
  readonly hostFingerprint?: string;
  readonly minimumRecoveryAgeMs?: number;
  readonly nonce?: string;
  readonly now?: () => Date;
  readonly ownerProbe?: ProcessIdentityProbe;
  readonly pollIntervalMs?: number;
  readonly processIdentity?: ProcessIdentity;
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
  readonly lockName?: "index.lock" | "lease-gc.lock";
}

export interface RepositoryIndexLockPathPolicy {
  readonly locksRoot: string;
  readonly root: string;
  readonly temporaryRoot: string;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readLock(path: string): Promise<{ readonly bytes: Buffer; readonly record: RepositoryIndexLockRecord }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_LOCK_BYTES) throw new Error("index lock identity is invalid");
    const bytes = await readFile(path);
    const record = indexLockRecordSchema.parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return Object.freeze({ bytes, record });
  } catch (error) {
    throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index lock failed strict validation", 1, { cause: error });
  }
}

async function readContendedLock(path: string): Promise<{
  readonly bytes: Buffer;
  readonly record: RepositoryIndexLockRecord;
} | null> {
  try {
    return await readLock(path);
  } catch (error) {
    // The exclusive-create loser may observe EEXIST immediately before the
    // owner unlinks the lock. A vanished lock is an ordinary acquisition
    // race, not corrupt cache state; every other decode/identity error remains
    // fail-closed.
    if (
      error instanceof RepositoryIntelligenceError &&
      (isCode(error.cause, "ENOENT") || isCode(error.cause, "EPERM"))
    ) return null;
    throw error;
  }
}

async function writeComplete(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("index lock write stalled");
    offset += result.bytesWritten;
  }
}

async function waitBounded(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("index lock wait cancelled");
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("index lock wait cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class RepositoryIndexLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly record: RepositoryIndexLockRecord,
  ) {}

  static async acquire(paths: RepositoryIndexLockPathPolicy, options: RepositoryIndexLockOptions = {}): Promise<RepositoryIndexLock> {
    const lockName = options.lockName ?? "index.lock";
    const path = join(paths.locksRoot, lockName);
    const now = options.now ?? (() => new Date());
    const ownIdentity = options.processIdentity ?? currentProcessIdentity();
    const hostFingerprint = options.hostFingerprint ?? currentHostFingerprint();
    const ownerProbe = options.ownerProbe ?? new NodeProcessIdentityProbe(ownIdentity);
    const signal = options.signal ?? new AbortController().signal;
    const waitMs = options.waitMs ?? DEFAULT_WRITER_WAIT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const minimumRecoveryAgeMs = options.minimumRecoveryAgeMs ?? 30_000;
    for (const [name, value, max] of [["waitMs", waitMs, 60_000], ["pollIntervalMs", pollIntervalMs, 1_000], ["minimumRecoveryAgeMs", minimumRecoveryAgeMs, 24 * 60 * 60 * 1000]] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${name} is outside its bounded range`);
    }
    const rootIdentitySha256 = sha256Canonical({ cacheRoot: paths.root.replaceAll("\\", "/").toLowerCase(), schemaVersion: 1 });
    const record = indexLockRecordSchema.parse({
      createdAt: now().toISOString(),
      hostFingerprint,
      nonce: options.nonce ?? randomUUID(),
      pid: ownIdentity.pid,
      processStartIdentity: ownIdentity.startIdentity,
      rootIdentitySha256,
      schemaVersion: 1,
    });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const deadline = now().getTime() + waitMs;
    // Generic store recovery deliberately does not remove lock candidates:
    // another live process may be waiting with one. The creator owns this
    // unique file and removes it in the finally block below; a crash leaves a
    // harmless unknown temp, which fail-closed recovery preserves.
    const candidate = join(paths.temporaryRoot, `lock-${record.nonce}.tmp`);
    const candidateHandle = await open(candidate, "wx", 0o600);
    try {
      await writeComplete(candidateHandle, bytes);
      await candidateHandle.sync();
    } finally {
      await candidateHandle.close();
    }

    try {
      while (true) {
        if (signal.aborted) throw new RepositoryIntelligenceError("repository_navigation_cancelled", "repository index lock wait was cancelled", 130);
        try {
          // Publish only a complete, synced record. Hard-link create is the
          // no-replace linearization point, so contenders can never observe a
          // zero-byte or partially written owner record.
          await link(candidate, path);
          const lock = new RepositoryIndexLock(path, record);
          await lock.assertOwned();
          return lock;
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
        }

        const existing = await readContendedLock(path);
        if (existing === null) continue;
        if (existing.record.rootIdentitySha256 !== rootIdentitySha256) {
          throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index lock belongs to another cache root");
        }
        let recovered = false;
        if (existing.record.hostFingerprint === hostFingerprint) {
          const owner = await ownerProbe.probe({ pid: existing.record.pid, startIdentity: existing.record.processStartIdentity });
          const age = now().getTime() - Date.parse(existing.record.createdAt);
          if ((owner === "missing" || owner === "different") && Number.isFinite(age) && age >= minimumRecoveryAgeMs) {
            const current = await readFile(path).catch((error: unknown) => {
              if (isCode(error, "ENOENT")) return null;
              throw error;
            });
            if (current === null) continue;
            if (current.equals(existing.bytes)) {
              const stale = join(paths.locksRoot, `.${lockName.slice(0, -5)}.${existing.record.nonce}.stale`);
              try {
                await rename(path, stale);
                recovered = true;
                await unlink(stale).catch(() => undefined);
              } catch (error) {
                if (!isCode(error, "ENOENT") && !isCode(error, "EEXIST")) throw error;
              }
            }
          }
        }
        if (recovered) continue;
        const remaining = deadline - now().getTime();
        if (remaining <= 0 || waitMs === 0) {
          throw new RepositoryIntelligenceError("repository_index_busy", "repository index already has an active or unresolved writer", 8);
        }
        try {
          await waitBounded(Math.min(pollIntervalMs, remaining), signal);
        } catch (error) {
          throw new RepositoryIntelligenceError("repository_navigation_cancelled", "repository index lock wait was cancelled", 130, { cause: error });
        }
      }
    } finally {
      await unlink(candidate).catch(() => undefined);
    }
  }

  async assertOwned(): Promise<void> {
    if (this.released) throw new RepositoryIntelligenceError("repository_index_busy", "repository index lock has already been released");
    const current = await readLock(this.path);
    if (
      current.record.nonce !== this.record.nonce ||
      current.record.processStartIdentity !== this.record.processStartIdentity ||
      current.record.rootIdentitySha256 !== this.record.rootIdentitySha256
    ) throw new RepositoryIntelligenceError("repository_index_busy", "repository index lock ownership changed");
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.assertOwned();
    await unlink(this.path);
    this.released = true;
  }
}
