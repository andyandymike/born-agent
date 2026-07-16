import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename } from "node:path";

import {
  currentHostFingerprint,
  currentProcessIdentity,
  NodeProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
  type ProcessIdentityProbeResult,
} from "./process-identity.js";
import {
  assertCanonicalSessionId,
  type SessionStoragePaths,
} from "./session-path-policy.js";
import type { SessionPathPolicy } from "./session-path-policy.js";
import {
  NodeRenameDurabilityPort,
  type RenameDurabilityPort,
} from "./rename-durability.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const LOCK_BYTES_LIMIT = 16 * 1_024;

export interface SessionLockRecord {
  readonly createdAt: string;
  readonly hostFingerprint: string;
  readonly nonce: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly sessionId: string;
}

export type LockOwnerDisposition =
  | "active"
  | "stale"
  | "too_young"
  | "unknown";

export interface LockOwnerAssessment {
  readonly disposition: LockOwnerDisposition;
  readonly processResult: ProcessIdentityProbeResult | "not_probed";
}

export interface SessionLockRecovery {
  readonly previousNonce: string;
  readonly staleFileName: string;
}

export interface SessionLockAcquireOptions {
  readonly allowStaleRecovery?: boolean;
  readonly hostFingerprint?: string;
  readonly minimumStaleAgeMs?: number;
  readonly nonce?: string;
  readonly now?: () => Date;
  readonly ownerProbe?: ProcessIdentityProbe;
  readonly processIdentity?: ProcessIdentity;
  readonly renameDurability?: RenameDurabilityPort;
}

