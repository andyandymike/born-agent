import { createHash } from "node:crypto";
import { hostname } from "node:os";

export interface ProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
}

export type ProcessIdentityProbeResult =
  | "different"
  | "matching"
  | "missing"
  | "unknown";

export interface ProcessIdentityProbe {
  probe(identity: ProcessIdentity): Promise<ProcessIdentityProbeResult>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const MODULE_PROCESS_START_EPOCH_MS = Math.max(
  0,
  Math.trunc(Date.now() - process.uptime() * 1_000),
);

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export function currentHostFingerprint(): string {
  return sha256(
    `${hostname().normalize("NFC").toLowerCase()}\0${process.platform}\0${process.arch}`,
  );
}

export function currentProcessIdentity(
  nowEpochMs?: number,
  uptimeSeconds?: number,
): ProcessIdentity {
  const approximateStartEpochMs =
    nowEpochMs === undefined && uptimeSeconds === undefined
      ? MODULE_PROCESS_START_EPOCH_MS
      : Math.max(
          0,
          Math.trunc(
            (nowEpochMs ?? Date.now()) -
              (uptimeSeconds ?? process.uptime()) * 1_000,
          ),
        );
  return {
    pid: process.pid,
    startIdentity: sha256(
      `${currentHostFingerprint()}\0${process.pid}\0${approximateStartEpochMs}`,
    ),
  };
}

export class NodeProcessIdentityProbe implements ProcessIdentityProbe {
  constructor(
    private readonly ownIdentity: ProcessIdentity = currentProcessIdentity(),
  ) {}

  async probe(identity: ProcessIdentity): Promise<ProcessIdentityProbeResult> {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
      return "unknown";
    }
    if (identity.pid === this.ownIdentity.pid) {
      return identity.startIdentity === this.ownIdentity.startIdentity
        ? "matching"
        : "different";
    }

    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if (isErrorCode(error, "ESRCH")) {
        return "missing";
      }
      return "unknown";
    }

    // Node can prove that a PID exists, but on Windows it cannot read the
    // process creation identity without an OS-specific trusted adapter. PID
    // liveness alone must not be treated as ownership proof after PID reuse.
    return "unknown";
  }
}
