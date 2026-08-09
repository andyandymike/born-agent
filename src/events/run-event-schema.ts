import { z } from "zod";

import { persistedCompletionEvidenceSchema } from "../completion/completion-evidence-schema.js";
import { persistedDockerExecutionImageIdentitySchema } from "../execution/docker/acquisition/docker-image-identity.js";
import { persistedRuntimePolicyEvidenceSchema } from "../policy/policy-evidence.js";
import { persistedCapabilitySnapshotBindingSchema } from "../capabilities/capability-snapshot.js";

// PHASE2: RunEvent 是 BornAgent 自己的长期存储协议。
// TypeScript 只能检查编译期代码，Zod 还会检查 SDK 数据、磁盘 JSONL 和未来读回的数据。
const uuidSchema = z.string().uuid();
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const callIdSchema = z.string().min(1).max(200);
const stableIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const providerIdSchema = stableIdentifierSchema;
const mcpServerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const incompleteReasonSchema = z.enum([
  "verification_missing",
  "verification_failed",
  "verification_stale",
  "verification_inputs_unknown",
  "diff_check_failed",
  "source_state_changed",
  "change_journal_inconsistent",
  "pending_effect",
  "task_blocked",
  "completion_signal_required",
  "no_changes_for_coding_task",
  "clarification_required",
  "plan_approval_required",
  "plan_incomplete",
]);
const utf8StringWithin = (maximumBytes: number) =>
  z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      `must not exceed ${maximumBytes} UTF-8 bytes`,
    );
const relativePathSchema = utf8StringWithin(4096).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes(".."),
  "must be a normalized relative path",
);
const relativeCwdSchema = utf8StringWithin(4096).refine(
  (value) =>
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
  "must be a normalized workspace-relative directory",
);
const commonEnvelope = {
  // PHASE2: 每种事件共享同一个 envelope，data 才是不同事件的载荷。
  // schema_version 支持未来迁移；seq 用于发现丢失、乱序或重复写入。
  event_id: uuidSchema,
  run_id: uuidSchema,
  schema_version: z.literal(1),
  seq: z.number().int().positive(),
  session_id: uuidSchema,
  timestamp: timestampSchema,
};

const inputSchema = z
  .object({ role: z.literal("user"), text: z.string() })
  .strict();
const workspaceResumeFingerprintSchema = z
  .object({
    backend: z
      .object({
        adapter: z.string().min(1).max(200),
        adapter_version: z.string().min(1).max(200),
        config_fingerprint: sha256Schema,
        model: z.string().min(1),
        provider: providerIdSchema,
      })
      .strict(),
    canonical_root_identity: sha256Schema,
    capability_snapshot_sha256: sha256Schema.optional(),
    checkpoint_codec_version: stableIdentifierSchema.nullable(),
    completion_schema_sha256: sha256Schema,
    policy_sha256: sha256Schema,
    source_state: z
      .object({
        git_head_sha256: sha256Schema,
        git_index_sha256: sha256Schema,
        source_state_sha256: sha256Schema,
      })
      .strict(),
    system_instructions_sha256: sha256Schema,
    task_profile: z.enum(["read-only", "coding"]),
    tool_schema_sha256: sha256Schema,
  })
  .strict();
const commonRunStartedData = {
  capability_snapshot: persistedCapabilitySnapshotBindingSchema.optional(),
  input: inputSchema,
  model: z.string().min(1),
  // PHASE8: provider ids are registry-owned strings; the event protocol must not
  // grow a new hard-coded enum branch whenever a backend adapter is registered.
  provider: providerIdSchema,
  tools: z.array(toolNameSchema).optional(),
  tools_enabled: z.boolean().optional(),
  workspace: z.string().min(1),
  // PHASE9: a resumed CLI process is a new run. These optional fields preserve
  // strict v1 replay while letting v2 storage explain which earlier run and
  // explicitly selected resume mode produced the new run.
  resume_mode: z.enum(["exact", "canonical_degraded"]).optional(),
  resume_of_run_id: uuidSchema.optional(),
  workspace_fingerprint: sha256Schema.optional(),
  workspace_resume_fingerprint: workspaceResumeFingerprintSchema.optional(),
  runtime_policy: persistedRuntimePolicyEvidenceSchema.optional(),
  task_node_binding: z.object({
    attempt_id: uuidSchema,
    attempt_number: z.number().int().min(1).max(3),
    graph_id: uuidSchema,
    graph_revision: positiveInteger,
    graph_sha256: sha256Schema,
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    scheduler_lease_nonce_sha256: sha256Schema,
  }).strict().optional(),
};
const chatRunStartedDataSchema = z
  .object({
    ...commonRunStartedData,
    command: z.literal("chat"),
    timeout_ms: nonnegativeInteger,
  })
  .strict();
