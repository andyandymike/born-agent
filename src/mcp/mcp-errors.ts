export type McpCoreErrorCode =
  | "mcp_action_invalid"
  | "mcp_catalog_changed"
  | "mcp_catalog_collision"
  | "mcp_catalog_limit"
  | "mcp_config_invalid"
  | "mcp_config_missing"
  | "mcp_config_path_unsafe"
  | "mcp_config_too_large"
  | "mcp_environment_missing"
  | "mcp_executable_changed"
  | "mcp_executable_missing"
  | "mcp_executable_unsafe"
  | "mcp_integrity_changed"
  | "mcp_integrity_invalid"
  | "mcp_integrity_limit"
  | "mcp_lifecycle_invalid"
  | "mcp_permission_denied"
  | "mcp_approval_denied"
  | "mcp_protocol_failed"
  | "mcp_spawn_identity_missing"
  | "mcp_start_failed"
  | "mcp_effect_unknown"
  | "mcp_result_content_unsupported"
  | "mcp_result_invalid"
  | "mcp_result_limit"
  | "mcp_schema_compile_failed"
  | "mcp_schema_invalid"
  | "mcp_schema_limit"
  | "mcp_schema_ref_unsafe"
  | "mcp_tool_name_invalid";

export class McpCoreError extends Error {
  public constructor(
    public readonly code: McpCoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "McpCoreError";
  }
}