export class SessionLockError extends Error {
  constructor(
    readonly code:
      | "active_session_lock"
      | "invalid_session_lock"
      | "lock_identity_changed"
      | "lock_not_owned"
      | "lock_too_young"
      | "lock_write_incomplete"
      | "unknown_session_lock_owner",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SessionLockError";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalIsoTimestamp(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function parseLockRecord(bytes: Uint8Array): SessionLockRecord {
  if (bytes.byteLength === 0 || bytes.byteLength > LOCK_BYTES_LIMIT) {
    throw new SessionLockError(
      "invalid_session_lock",
      "session lock has an invalid size",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new SessionLockError(
      "invalid_session_lock",
      "session lock is not valid UTF-8 JSON",
      { cause: error },
    );
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.createdAt !== "string" ||
    !canonicalIsoTimestamp(parsed.createdAt) ||
    typeof parsed.hostFingerprint !== "string" ||
    !SHA256.test(parsed.hostFingerprint) ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.processStartIdentity !== "string" ||
    !SHA256.test(parsed.processStartIdentity) ||
    typeof parsed.sessionId !== "string"
  ) {
    throw new SessionLockError(
      "invalid_session_lock",
      "session lock fields are invalid",
    );
  }

  try {
    assertCanonicalSessionId(parsed.nonce);
    assertCanonicalSessionId(parsed.sessionId);
  } catch (error) {
    throw new SessionLockError(
      "invalid_session_lock",
      "session lock UUID fields are invalid",
      { cause: error },
    );
  }

  return {
    createdAt: parsed.createdAt,
    hostFingerprint: parsed.hostFingerprint,
    nonce: parsed.nonce,
    pid: parsed.pid,
    processStartIdentity: parsed.processStartIdentity,
    sessionId: parsed.sessionId,
  };
}

async function writeComplete(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const result = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (result.bytesWritten !== bytes.byteLength) {
    throw new SessionLockError(
      "lock_write_incomplete",
      "session lock write was incomplete",
    );
  }
}

export async function assessSessionLockOwner(
  record: SessionLockRecord,
  options: {
    readonly currentHostFingerprint: string;
    readonly minimumStaleAgeMs: number;
    readonly now: Date;
    readonly ownerProbe: ProcessIdentityProbe;
  },
): Promise<LockOwnerAssessment> {
  if (record.hostFingerprint !== options.currentHostFingerprint) {
    return { disposition: "unknown", processResult: "not_probed" };
  }

  const processResult = await options.ownerProbe.probe({
    pid: record.pid,
    startIdentity: record.processStartIdentity,
  });
  if (processResult === "matching") {
    return { disposition: "active", processResult };
  }
  if (processResult === "missing" || processResult === "different") {
    const age = options.now.getTime() - Date.parse(record.createdAt);
    if (!Number.isFinite(age) || age < options.minimumStaleAgeMs) {
      return { disposition: "too_young", processResult };
    }
    return { disposition: "stale", processResult };
  }
  return { disposition: "unknown", processResult };
}

export class SessionLock {
  readonly nonce: string;
  readonly paths: SessionStoragePaths;
  readonly record: SessionLockRecord;
  readonly recovery: SessionLockRecovery | undefined;
  private released = false;

  private constructor(
    private readonly policy: SessionPathPolicy,
    paths: SessionStoragePaths,
    record: SessionLockRecord,
    recovery: SessionLockRecovery | undefined,
  ) {
    this.nonce = record.nonce;
    this.paths = paths;
    this.record = record;
    this.recovery = recovery;
  }

  static async acquire(
    policy: SessionPathPolicy,
    sessionId: string,
    options: SessionLockAcquireOptions = {},
  ): Promise<SessionLock> {
    assertCanonicalSessionId(sessionId);
    const paths = await policy.prepareSession(sessionId);
    const now = options.now ?? (() => new Date());
    const processIdentity = options.processIdentity ?? currentProcessIdentity();
    const hostFingerprint = options.hostFingerprint ?? currentHostFingerprint();
    const nonce = options.nonce ?? randomUUID();
    assertCanonicalSessionId(nonce);
    const ownerProbe =
      options.ownerProbe ?? new NodeProcessIdentityProbe(processIdentity);
    const minimumStaleAgeMs = options.minimumStaleAgeMs ?? 30_000;
    const allowStaleRecovery = options.allowStaleRecovery ?? true;
    const renameDurability =
      options.renameDurability ?? new NodeRenameDurabilityPort();
    if (!Number.isSafeInteger(minimumStaleAgeMs) || minimumStaleAgeMs < 0) {
      throw new RangeError("minimumStaleAgeMs must be a non-negative integer");
    }

    const record: SessionLockRecord = {
      createdAt: now().toISOString(),
      hostFingerprint,
      nonce,
      pid: processIdentity.pid,
      processStartIdentity: processIdentity.startIdentity,
      sessionId,
    };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let recovery: SessionLockRecovery | undefined;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await policy.assertSessionPathsSafe(paths, {
        allowMissingCheckpointDirectory: true,
      });
      let handle: FileHandle | undefined;
      try {
        handle = await open(paths.lockFilePath, "wx", 0o600);
        await writeComplete(handle, encoded);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await policy.assertSessionPathsSafe(paths, {
          allowMissingCheckpointDirectory: true,
        });
        return new SessionLock(policy, paths, record, recovery);
      } catch (error) {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
          await SessionLock.removeMatchingLock(paths.lockFilePath, record).catch(
            () => undefined,
          );
        }
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
      }

      if (!allowStaleRecovery) {
        throw new SessionLockError(
          "active_session_lock",
          "session has an active or unresolved writer lock",
        );
      }
      const existingBytes = await readFile(paths.lockFilePath);
      const existing = parseLockRecord(existingBytes);
      if (existing.sessionId !== sessionId) {
        throw new SessionLockError(
          "invalid_session_lock",
          "session lock belongs to a different session",
        );
      }
      const assessment = await assessSessionLockOwner(existing, {
        currentHostFingerprint: hostFingerprint,
        minimumStaleAgeMs,
        now: now(),
        ownerProbe,
      });
      if (assessment.disposition === "active") {
        throw new SessionLockError(
          "active_session_lock",
          "session already has an active writer",
        );
      }
      if (assessment.disposition === "too_young") {
        throw new SessionLockError(
          "lock_too_young",
          "session lock is too young for stale recovery",
        );
      }
      if (assessment.disposition === "unknown") {
        throw new SessionLockError(
          "unknown_session_lock_owner",
          "session lock owner cannot be proven inactive",
        );
      }

      // PHASE9: Lock age is only a guard against startup races. Recovery also
      // needs same-host process-start proof; an old mtime alone never proves
      // that the owner died or that a reused PID belongs to it.
      const currentBytes = await readFile(paths.lockFilePath);
      if (!currentBytes.equals(existingBytes)) {
        throw new SessionLockError(
          "lock_identity_changed",
          "session lock changed during stale-owner assessment",
        );
      }
      const stalePath = `${paths.lockFilePath}.stale.${now().getTime()}.${existing.nonce}`;
      try {
        await renameDurability.install(
          paths.lockFilePath,
          stalePath,
          existingBytes,
        );
      } catch (error) {
        if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }
      recovery = {
        previousNonce: existing.nonce,
        staleFileName: basename(stalePath),
      };
    }

    throw new SessionLockError(
      "unknown_session_lock_owner",
      "session lock acquisition did not converge",
    );
  }

  async assertOwned(): Promise<void> {
    if (this.released) {
      throw new SessionLockError(
        "lock_not_owned",
        "session lock has already been released",
      );
    }
    await this.policy.assertSessionPathsSafe(this.paths, {
      allowMissingCheckpointDirectory: true,
    });
    const existing = parseLockRecord(await readFile(this.paths.lockFilePath));
    if (
      existing.nonce !== this.record.nonce ||
      existing.sessionId !== this.record.sessionId ||
      existing.processStartIdentity !== this.record.processStartIdentity
    ) {
      throw new SessionLockError(
        "lock_not_owned",
        "session lock ownership changed",
      );
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    await this.assertOwned();
    await unlink(this.paths.lockFilePath);
    this.released = true;
  }

  private static async removeMatchingLock(
    path: string,
    expected: SessionLockRecord,
  ): Promise<void> {
    let existing: SessionLockRecord;
    try {
      existing = parseLockRecord(await readFile(path));
    } catch {
      return;
    }
    if (
      existing.nonce === expected.nonce &&
      existing.sessionId === expected.sessionId &&
      existing.processStartIdentity === expected.processStartIdentity
    ) {
      await unlink(path);
    }
  }
}