const agentRunStartedDataSchema = z
  .object({
    ...commonRunStartedData,
    command: z.literal("agent"),
    // PHASE5: optional preserves replay of schema v1 Phase 4 sessions; all new agent runs emit it.
    edit_approval: z.enum(["ask", "deny"]).optional(),
    // PHASE6: command controls stay optional so schema v1 Phase 0-5 JSONL remains replayable.
    command_approval: z.enum(["ask", "deny"]).optional(),
    command_timeout_ms: positiveInteger.optional(),
    completion_policy: z.literal("verified").optional(),
    executor: z.enum(["local", "docker"]).optional(),
    docker_sandbox: z
      .object({
        image: utf8StringWithin(500).refine(
          (value) =>
            /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u.test(
              value,
            ),
          "Docker image must be an immutable digest or config image ID",
        ),
        image_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        image_identity: persistedDockerExecutionImageIdentitySchema.optional(),
        artifact_contract: z
          .object({
            artifact_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
            expected_lockfile_sha256: sha256Schema,
            image_path: utf8StringWithin(2_048).min(1),
            runtime: utf8StringWithin(200).min(1),
            runtime_version: utf8StringWithin(200).min(1),
            supports_c_utf8: z.boolean(),
            wrapper_sha256: sha256Schema,
          })
          .strict()
          .optional(),
        limits: z
          .object({
            cpus: z.number().min(0.25).max(8),
            memory_mib: z.number().int().min(256).max(8_192),
            pids: z.number().int().min(32).max(1_024),
            tmp_mib: z.number().int().min(16).max(1_024),
          })
          .strict(),
        network: z.literal("none"),
        snapshot_mode: z.literal("disposable_copy"),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.image_identity?.kind === "trusted_local_build") {
          if (
            value.image !== value.image_identity.config_image_id ||
            value.image_digest !== value.image_identity.config_image_id ||
            value.artifact_contract?.artifact_id !==
              value.image_identity.artifact_id ||
            value.artifact_contract.expected_lockfile_sha256 !==
              value.image_identity.artifact_lock_sha256
          ) {
            context.addIssue({
              code: "custom",
              message:
                "trusted local Docker build evidence must exact-match its artifact contract",
            });
          }
        }
      })
      .optional(),
    max_duration_ms: positiveInteger,
    max_command_output_bytes: positiveInteger.optional(),
    max_steps: positiveInteger,
    max_tokens: positiveInteger,
    mcp_servers: z
      .array(mcpServerIdSchema)
      .max(4)
      .refine((values) => new Set(values).size === values.length, "MCP server ids must be unique")
      .optional(),
    max_tool_output_bytes: positiveInteger,
    request_timeout_ms: positiveInteger,
    report_format: z.enum(["text", "json"]).optional(),
    provider_source: z
      .enum(["in_process_test", "local_ollama", "provider_network"])
      .optional(),
    require_verification: z.literal("auto").optional(),
    // PHASE7: optional only keeps Phase 0-6 schema-v1 logs replayable; new agent runs persist the profile explicitly.
    task_profile: z.enum(["read-only", "coding"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.executor === "docker") !== (value.docker_sandbox !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "docker executor must carry Docker sandbox run evidence",
      });
    }
  });
const runStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z.discriminatedUnion("command", [
      chatRunStartedDataSchema,
      agentRunStartedDataSchema,
    ]),
    type: z.literal("run.started"),
  })
  .strict();

const backendCapabilitiesSchema = z
  .object({
    cancellation: z.enum(["abort_signal", "unsupported"]),
    reasoning: z.enum(["opaque_passthrough", "none"]),
    streaming: z.literal(true),
    tools: z.enum(["strict", "best_effort", "none"]),
    usage: z.enum(["complete", "partial", "none"]),
  })
  .strict();

const backendSelectedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        adapter: z.string().min(1).max(200),
        adapter_version: z.string().min(1).max(200),
        capabilities: backendCapabilitiesSchema,
        config_fingerprint: sha256Schema,
        checkpoint_codec_version: stableIdentifierSchema.optional(),
        model: z.string().min(1),
        provider: providerIdSchema,
        // PHASE9: capability is persisted rather than inferred from an adapter
        // name. Missing remains legal only for historical Phase 0-8 sessions.
        resume_capability: z
          .enum(["exact_checkpoint", "canonical_only", "none"])
          .optional(),
      })
      .strict(),
    type: z.literal("backend.selected"),
  })
  .strict();

const textDeltaSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        delta: z.string().min(1),
        // PHASE7: coding prose is evidence of a model candidate, not user-visible proof of completion.
        visibility: z.enum(["user", "internal_candidate"]).optional(),
      })
      .strict(),
    type: z.literal("text.delta"),
  })
  .strict();

const usageSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        cached_input_tokens: nonnegativeInteger.optional(),
        input_tokens: nonnegativeInteger,
        model_turns: positiveInteger.optional(),
        output_tokens: nonnegativeInteger,
        total_tokens: nonnegativeInteger,
        usage_incomplete: z.boolean().optional(),
      })
      .strict(),
    type: z.literal("usage"),
  })
  .strict();

const agentStepStartedSchema = z
  // PHASE4: step.started 记录本步输入来源和动作前剩余预算，是“允许发起模型请求”的审计点。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        input_kind: z.enum([
          "inherited_tool_result",
          "user_task",
          "tool_result",
        ]),
        max_steps: positiveInteger,
        remaining_duration_ms: nonnegativeInteger,
        remaining_tokens: nonnegativeInteger,
        remaining_tool_output_bytes: nonnegativeInteger,
        step: positiveInteger,
      })
      .strict(),
    type: z.literal("agent.step.started"),
  })
  .strict();

const legacyModelUsageDataSchema = z
  .object({
    cached_input_tokens: nonnegativeInteger.optional(),
    input_tokens: nonnegativeInteger,
    output_tokens: nonnegativeInteger,
    provider_response_id: z.string().min(1).optional(),
    step: positiveInteger,
    total_tokens: nonnegativeInteger,
  })
  .strict();

const phase8CompleteModelUsageDataSchema = z
  .object({
    cache_read_tokens: nonnegativeInteger.nullable(),
    cache_write_tokens: nonnegativeInteger.nullable(),
    completeness: z.literal("complete"),
    input_tokens: nonnegativeInteger,
    output_tokens: nonnegativeInteger,
    provider: providerIdSchema,
    provider_response_id: z.string().min(1).optional(),
    step: positiveInteger,
    total_tokens: nonnegativeInteger,
  })
  .strict();

const phase8PartialModelUsageDataSchema = z
  .object({
    cache_read_tokens: nonnegativeInteger.nullable(),
    cache_write_tokens: nonnegativeInteger.nullable(),
    completeness: z.literal("partial"),
    input_tokens: nonnegativeInteger.nullable(),
    output_tokens: nonnegativeInteger.nullable(),
    provider: providerIdSchema,
    provider_response_id: z.string().min(1).optional(),
    step: positiveInteger,
    total_tokens: nonnegativeInteger.nullable(),
  })
  .strict();

const modelUsageSchema = z
  // PHASE4: 每个 step 单独记录 provider usage，run 级 usage 只能由这些事件精确聚合。
  .object({
    ...commonEnvelope,
    // PHASE8: null means the provider did not report a field. It must not be
    // rewritten to zero or admitted into the reported-token completion ceiling.
    data: z.union([
      legacyModelUsageDataSchema,
      phase8CompleteModelUsageDataSchema,
      phase8PartialModelUsageDataSchema,
    ]),
    type: z.literal("model.usage"),
  })
  .strict();

const agentStepCompletedSchema = z
  // PHASE4: outcome 区分“继续执行工具”与“得到 final”，tool_call outcome 必须绑定 call_id。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        outcome: z.enum(["final", "tool_call"]),
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        text_chars: nonnegativeInteger,
        tool_call_id: z.string().min(1).max(200).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.outcome === "tool_call" && value.tool_call_id === undefined) ||
          (value.outcome === "final" && value.tool_call_id !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "tool_call_id does not match step outcome",
          });
        }
      }),
    type: z.literal("agent.step.completed"),
  })
  .strict();

const runCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        completion_mode: z
          .enum(["model_final", "plan_ready", "verified_finish_task"])
          .optional(),
        duration_ms: nonnegativeInteger,
        evidence_sha256: sha256Schema.optional(),
        model_turns: positiveInteger.optional(),
        output_chars: nonnegativeInteger,
        provider_response_id: z.string().min(1).optional(),
        report_sha256: sha256Schema.optional(),
        steps: positiveInteger.optional(),
        tool_calls: nonnegativeInteger.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        const hasEvidence = value.evidence_sha256 !== undefined;
        const hasReport = value.report_sha256 !== undefined;
        if (hasEvidence !== hasReport) {
          context.addIssue({
            code: "custom",
            message: "completion evidence and report hashes must appear together",
          });
        }
        if (
          value.completion_mode === "verified_finish_task" &&
          (!hasEvidence || !hasReport)
        ) {
          context.addIssue({
            code: "custom",
            message: "verified completion requires evidence and report hashes",
          });
        }
        if (
          (value.completion_mode === "model_final" ||
            value.completion_mode === "plan_ready") &&
          (hasEvidence || hasReport)
        ) {
          context.addIssue({
            code: "custom",
            message: "non-finish completion cannot claim verified evidence",
          });
        }
      }),
    type: z.literal("run.completed"),
  })
  .strict();

const runIncompleteSchema = z
  // PHASE7: failed verification is a truthful task outcome (exit 8), not a provider or program crash.
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        evidence_sha256: sha256Schema.optional(),
        output_chars: nonnegativeInteger,
        reason: incompleteReasonSchema,
        report_sha256: sha256Schema.optional(),
        steps: nonnegativeInteger,
        tool_calls: nonnegativeInteger,
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.evidence_sha256 === undefined) !==
          (value.report_sha256 === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "incomplete evidence and report hashes must appear together",
          });
        }
      }),
    type: z.literal("run.incomplete"),
  })
  .strict();

const runFailedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        category: z.enum([
          // PHASE8: new provider failures use provider-neutral categories. The
          // legacy auth/provider values remain decodable for old schema-v1 logs.
          "authentication",
          "permission",
          "auth",
          "rate_limit",
          "quota",
          "network",
          "provider",
          "timeout",
          "invalid_request",
          "model_not_found",
          "protocol",
          "cancelled",
          "storage",
          "internal",
        ]),
        code: z.string().regex(/^[a-z0-9_]+$/u),
        duration_ms: nonnegativeInteger,
        message: z.string().min(1).max(500),
        output_chars: nonnegativeInteger.optional(),
        provider_request_id: z.string().min(1).optional(),
        retryable: z.boolean(),
        steps: nonnegativeInteger.optional(),
        tool_calls: nonnegativeInteger.optional(),
      })
      .strict(),
    type: z.literal("run.failed"),
  })
  .strict();

const runCancelledSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        output_chars: nonnegativeInteger.optional(),
        reason: z.literal("user"),
        steps: nonnegativeInteger.optional(),
        tool_calls: nonnegativeInteger.optional(),
      })
      .strict(),
    type: z.literal("run.cancelled"),
  })
  .strict();

const toolCallRequestedSchema = z
  // PHASE3: requested 保存模型实际提出的 call_id/name/原始 arguments 证据，但不代表已获准执行。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        arguments_json: utf8StringWithin(16 * 1024),
        call_id: callIdSchema,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        tool_name: toolNameSchema,
      })
      .strict(),
    type: z.literal("tool.call.requested"),
  })
  .strict();

const runBudgetExceededSchema = z
  // PHASE4: budget terminal 保存 reason/limit/observed，使停止原因能从 JSONL 独立验证。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        limit: positiveInteger,
        observed: nonnegativeInteger,
        output_chars: nonnegativeInteger,
        reason: z.enum([
          "max_steps",
          "max_duration",
          "max_tokens",
          "max_tool_output",
          "context_estimate_overflow",
          "context_protected_overflow",
          "context_unsafe_compaction",
          "repeated_tool_call",
        ]),
        steps: nonnegativeInteger,
        tool_calls: nonnegativeInteger,
      })
      .strict(),
    type: z.literal("run.budget_exceeded"),
  })
  .strict();

