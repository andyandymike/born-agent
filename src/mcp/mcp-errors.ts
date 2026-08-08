export type McpCoreErrorCode =
  | "mcp_action_invalid"
  | "mcp_capability_not_negotiated"
  | "mcp_catalog_changed"
  | "mcp_catalog_invalid"
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
  | "mcp_primitive_effect_unknown"
  | "mcp_prompt_arguments_invalid"
  | "mcp_prompt_catalog_stale"
  | "mcp_prompt_content_unsupported"
  | "mcp_prompt_not_found"
  | "mcp_prompt_user_control_required"
  | "mcp_protocol_version_unsupported"
  | "mcp_resource_catalog_stale"
  | "mcp_resource_content_invalid"
  | "mcp_resource_limit_exceeded"
  | "mcp_resource_not_found"
  | "mcp_resource_read_denied"
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
