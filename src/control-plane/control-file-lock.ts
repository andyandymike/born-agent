import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";
import {
  currentHostFingerprint,
  currentProcessIdentity,
  NodeProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from "../sessions/process-identity.js";
import { parseStrictJson } from "../system/strict-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type { ControlStatePaths } from "./control-state-paths.js";

const lockRecordSchema = z.object({
  acquiredAt: z.string().datetime({ offset: true }),
  hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  lockId: z.string().uuid(),
  lockKeySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pid: z.number().int().positive(),
  processStartIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
}).strict();

type ControlFileLockRecordV1 = Readonly<z.infer<typeof lockRecordSchema>>;

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRecord(path: string): Promise<{
  readonly bytes: Buffer;
  readonly record: ControlFileLockRecordV1;
}> {
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > 8 * 1024) {
    throw new ApplicationControlError("control_operation_corrupt", "control lock has an invalid byte length");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
    return { bytes, record: lockRecordSchema.parse(parseStrictJson(text)) };
  } catch (error) {
    throw new ApplicationControlError("control_operation_corrupt", "control lock is invalid", { cause: error });
  }
}

export class ControlFileLock {
  private released = false;

  private constructor(
    private readonly bytes: Buffer,
    readonly path: string,
    readonly record: ControlFileLockRecordV1,
  ) {}

  static async acquire(input: {
    readonly keySha256: string;
    readonly maximumWaitMs?: number;
    readonly minimumStaleAgeMs?: number;
    readonly now?: () => Date;
    readonly paths: ControlStatePaths;
    readonly processIdentity?: ProcessIdentity;
    readonly processProbe?: ProcessIdentityProbe;
  }): Promise<ControlFileLock> {
    if (!/^[a-f0-9]{64}$/u.test(input.keySha256)) {
      throw new TypeError("control lock key must be a SHA-256 digest");
    }
    const path = join(input.paths.lockRoot, `${input.keySha256}.lock`);
    await input.paths.assertSafe(path);
    const now = input.now ?? (() => new Date());
    const own = input.processIdentity ?? currentProcessIdentity();
    const probe = input.processProbe ?? new NodeProcessIdentityProbe(own);
    const maximumWaitMs = input.maximumWaitMs ?? 2_000;
    const minimumStaleAgeMs = input.minimumStaleAgeMs ?? 30_000;
    const started = Date.now();

    for (;;) {
      const record = lockRecordSchema.parse({
        acquiredAt: now().toISOString(),
        hostFingerprint: currentHostFingerprint(),
        lockId: randomUUID(),
        lockKeySha256: input.keySha256,
        pid: own.pid,
        processStartIdentity: own.startIdentity,
        schemaVersion: 1,
      });
      const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      let handle;
      try {
        handle = await open(path, "wx", 0o600);
        const result = await handle.write(bytes, 0, bytes.byteLength, 0);
        if (result.bytesWritten !== bytes.byteLength) {
          throw new ApplicationControlError("control_operation_corrupt", "control lock write was incomplete");
        }
        await handle.sync();
        return new ControlFileLock(bytes, path, record);
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          await unlink(path).catch(() => undefined);
          if (error instanceof ApplicationControlError) throw error;
          throw new ApplicationControlError("control_operation_busy", "control lock could not be acquired", { cause: error });
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }

      let existing: Awaited<ReturnType<typeof readRecord>>;
      try {
        existing = await readRecord(path);
      } catch (error) {
        // The winner may release between our EEXIST observation and read.
        // That is ordinary lock turnover, not a corrupt lock record.
        if (isCode(error, "ENOENT")) continue;
        throw error;
      }
      if (existing.record.lockKeySha256 !== input.keySha256) {
        throw new ApplicationControlError("control_operation_corrupt", "control lock belongs to another key");
      }
      let stale = false;
      if (existing.record.hostFingerprint === currentHostFingerprint()) {
        const assessment = await probe.probe({
          pid: existing.record.pid,
          startIdentity: existing.record.processStartIdentity,
        });
        const age = now().getTime() - Date.parse(existing.record.acquiredAt);
        stale = (assessment === "missing" || assessment === "different") && age >= minimumStaleAgeMs;
      }
      if (stale) {
        let current: Buffer;
        try {
          current = await readFile(path);
        } catch (error) {
          if (isCode(error, "ENOENT")) continue;
          throw error;
        }
        if (!current.equals(existing.bytes)) continue;
        try {
          await rename(path, `${path}.stale.${now().getTime()}.${existing.record.lockId}`);
          continue;
        } catch (error) {
          if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) continue;
          throw new ApplicationControlError("control_operation_busy", "stale control lock could not be quarantined", { cause: error });
        }
      }
      if (Date.now() - started >= maximumWaitMs) {
        throw new ApplicationControlError("control_operation_busy", "control operation is owned by another process");
      }
      await delay(5);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    const current = await readFile(this.path);
    if (!current.equals(this.bytes)) {
      throw new ApplicationControlError("control_operation_corrupt", "control lock identity changed before release");
    }
    await unlink(this.path);
    this.released = true;
  }
}

export async function withControlFileLock<T>(
  input: Parameters<typeof ControlFileLock.acquire>[0],
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await ControlFileLock.acquire(input);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