const toolCallCompletedSchema = z
  // PHASE3: completed 保存实际 observation；output 就是随后交给模型的同一字符串。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        call_id: callIdSchema,
        duration_ms: nonnegativeInteger,
        error_category: z
          .enum([
            "cancelled",
            "invalid_arguments",
            "limit",
            "not_found",
            "permission",
            "system",
            "tool",
          ])
          .optional(),
        error_code: z.string().regex(/^[a-z0-9_]+$/u).optional(),
        // PHASE6: command observations can carry up to 1 MiB plus bounded JSON framing.
        output: utf8StringWithin(1_114_112),
        retryable: z.boolean().optional(),
        repository_rule_binding: z
          .object({
            rule_manifest_sha256: sha256Schema,
            rule_scope_truncated: z.boolean(),
            target_scopes: z
              .array(
                z
                  .object({
                    relative_path: relativePathSchema,
                    scope_sha256: sha256Schema,
                  })
                  .strict(),
              )
              .max(16),
          })
          .strict()
          .optional(),
        status: z.enum(["error", "success"]),
        step: positiveInteger,
        tool_name: toolNameSchema,
        truncated: z.boolean(),
      })
      .strict()
      .superRefine((value, context) => {
        // PHASE3: success 不得混入错误字段；error 必须完整携带稳定分类、code 和 retryable。
        const errorFields = [
          value.error_category,
          value.error_code,
          value.retryable,
        ];
        if (
          (value.status === "error" && errorFields.some((field) => field === undefined)) ||
          (value.status === "success" && errorFields.some((field) => field !== undefined))
        ) {
          context.addIssue({
            code: "custom",
            message: "tool result error fields do not match status",
          });
        }
      }),
    type: z.literal("tool.call.completed"),
  })
  .strict();

const patchPathSchema = z
  .object({
    kind: z.enum(["create", "modify"]),
    path: relativePathSchema,
  })
  .strict();

const patchPlanCreatedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        added_lines: nonnegativeInteger,
        call_id: callIdSchema,
        patch_sha256: sha256Schema,
        paths: z.array(patchPathSchema).min(1).max(8),
        plan_id: sha256Schema,
        rule_manifest_sha256: sha256Schema.optional(),
        rule_scope_set_sha256: sha256Schema.optional(),
        preview: utf8StringWithin(32 * 1024),
        removed_lines: nonnegativeInteger,
        step: positiveInteger,
        truncated: z.boolean(),
      })
      .strict(),
    type: z.literal("patch.plan.created"),
  })
  .strict();

const legacyPatchApprovalRequestedDataSchema = z
  .object({
    action: z.literal("apply_patch"),
    // PHASE6: action identity is optional only for legacy Phase 5 records; new producers should emit both fields.
    action_kind: z.literal("apply_patch").optional(),
    action_sha256: sha256Schema.optional(),
    added_lines: nonnegativeInteger,
    approval_request_id: uuidSchema,
    call_id: callIdSchema,
    paths: z.array(patchPathSchema).min(1).max(8),
    plan_id: sha256Schema,
    rule_manifest_sha256: sha256Schema.optional(),
    rule_scope_set_sha256: sha256Schema.optional(),
    preview: utf8StringWithin(32 * 1024),
    removed_lines: nonnegativeInteger,
    step: positiveInteger,
    truncated: z.boolean(),
  })
  .strict();

const commandApprovalRequestedDataSchema = z
  .object({
    action: z.literal("run_command"),
    action_kind: z.literal("run_command"),
    action_sha256: sha256Schema,
    approval_request_id: uuidSchema,
    call_id: callIdSchema,
    cwd: relativeCwdSchema,
    executable: stableIdentifierSchema,
    preview: utf8StringWithin(32 * 1024),
    purpose: z.enum(["inspect", "verify"]),
    redacted_argv: z.array(utf8StringWithin(4096)).min(1).max(65),
    step: positiveInteger,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.redacted_argv[0] !== value.executable) {
      context.addIssue({
        code: "custom",
        message: "redacted argv must begin with executable",
      });
    }
  });

const approvalRequestedSchema = z
  .object({
    ...commonEnvelope,
    data: z.discriminatedUnion("action", [
      legacyPatchApprovalRequestedDataSchema,
      commandApprovalRequestedDataSchema,
    ]),
    type: z.literal("approval.requested"),
  })
  .strict();

const legacyPatchApprovalDecidedDataSchema = z
  .object({
    action: z.literal("apply_patch"),
    action_kind: z.literal("apply_patch").optional(),
    action_sha256: sha256Schema.optional(),
    approval_request_id: uuidSchema,
    call_id: callIdSchema,
    decision: z.enum(["approved", "cancelled", "denied"]),
    plan_id: sha256Schema,
    rule_manifest_sha256: sha256Schema.optional(),
    rule_scope_set_sha256: sha256Schema.optional(),
    step: positiveInteger,
  })
  .strict();

