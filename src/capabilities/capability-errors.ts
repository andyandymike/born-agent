export type CapabilityErrorCode =
  | "capability_artifact_integrity_failed"
  | "capability_component_invalid"
  | "capability_conflict"
  | "capability_limit_exceeded"
  | "capability_manifest_invalid"
  | "capability_not_found"
  | "capability_path_invalid"
  | "capability_snapshot_stale"
  | "capability_source_unstable"
  | "capability_source_untrusted"
  | "capability_state_invalid"
  | "plugin_tampered_or_conflicting";

export class CapabilityError extends Error {
  override readonly name = "CapabilityError";

  constructor(
    readonly code: CapabilityErrorCode,
    message: string,
    readonly exitCode: 1 | 2 | 3 | 8 = code === "capability_snapshot_stale" ||
      code === "capability_artifact_integrity_failed" ||
      code === "plugin_tampered_or_conflicting"
      ? 8
      : code === "capability_state_invalid"
        ? 1
        : 2,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function safeCapabilityErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "capability operation failed";
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
