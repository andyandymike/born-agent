export type BackgroundErrorCode =
  | "background_executable_unsealed"
  | "worker_cleanup_failed"
  | "worker_control_stale"
  | "worker_handoff_conflict"
  | "worker_handshake_timeout"
  | "worker_launch_stale"
  | "worker_owner_active"
  | "worker_owner_unknown"
  | "worker_protocol_mismatch"
  | "worker_reconciliation_required"
  | "worker_unresponsive"
  | "worker_waiting_for_user";

const exitCodes: Readonly<Record<BackgroundErrorCode, 1 | 2 | 3 | 8>> = Object.freeze({
  background_executable_unsealed: 3,
  worker_cleanup_failed: 8,
  worker_control_stale: 8,
  worker_handoff_conflict: 8,
  worker_handshake_timeout: 1,
  worker_launch_stale: 8,
  worker_owner_active: 8,
  worker_owner_unknown: 8,
  worker_protocol_mismatch: 2,
  worker_reconciliation_required: 8,
  worker_unresponsive: 8,
  worker_waiting_for_user: 8,
});

export class BackgroundError extends Error {
  override readonly name = "BackgroundError";
  readonly exitCode: 1 | 2 | 3 | 8;

  constructor(readonly code: BackgroundErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.exitCode = exitCodes[code];
  }
}