const commandApprovalDecidedDataSchema = z
  .object({
    action: z.literal("run_command"),
    action_kind: z.literal("run_command"),
    action_sha256: sha256Schema,
    approval_request_id: uuidSchema,
    call_id: callIdSchema,
    decision: z.enum(["approved", "cancelled", "denied"]),
    step: positiveInteger,
  })
  .strict();

const approvalDecidedSchema = z
  .object({
    ...commonEnvelope,
    data: z.discriminatedUnion("action", [
      legacyPatchApprovalDecidedDataSchema,
      commandApprovalDecidedDataSchema,
    ]),
    type: z.literal("approval.decided"),
  })
  .strict();

const patchApplyFileStartedSchema = z
  .object({
    kind: z.enum(["create", "modify"]),
    path: relativePathSchema,
    // PHASE9: the predicted postimage hash is durable before mutation. Without
    // it, a crash after apply cannot distinguish an applied patch from unknown
    // third-party bytes. Optional keeps historical schema-v1 logs readable.
    post_sha256: sha256Schema.optional(),
    pre_sha256: sha256Schema.nullable(),
  })
  .strict();

const patchApplyStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        approval_request_id: uuidSchema,
        call_id: callIdSchema,
        files: z.array(patchApplyFileStartedSchema).min(1).max(8),
        plan_id: sha256Schema,
        rule_manifest_sha256: sha256Schema.optional(),
        rule_scope_set_sha256: sha256Schema.optional(),
        step: positiveInteger,
      })
      .strict(),
    type: z.literal("patch.apply.started"),
  })
  .strict();

const patchApplyFileCompletedSchema = patchApplyFileStartedSchema.extend({
  post_sha256: sha256Schema,
});

const patchApplyCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        added_lines: nonnegativeInteger,
        approval_request_id: uuidSchema,
        call_id: callIdSchema,
        duration_ms: nonnegativeInteger,
        files: z.array(patchApplyFileCompletedSchema).min(1).max(8),
        journal_sha256: sha256Schema,
        plan_id: sha256Schema,
        rule_manifest_sha256: sha256Schema.optional(),
        rule_scope_set_sha256: sha256Schema.optional(),
        removed_lines: nonnegativeInteger,
        step: positiveInteger,
      })
      .strict(),
    type: z.literal("patch.apply.completed"),
  })
  .strict();

const permissionEvaluatedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        action_kind: z.literal("run_command"),
        action_sha256: sha256Schema,
        call_id: callIdSchema,
        effect: z.enum(["allow", "ask", "deny"]),
        policy_version: stableIdentifierSchema,
        reason_code: stableIdentifierSchema.optional(),
        rule_id: stableIdentifierSchema,
        step: positiveInteger,
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.effect === "allow" && value.reason_code !== undefined) ||
          (value.effect !== "allow" && value.reason_code === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "permission reason_code does not match effect",
          });
        }
      }),
    type: z.literal("permission.evaluated"),
  })
  .strict();

const commandEventIdentity = {
  action_sha256: sha256Schema,
  call_id: callIdSchema,
  execution_id: uuidSchema,
  executor: z.enum(["local", "docker"]),
  step: positiveInteger,
};

const commandExecutionRequestedSchema = z
  // PHASE6: this persisted request is the final audit boundary before spawn; its identity never uses a display string.
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...commandEventIdentity,
        approval_request_id: uuidSchema.optional(),
        cwd: relativeCwdSchema,
        executable: stableIdentifierSchema,
        purpose: z.enum(["inspect", "verify"]),
        redacted_argv: z.array(utf8StringWithin(4096)).min(1).max(65),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.redacted_argv[0] !== value.executable) {
          context.addIssue({
            code: "custom",
            message: "redacted argv must begin with executable",
          });
        }
      }),
    type: z.literal("command.execution.requested"),
  })
  .strict();

const commandStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...commandEventIdentity,
        process_identity: utf8StringWithin(200).optional(),
      })
      .strict(),
    type: z.literal("command.started"),
  })
  .strict();

const commandOutputSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...commandEventIdentity,
        bytes: positiveInteger,
        channel: z.enum(["stdout", "stderr"]),
        chunk: utf8StringWithin(32 * 1024).refine(
          (value) => value.length > 0,
          "command output chunk must not be empty",
        ),
        chunk_index: nonnegativeInteger,
      })
      .strict()
      .superRefine((value, context) => {
        if (value.bytes !== Buffer.byteLength(value.chunk, "utf8")) {
          context.addIssue({
            code: "custom",
            message: "command output bytes do not match chunk",
          });
        }
      }),
    type: z.literal("command.output"),
  })
  .strict();

const commandCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...commandEventIdentity,
        cleanup_verified: z.boolean(),
        duration_ms: nonnegativeInteger,
        error_code: stableIdentifierSchema.optional(),
        exit_code: z.number().int().nullable(),
        signal: utf8StringWithin(128).nullable(),
        stderr_bytes: nonnegativeInteger,
        stdout_bytes: nonnegativeInteger,
        termination: z.enum([
          "exit",
          "signal",
          "spawn_error",
          "timeout",
          "output_limit_exceeded",
          "cancelled",
          "cleanup_failed",
        ]),
        total_bytes: nonnegativeInteger,
        truncated: z.boolean(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.total_bytes !== value.stdout_bytes + value.stderr_bytes) {
          context.addIssue({
            code: "custom",
            message: "command total_bytes do not match channel bytes",
          });
        }
        const exitShape = value.exit_code !== null && value.signal === null;
        const signalShape = value.exit_code === null && value.signal !== null;
        const conflictingObservedTermination =
          value.exit_code !== null && value.signal !== null;
        if (
          (value.termination === "exit" && !exitShape) ||
          (value.termination === "signal" && !signalShape) ||
          (value.termination !== "exit" &&
            value.termination !== "signal" &&
            conflictingObservedTermination)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "command exit_code/signal do not match first-cause termination",
          });
        }
      }),
    type: z.literal("command.completed"),
  })
  .strict();

const verificationIdentity = {
  action_sha256: sha256Schema,
  call_id: callIdSchema,
  command_execution_id: uuidSchema,
  step: positiveInteger,
  verification_id: uuidSchema,
};

const verificationStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...verificationIdentity,
        generation: nonnegativeInteger,
        kind: z.enum(["test", "lint", "typecheck", "build", "check"]),
        snapshot_sha256: sha256Schema,
      })
      .strict(),
    type: z.literal("verification.started"),
  })
  .strict();

const verificationCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        ...verificationIdentity,
        after_snapshot_sha256: sha256Schema,
        before_snapshot_sha256: sha256Schema,
        completed_generation: nonnegativeInteger,
        duration_ms: nonnegativeInteger,
        exit_code: z.number().int().nullable(),
        stale: z.boolean(),
        stale_reasons: z
          .array(
            z.enum([
              "generation_changed",
              "generation_marked_stale",
              "source_state_changed",
            ]),
          )
          .max(3)
          .refine(
            (values) => new Set(values).size === values.length,
            "verification stale reasons must be unique",
          ),
        started_generation: nonnegativeInteger,
        status: z.enum(["passed", "failed", "stale"]),
      })
      .strict()
      .superRefine((value, context) => {
        const snapshotChanged =
          value.before_snapshot_sha256 !== value.after_snapshot_sha256;
        const generationChanged =
          value.started_generation !== value.completed_generation;
        const shouldBeStale =
          snapshotChanged || generationChanged || value.stale_reasons.length > 0;
        if (
          value.stale !== shouldBeStale ||
          (value.status === "stale") !== value.stale
        ) {
          context.addIssue({
            code: "custom",
            message: "verification stale state does not match generation and snapshots",
          });
        }
        if (
          value.status === "passed" &&
          (value.exit_code !== 0 || value.stale)
        ) {
          context.addIssue({
            code: "custom",
            message: "passed verification requires exit 0 on an unchanged snapshot",
          });
        }
        if (
          value.status === "failed" &&
          (value.exit_code === 0 || value.stale)
        ) {
          context.addIssue({
            code: "custom",
            message: "failed verification must not claim exit 0 or stale evidence",
          });
        }
        if (
          value.stale_reasons.includes("generation_changed") !==
          generationChanged
        ) {
          context.addIssue({
            code: "custom",
            message: "generation stale reason does not match generation evidence",
          });
        }
        if (
          value.stale_reasons.includes("source_state_changed") !==
          snapshotChanged
        ) {
          context.addIssue({
            code: "custom",
            message: "source-state stale reason does not match snapshot evidence",
          });
        }
      }),
    type: z.literal("verification.completed"),
  })
  .strict();

const completionCandidateSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        call_id: callIdSchema,
        candidate_sha256: sha256Schema,
        status: z.enum(["completed", "blocked"]),
        step: positiveInteger,
        summary: z.string().max(4000).refine(
          (value) =>
            !value.includes("\0") &&
            [...value].length >= 1 &&
            [...value].length <= 2000,
          "completion summary must contain 1..2000 NUL-free characters",
        ),
      })
      .strict(),
    type: z.literal("completion.candidate"),
  })
  .strict();

