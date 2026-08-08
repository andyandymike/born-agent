export type PluginLifecycleErrorCode =
  | "plugin_source_invalid"
  | "plugin_install_invalid"
  | "plugin_digest_mismatch"
  | "plugin_store_busy"
  | "plugin_store_corrupt"
  | "plugin_already_installed"
  | "plugin_not_installed"
  | "plugin_enable_confirmation_required"
  | "plugin_enablement_conflict"
  | "plugin_enablement_stale"
  | "plugin_active_lease"
  | "plugin_remove_requires_disable"
  | "plugin_gc_degraded"
  | "plugin_tampered"
  | "plugin_operation_incomplete";

export class PluginLifecycleError extends Error {
  override readonly name = "PluginLifecycleError";

  constructor(
    readonly code: PluginLifecycleErrorCode,
    message: string,
    readonly exitCode: 1 | 2 | 8 =
      code === "plugin_store_corrupt" || code === "plugin_operation_incomplete"
        ? 1
        : code === "plugin_tampered" ||
            code === "plugin_active_lease" ||
            code === "plugin_enablement_stale"
          ? 8
          : 2,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