const completionEvidenceSchema = z
  .object({
    ...commonEnvelope,
    data: persistedCompletionEvidenceSchema,
    type: z.literal("completion.evidence"),
  })
  .strict();

const diffStatSchema = z
  .object({
    added_lines: nonnegativeInteger,
    removed_lines: nonnegativeInteger,
  })
  .strict();

const completionEvaluatedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        call_id: callIdSchema,
        candidate_sha256: sha256Schema,
        changed_paths: z.array(relativePathSchema).max(256),
        diff_stat: diffStatSchema.optional(),
        effect: z.enum(["accept", "continue", "error", "incomplete"]),
        error_code: z.literal("completion_evaluation_failed").optional(),
        evidence_sha256: sha256Schema.optional(),
        reasons: z.array(incompleteReasonSchema).max(16),
        report_sha256: sha256Schema.optional(),
        step: positiveInteger,
        verification_ids: z.array(uuidSchema).max(64),
      })
      .strict()
      .superRefine((value, context) => {
        const hasEvidence = value.evidence_sha256 !== undefined;
        const hasReport = value.report_sha256 !== undefined;
        if (hasEvidence !== hasReport) {
          context.addIssue({
            code: "custom",
            message: "completion evidence and report hashes must appear together",
          });
        }
        if (
          (value.effect === "error") !== (value.error_code !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "completion evaluation error must carry its stable error code",
          });
        }
        if (
          value.effect === "accept" &&
          (value.reasons.length !== 0 ||
            !hasEvidence ||
            !hasReport ||
            value.verification_ids.length === 0 ||
            value.changed_paths.length === 0 ||
            value.diff_stat === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "accepted completion requires current evidence without rejection reasons",
          });
        }
        if (
          value.effect === "continue" &&
          (value.reasons.length === 0 || hasEvidence || hasReport)
        ) {
          context.addIssue({
            code: "custom",
            message: "continued completion requires reasons and cannot claim final evidence",
          });
        }
        if (
          value.effect === "incomplete" &&
          (value.reasons.length === 0 ||
            !hasEvidence ||
            !hasReport ||
            value.diff_stat === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "incomplete completion requires a reason, persisted evidence, and diff stat",
          });
        }
        if (
          value.effect === "error" &&
          (value.reasons.length !== 0 ||
            hasEvidence ||
            hasReport ||
            value.changed_paths.length !== 0 ||
            value.diff_stat !== undefined ||
            value.verification_ids.length !== 0)
        ) {
          context.addIssue({
            code: "custom",
            message: "failed completion evaluation cannot claim task evidence",
          });
        }
        if (new Set(value.reasons).size !== value.reasons.length) {
          context.addIssue({
            code: "custom",
            message: "completion reasons must be unique",
          });
        }
        if (
          new Set(value.verification_ids).size !== value.verification_ids.length
        ) {
          context.addIssue({
            code: "custom",
            message: "completion verification ids must be unique",
          });
        }
        if (new Set(value.changed_paths).size !== value.changed_paths.length) {
          context.addIssue({
            code: "custom",
            message: "completion changed paths must be unique",
          });
        }
      }),
    type: z.literal("completion.evaluated"),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("type", [
  // PHASE2: type 是判别字段。解析成功后，TypeScript 能依据 event.type 自动缩小 data 类型。
  runStartedSchema,
  backendSelectedSchema,
  textDeltaSchema,
  agentStepStartedSchema,
  modelUsageSchema,
  agentStepCompletedSchema,
  usageSchema,
  toolCallRequestedSchema,
  toolCallCompletedSchema,
  patchPlanCreatedSchema,
  approvalRequestedSchema,
  approvalDecidedSchema,
  patchApplyStartedSchema,
  patchApplyCompletedSchema,
  permissionEvaluatedSchema,
  commandExecutionRequestedSchema,
  commandStartedSchema,
  commandOutputSchema,
  commandCompletedSchema,
  verificationStartedSchema,
  verificationCompletedSchema,
  completionEvidenceSchema,
  completionCandidateSchema,
  completionEvaluatedSchema,
  runCompletedSchema,
  runIncompleteSchema,
  runFailedSchema,
  runCancelledSchema,
  runBudgetExceededSchema,
]);
