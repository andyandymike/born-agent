import type { RunEvent, TerminalRunEvent } from "../events/run-event.js";
import { isTerminalRunEvent } from "../events/run-event.js";

type StartedEvent = Extract<RunEvent, { type: "run.started" }>;
type UsageEvent = Extract<RunEvent, { type: "usage" }>;
type ToolRequestedEvent = Extract<RunEvent, { type: "tool.call.requested" }>;
type ToolCompletedEvent = Extract<RunEvent, { type: "tool.call.completed" }>;
type AgentStepStartedEvent = Extract<RunEvent, { type: "agent.step.started" }>;
type AgentStepCompletedEvent = Extract<RunEvent, { type: "agent.step.completed" }>;
type ModelUsageEvent = Extract<RunEvent, { type: "model.usage" }>;
type PatchPlanCreatedEvent = Extract<RunEvent, { type: "patch.plan.created" }>;
type ApprovalRequestedEvent = Extract<RunEvent, { type: "approval.requested" }>;
type ApprovalDecidedEvent = Extract<RunEvent, { type: "approval.decided" }>;
type PatchApprovalRequestedData = Extract<
  ApprovalRequestedEvent["data"],
  { action: "apply_patch" }
>;
type PatchApprovalDecidedData = Extract<
  ApprovalDecidedEvent["data"],
  { action: "apply_patch" }
>;
type CommandApprovalRequestedData = Extract<
  ApprovalRequestedEvent["data"],
  { action: "run_command" }
>;
type CommandApprovalDecidedData = Extract<
  ApprovalDecidedEvent["data"],
  { action: "run_command" }
>;
type PatchApplyStartedEvent = Extract<RunEvent, { type: "patch.apply.started" }>;
type PatchApplyCompletedEvent = Extract<RunEvent, { type: "patch.apply.completed" }>;
type PermissionEvaluatedEvent = Extract<RunEvent, { type: "permission.evaluated" }>;
type CommandExecutionRequestedEvent = Extract<
  RunEvent,
  { type: "command.execution.requested" }
>;
type CommandStartedEvent = Extract<RunEvent, { type: "command.started" }>;
type CommandOutputEvent = Extract<RunEvent, { type: "command.output" }>;
type CommandCompletedEvent = Extract<RunEvent, { type: "command.completed" }>;

export interface ReconstructedToolCall {
  readonly completed?: ToolCompletedEvent["data"];
  readonly consumedByModel: boolean;
  readonly interrupted: boolean;
  readonly requested: ToolRequestedEvent["data"];
}

export interface ReconstructedAgentStep {
  readonly completed?: AgentStepCompletedEvent["data"];
  readonly interrupted: boolean;
  readonly modelUsage?: ModelUsageEvent["data"];
  readonly started: AgentStepStartedEvent["data"];
}

export type ReconstructedPatchApplyState = "completed" | "none" | "unknown";

export interface ReconstructedPatchAttempt {
  readonly applyCompleted?: PatchApplyCompletedEvent["data"];
  readonly applyStarted?: PatchApplyStartedEvent["data"];
  readonly applyState: ReconstructedPatchApplyState;
  readonly approvalDecided?: PatchApprovalDecidedData;
  readonly approvalRequested?: PatchApprovalRequestedData;
  readonly plan: PatchPlanCreatedEvent["data"];
}

export type ReconstructedCommandEffectState = "completed" | "none" | "unknown";

export interface ReconstructedCommandAttempt {
  readonly approvalDecided?: CommandApprovalDecidedData;
  readonly approvalRequested?: CommandApprovalRequestedData;
  readonly completed?: CommandCompletedEvent["data"];
  readonly effectState: ReconstructedCommandEffectState;
  readonly executionRequested?: CommandExecutionRequestedEvent["data"];
  readonly output: readonly CommandOutputEvent["data"][];
  readonly permission: PermissionEvaluatedEvent["data"];
  readonly started?: CommandStartedEvent["data"];
}

export interface ReconstructedRun {
  readonly agentSteps: readonly ReconstructedAgentStep[];
  readonly commandAttempts: readonly ReconstructedCommandAttempt[];
  readonly output: string;
  readonly patchAttempts: readonly ReconstructedPatchAttempt[];
  readonly runId: string;
  readonly sessionId: string;
  readonly started: StartedEvent["data"];
  readonly terminal: TerminalRunEvent;
  readonly toolCalls: readonly ReconstructedToolCall[];
  readonly usage?: UsageEvent["data"];
}

interface MutableToolCall {
  completed?: ToolCompletedEvent["data"];
  consumedByModel: boolean;
  requested: ToolRequestedEvent["data"];
}

interface MutableAgentStep {
  completed?: AgentStepCompletedEvent["data"];
  modelUsage?: ModelUsageEvent["data"];
  sawNonWhitespaceText: boolean;
  started: AgentStepStartedEvent["data"];
  textChars: number;
}

interface MutablePatchAttempt {
  applyCompleted?: PatchApplyCompletedEvent["data"];
  applyStarted?: PatchApplyStartedEvent["data"];
  approvalDecided?: PatchApprovalDecidedData;
  approvalRequested?: PatchApprovalRequestedData;
  plan: PatchPlanCreatedEvent["data"];
}

interface MutableCommandAttempt {
  approvalDecided?: CommandApprovalDecidedData;
  approvalRequested?: CommandApprovalRequestedData;
  completed?: CommandCompletedEvent["data"];
  executionRequested?: CommandExecutionRequestedEvent["data"];
  output: CommandOutputEvent["data"][];
  permission: PermissionEvaluatedEvent["data"];
  started?: CommandStartedEvent["data"];
  stderrBytes: number;
  stderrChunks: number;
  stdoutBytes: number;
  stdoutChunks: number;
}

interface ApprovalReference {
  readonly action: "apply_patch" | "run_command";
  readonly callId: string;
}

const REGISTRY_PRE_EXECUTION_ERROR_CODES = new Set([
  "arguments_schema_mismatch",
  "arguments_too_large",
  "invalid_arguments_json",
  "tool_cancelled",
]);

function isPreExecutionToolError(
  data: ToolCompletedEvent["data"],
): boolean {
  return data.status === "error" &&
    (data.error_category === "permission" ||
      (data.error_code !== undefined &&
        REGISTRY_PRE_EXECUTION_ERROR_CODES.has(data.error_code)));
}

function patchPathsMatch(
  left: readonly { readonly kind: "create" | "modify"; readonly path: string }[],
  right: readonly { readonly kind: "create" | "modify"; readonly path: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.kind === right[index]?.kind && entry.path === right[index]?.path,
    )
  );
}

function applyFilesMatch(
  started: PatchApplyStartedEvent["data"]["files"],
  completed: PatchApplyCompletedEvent["data"]["files"],
): boolean {
  return (
    started.length === completed.length &&
    started.every((entry, index) => {
      const result = completed[index];
      return (
        result !== undefined &&
        entry.kind === result.kind &&
        entry.path === result.path &&
        entry.pre_sha256 === result.pre_sha256
      );
    })
  );
}

function validateRunUsage(
  usage: UsageEvent["data"],
  steps: readonly MutableAgentStep[],
): void {
  const modelUsages = steps.map((step) => step.modelUsage);
  if (modelUsages.some((value) => value === undefined)) {
    throw new Error("agent run usage exists without usage for every step");
  }
  const known = modelUsages.filter((value) => value !== undefined);
  const cached = known
    .map((value) => value.cached_input_tokens)
    .filter((value) => value !== undefined);
  if (
    usage.input_tokens !==
      known.reduce((sum, value) => sum + value.input_tokens, 0) ||
    usage.output_tokens !==
      known.reduce((sum, value) => sum + value.output_tokens, 0) ||
    usage.total_tokens !==
      known.reduce((sum, value) => sum + value.total_tokens, 0) ||
    usage.model_turns !== known.length ||
    (cached.length === 0
      ? usage.cached_input_tokens !== undefined
      : usage.cached_input_tokens !== cached.reduce((sum, value) => sum + value, 0)) ||
    usage.usage_incomplete === true
  ) {
    throw new Error("run usage does not equal model usage aggregation");
  }
}

function validateBudgetTerminal(
  started: Extract<StartedEvent["data"], { command: "agent" }>,
  terminal: Extract<TerminalRunEvent, { type: "run.budget_exceeded" }>,
  steps: readonly MutableAgentStep[],
  tools: readonly MutableToolCall[],
): void {
  // PHASE4: 用 run.started 的原始预算和重放出的 step/tool/usage 重新证明 terminal 数值，
  // 防止仅凭最后一行就相信 reason、limit 或 observed。
  const data = terminal.data;
  if (data.steps !== steps.length) {
    throw new Error("budget terminal steps do not match agent trace");
  }
  if (data.tool_calls !== tools.filter((call) => call.completed !== undefined).length) {
    throw new Error("budget terminal tool_calls do not match agent trace");
  }
  if (data.reason === "max_steps") {
    if (
      data.limit !== started.max_steps ||
      data.observed !== steps.length ||
      data.observed !== data.limit
    ) {
      throw new Error("max_steps terminal does not match event history");
    }
  } else if (data.reason === "max_duration") {
    if (
      data.limit !== started.max_duration_ms ||
      data.observed !== data.duration_ms ||
      data.observed < data.limit
    ) {
      throw new Error("max_duration terminal does not match event history");
    }
  } else if (data.reason === "max_tokens") {
    const total = steps.reduce(
      (sum, step) => sum + (step.modelUsage?.total_tokens ?? 0),
      0,
    );
    if (
      data.limit !== started.max_tokens ||
      data.observed !== total ||
      data.observed < data.limit
    ) {
      throw new Error("max_tokens terminal does not match event history");
    }
  } else if (data.reason === "max_tool_output") {
    const bytes = tools.reduce(
      (sum, call) =>
        sum +
        (call.completed === undefined
          ? 0
          : Buffer.byteLength(call.completed.output, "utf8")),
      0,
    );
    if (
      data.limit !== started.max_tool_output_bytes ||
      data.observed !== bytes ||
      data.observed < data.limit
    ) {
      throw new Error("max_tool_output terminal does not match event history");
    }
  } else if (data.limit !== 3 || data.observed !== 3) {
    throw new Error("repeated_tool_call terminal must report 3 of 3");
  }
}

export function reconstructSession(events: readonly RunEvent[]): ReconstructedRun {
  // PHASE4: 重建器是独立于在线 Publisher 的第二道验证；它只根据 JSONL 重建 step DAG、
  // 工具 observation 是否被消费、usage 聚合和最终停止原因。
  if (events.length === 0) throw new Error("session is empty");
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("run.started must be first");

  const eventIds = new Set<string>();
  const tools = new Map<string, MutableToolCall>();
  const patchAttempts = new Map<string, MutablePatchAttempt>();
  const commandAttempts = new Map<string, MutableCommandAttempt>();
  const commandExecutions = new Map<string, MutableCommandAttempt>();
  const approvalCalls = new Map<string, ApprovalReference>();
  const steps: MutableAgentStep[] = [];
  let activeStep: MutableAgentStep | undefined;
  let output = "";
  let usage: UsageEvent["data"] | undefined;
  let terminal: TerminalRunEvent | undefined;

  events.forEach((event, index) => {
    if (event.session_id !== first.session_id || event.run_id !== first.run_id) {
      throw new Error("session or run id changed within event log");
    }
    if (event.seq !== index + 1) {
      throw new Error(`expected seq ${index + 1}, received ${event.seq}`);
    }
    if (eventIds.has(event.event_id)) throw new Error("duplicate event id");
    eventIds.add(event.event_id);
    if (index > 0 && event.type === "run.started") {
      throw new Error("run.started can only appear once");
    }
    if (terminal !== undefined) throw new Error("event appears after terminal event");

    if (event.type === "agent.step.started") {
      // PHASE4: step 必须连续且不重叠；第一步消费 user_task，后续步骤消费上一步 tool_result。
      if (first.data.command !== "agent") {
        throw new Error("chat session contains agent step events");
      }
      if (
        event.data.max_steps !== first.data.max_steps ||
        event.data.step > first.data.max_steps
      ) {
        throw new Error("agent step exceeds the configured max_steps");
      }
      if (activeStep !== undefined || event.data.step !== steps.length + 1) {
        throw new Error("agent steps must be continuous and non-overlapping");
      }
      if (event.data.step === 1) {
        if (event.data.input_kind !== "user_task") {
          throw new Error("first agent step must consume user_task");
        }
      } else {
        const previous = steps.at(-1);
        const call =
          previous?.completed?.tool_call_id === undefined
            ? undefined
            : tools.get(previous.completed.tool_call_id);
        if (
          event.data.input_kind !== "tool_result" ||
          previous?.completed?.outcome !== "tool_call" ||
          call?.completed === undefined
        ) {
          throw new Error("tool_result step lacks a completed previous tool call");
        }
        // PHASE4: completed 事件写入时无法预言 observation 会不会被消费；只有下一条
        // tool_result step 的存在，才能在重放时把前一工具结果确定为 consumedByModel。
        call.consumedByModel = true;
      }
      activeStep = {
        sawNonWhitespaceText: false,
        started: event.data,
        textChars: 0,
      };
      steps.push(activeStep);
    } else if (event.type === "text.delta") {
      if (first.data.command === "agent" && activeStep === undefined) {
        throw new Error("agent text delta appears outside a step");
      }
      output += event.data.delta;
      if (activeStep !== undefined) {
        activeStep.textChars += event.data.delta.length;
        activeStep.sawNonWhitespaceText ||= /\S/u.test(event.data.delta);
      }
    } else if (event.type === "model.usage") {
      // PHASE4: 每个 active step 最多一个 usage，供最终 run usage 和 token budget 交叉核对。
      if (
        first.data.command !== "agent" ||
        activeStep?.started.step !== event.data.step ||
        activeStep.modelUsage !== undefined
      ) {
        throw new Error("model usage does not match one active step");
      }
      activeStep.modelUsage = event.data;
    } else if (event.type === "agent.step.completed") {
      // PHASE4: completion 必须闭合当前 step，并核对该 step 中实际出现的 text delta 字符数。
      if (
        first.data.command !== "agent" ||
        activeStep?.started.step !== event.data.step ||
        activeStep.completed !== undefined ||
        activeStep.textChars !== event.data.text_chars
      ) {
        throw new Error("agent step completion does not match active step");
      }
      activeStep.completed = event.data;
      activeStep = undefined;
    } else if (event.type === "usage") {
      if (usage !== undefined) throw new Error("usage can only appear once");
      usage = event.data;
    } else if (event.type === "tool.call.requested") {
      if (tools.has(event.data.call_id)) throw new Error("duplicate tool call id");
      if (first.data.command === "agent") {
        const step = steps[event.data.step - 1];
        if (
          step?.completed?.outcome !== "tool_call" ||
          step.completed.tool_call_id !== event.data.call_id
        ) {
          throw new Error("tool request does not match a tool_call step");
        }
      }
      tools.set(event.data.call_id, {
        consumedByModel: false,
        requested: event.data,
      });
    } else if (event.type === "tool.call.completed") {
      const call = tools.get(event.data.call_id);
      if (
        call === undefined ||
        call.completed !== undefined ||
        call.requested.tool_name !== event.data.tool_name ||
        call.requested.step !== event.data.step
      ) {
        throw new Error("tool result does not match one pending tool call");
      }
      const patchAttempt = patchAttempts.get(event.data.call_id);
      if (
        event.data.tool_name === "apply_patch" &&
        event.data.status === "success" &&
        patchAttempt?.applyCompleted === undefined
      ) {
        throw new Error("successful apply_patch lacks completed apply evidence");
      }
      if (
        patchAttempt !== undefined &&
        patchAttempt.approvalRequested === undefined
      ) {
        throw new Error("planned apply_patch result lacks approval request");
      }
      if (
        patchAttempt?.approvalRequested !== undefined &&
        patchAttempt.approvalDecided === undefined
      ) {
        throw new Error("apply_patch result appears before approval decision");
      }
      const commandAttempt = commandAttempts.get(event.data.call_id);
      if (
        event.data.tool_name === "run_command" &&
        commandAttempt === undefined &&
        !isPreExecutionToolError(event.data)
      ) {
        throw new Error("run_command result lacks permission evidence");
      }
      if (
        commandAttempt?.permission.effect === "ask" &&
        commandAttempt.approvalDecided === undefined
      ) {
        throw new Error("run_command result appears before approval decision");
      }
      if (
        commandAttempt?.executionRequested !== undefined &&
        commandAttempt.completed === undefined
      ) {
        throw new Error("run_command result appears before command completion");
      }
      if (
        event.data.tool_name === "run_command" &&
        event.data.status === "success" &&
        commandAttempt?.completed === undefined
      ) {
        throw new Error("successful run_command lacks completed command evidence");
      }
      call.completed = event.data;
    } else if (event.type === "patch.plan.created") {
      // PHASE5: patch plan 只能绑定尚未完成的 apply_patch 工具调用。重放器不能因为
      // JSONL 中出现了一个看似合法的 plan_id，就跳过它与模型原始 tool call 的关联验证。
      const call = tools.get(event.data.call_id);
      if (
        first.data.command !== "agent" ||
        call === undefined ||
        call.completed !== undefined ||
        call.requested.tool_name !== "apply_patch" ||
        call.requested.step !== event.data.step ||
        patchAttempts.has(event.data.call_id)
      ) {
        throw new Error("patch plan does not match one pending apply_patch call");
      }
      patchAttempts.set(event.data.call_id, { plan: event.data });
    } else if (event.type === "permission.evaluated") {
      // PHASE6: policy evidence is tied to the pending tool call and immutable action hash;
      // policy classification is an audit fact, not proof of OS-level containment.
      const call = tools.get(event.data.call_id);
      if (
        first.data.command !== "agent" ||
        call === undefined ||
        call.completed !== undefined ||
        call.requested.tool_name !== "run_command" ||
        call.requested.step !== event.data.step ||
        commandAttempts.has(event.data.call_id)
      ) {
        throw new Error("permission evaluation does not match one pending run_command");
      }
      commandAttempts.set(event.data.call_id, {
        output: [],
        permission: event.data,
        stderrBytes: 0,
        stderrChunks: 0,
        stdoutBytes: 0,
        stdoutChunks: 0,
      });
    } else if (event.type === "approval.requested") {
      if (event.data.action === "apply_patch") {
        const attempt = patchAttempts.get(event.data.call_id);
        if (
          first.data.command !== "agent" ||
          attempt === undefined ||
          tools.get(event.data.call_id)?.completed !== undefined ||
          attempt.approvalRequested !== undefined ||
          approvalCalls.has(event.data.approval_request_id) ||
          attempt.plan.plan_id !== event.data.plan_id ||
          attempt.plan.step !== event.data.step ||
          attempt.plan.added_lines !== event.data.added_lines ||
          attempt.plan.removed_lines !== event.data.removed_lines ||
          attempt.plan.preview !== event.data.preview ||
          attempt.plan.truncated !== event.data.truncated ||
          (event.data.action_sha256 !== undefined &&
            event.data.action_sha256 !== attempt.plan.plan_id) ||
          !patchPathsMatch(attempt.plan.paths, event.data.paths)
        ) {
          throw new Error("approval request does not match one patch plan");
        }
        attempt.approvalRequested = event.data;
      } else {
        const attempt = commandAttempts.get(event.data.call_id);
        if (
          first.data.command !== "agent" ||
          attempt === undefined ||
          tools.get(event.data.call_id)?.completed !== undefined ||
          attempt.approvalRequested !== undefined ||
          approvalCalls.has(event.data.approval_request_id) ||
          attempt.permission.effect !== "ask" ||
          attempt.permission.step !== event.data.step ||
          attempt.permission.action_sha256 !== event.data.action_sha256
        ) {
          throw new Error("command approval request does not match ask permission");
        }
        attempt.approvalRequested = event.data;
      }
      approvalCalls.set(event.data.approval_request_id, {
        action: event.data.action,
        callId: event.data.call_id,
      });
    } else if (event.type === "approval.decided") {
      const reference = approvalCalls.get(event.data.approval_request_id);
      if (
        first.data.command !== "agent" ||
        reference?.action !== event.data.action ||
        reference.callId !== event.data.call_id
      ) {
        throw new Error("approval decision does not match one pending request");
      }
      if (event.data.action === "apply_patch") {
        const attempt = patchAttempts.get(event.data.call_id);
        if (
          attempt?.approvalRequested === undefined ||
          attempt.approvalDecided !== undefined ||
          attempt.plan.plan_id !== event.data.plan_id ||
          attempt.plan.step !== event.data.step ||
          (event.data.action_sha256 !== undefined &&
            event.data.action_sha256 !== attempt.plan.plan_id)
        ) {
          throw new Error("approval decision does not match one pending request");
        }
        attempt.approvalDecided = event.data;
      } else {
        const attempt = commandAttempts.get(event.data.call_id);
        if (
          attempt?.approvalRequested === undefined ||
          attempt.approvalDecided !== undefined ||
          attempt.permission.step !== event.data.step ||
          attempt.permission.action_sha256 !== event.data.action_sha256
        ) {
          throw new Error("command approval decision does not match its request");
        }
        attempt.approvalDecided = event.data;
      }
    } else if (event.type === "patch.apply.started") {
      // PHASE5: started 是磁盘副作用边界；只有同一 request 明确 approved 后才能出现。
      // 缺少 completed 时不猜测回滚结果，而是在最终重建结果中标记为 unknown。
      const attempt = patchAttempts.get(event.data.call_id);
      if (
        first.data.command !== "agent" ||
        attempt?.approvalRequested === undefined ||
        attempt.approvalDecided?.decision !== "approved" ||
        attempt.applyStarted !== undefined ||
        tools.get(event.data.call_id)?.completed !== undefined ||
        attempt.approvalRequested.approval_request_id !==
          event.data.approval_request_id ||
        attempt.plan.plan_id !== event.data.plan_id ||
        attempt.plan.step !== event.data.step ||
        !patchPathsMatch(attempt.plan.paths, event.data.files) ||
        !event.data.files.every((file) =>
          file.kind === "create"
            ? file.pre_sha256 === null
            : file.pre_sha256 !== null,
        )
      ) {
        throw new Error("patch apply does not follow its approved request");
      }
      attempt.applyStarted = event.data;
    } else if (event.type === "patch.apply.completed") {
      const attempt = patchAttempts.get(event.data.call_id);
      if (
        first.data.command !== "agent" ||
        attempt?.applyStarted === undefined ||
        attempt.applyCompleted !== undefined ||
        tools.get(event.data.call_id)?.completed !== undefined ||
        attempt.applyStarted.approval_request_id !==
          event.data.approval_request_id ||
        attempt.plan.plan_id !== event.data.plan_id ||
        attempt.plan.step !== event.data.step ||
        attempt.plan.added_lines !== event.data.added_lines ||
        attempt.plan.removed_lines !== event.data.removed_lines ||
        !applyFilesMatch(attempt.applyStarted.files, event.data.files)
      ) {
        throw new Error("patch completion does not match one started apply");
      }
      attempt.applyCompleted = event.data;
    } else if (event.type === "command.execution.requested") {
      // PHASE6: a persisted request without a later completion is effect unknown. In
      // particular, replay cannot infer cleanup across the spawn/started persistence window.
      const attempt = commandAttempts.get(event.data.call_id);
      const approvalMatches =
        attempt?.permission.effect === "ask"
          ? attempt.approvalDecided?.decision === "approved" &&
            attempt.approvalRequested?.approval_request_id ===
              event.data.approval_request_id &&
            attempt.approvalDecided.action_sha256 === event.data.action_sha256
          : event.data.approval_request_id === undefined;
      if (
        first.data.command !== "agent" ||
        attempt === undefined ||
        attempt.executionRequested !== undefined ||
        attempt.permission.effect === "deny" ||
        attempt.permission.step !== event.data.step ||
        attempt.permission.action_sha256 !== event.data.action_sha256 ||
        tools.get(event.data.call_id)?.completed !== undefined ||
        commandExecutions.has(event.data.execution_id) ||
        !approvalMatches
      ) {
        throw new Error("command execution request lacks matching permission");
      }
      attempt.executionRequested = event.data;
      commandExecutions.set(event.data.execution_id, attempt);
    } else if (event.type === "command.started") {
      const attempt = commandExecutions.get(event.data.execution_id);
      if (
        first.data.command !== "agent" ||
        attempt?.executionRequested === undefined ||
        attempt.started !== undefined ||
        attempt.completed !== undefined ||
        attempt.executionRequested.call_id !== event.data.call_id ||
        attempt.executionRequested.step !== event.data.step ||
        attempt.executionRequested.action_sha256 !== event.data.action_sha256
      ) {
        throw new Error("command start does not match one execution request");
      }
      attempt.started = event.data;
    } else if (event.type === "command.output") {
      const attempt = commandExecutions.get(event.data.execution_id);
      const expectedIndex =
        event.data.channel === "stdout"
          ? attempt?.stdoutChunks
          : attempt?.stderrChunks;
      if (
        first.data.command !== "agent" ||
        attempt?.started === undefined ||
        attempt.completed !== undefined ||
        attempt.started.call_id !== event.data.call_id ||
        attempt.started.step !== event.data.step ||
        attempt.started.action_sha256 !== event.data.action_sha256 ||
        event.data.chunk_index !== expectedIndex
      ) {
        throw new Error("command output is not contiguous for an active execution");
      }
      attempt.output.push(event.data);
      if (event.data.channel === "stdout") {
        attempt.stdoutBytes += event.data.bytes;
        attempt.stdoutChunks += 1;
      } else {
        attempt.stderrBytes += event.data.bytes;
        attempt.stderrChunks += 1;
      }
    } else if (event.type === "command.completed") {
      const attempt = commandExecutions.get(event.data.execution_id);
      const identity = attempt?.started ?? attempt?.executionRequested;
      const completedBeforeStart =
        attempt?.started === undefined &&
        (event.data.termination === "spawn_error" ||
          event.data.termination === "cancelled") &&
        event.data.stdout_bytes === 0 &&
        event.data.stderr_bytes === 0;
      if (
        first.data.command !== "agent" ||
        attempt?.executionRequested === undefined ||
        (attempt.started === undefined && !completedBeforeStart) ||
        attempt.completed !== undefined ||
        identity?.call_id !== event.data.call_id ||
        identity.step !== event.data.step ||
        identity.action_sha256 !== event.data.action_sha256 ||
        attempt.stdoutBytes !== event.data.stdout_bytes ||
        attempt.stderrBytes !== event.data.stderr_bytes ||
        attempt.stdoutBytes + attempt.stderrBytes !== event.data.total_bytes
      ) {
        throw new Error("command completion does not match active output evidence");
      }
      attempt.completed = event.data;
    } else if (isTerminalRunEvent(event)) {
      terminal = event;
      if (index !== events.length - 1) throw new Error("terminal event must be last");
    }
  });

  if (terminal === undefined) throw new Error("session is missing a terminal event");
  if (
    terminal.type === "run.completed" &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error("run.completed output_chars does not match reconstructed text");
  }
  if (
    terminal.type === "run.budget_exceeded" &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error("run.budget_exceeded output_chars does not match reconstructed text");
  }
  if (
    (terminal.type === "run.failed" || terminal.type === "run.cancelled") &&
    terminal.data.output_chars !== undefined &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error(`${terminal.type} output_chars does not match reconstructed text`);
  }

  const toolValues = [...tools.values()];
  const patchValues = [...patchAttempts.values()];
  const commandValues = [...commandAttempts.values()];
  if (
    terminal.type === "run.completed" &&
    toolValues.some((call) => call.completed === undefined)
  ) {
    throw new Error("completed run contains an interrupted tool call");
  }
  if (
    terminal.type === "run.completed" &&
    terminal.data.tool_calls !== undefined &&
    terminal.data.tool_calls !==
      toolValues.filter((call) => call.completed !== undefined).length
  ) {
    throw new Error("run.completed tool_calls does not match reconstructed tools");
  }
  if (
    terminal.type === "run.completed" &&
    patchValues.some(
      (attempt) =>
        attempt.applyStarted !== undefined &&
        attempt.applyCompleted === undefined,
    )
  ) {
    throw new Error("completed run contains an unknown patch apply state");
  }
  if (
    terminal.type === "run.completed" &&
    commandValues.some(
      (attempt) =>
        attempt.executionRequested !== undefined &&
        attempt.completed === undefined,
    )
  ) {
    throw new Error("completed run contains an unknown command effect");
  }

  if (first.data.command === "agent") {
    // PHASE4: 不同 terminal 有不同完成证明；成功要求 final step+aggregate usage，
    // budget terminal 则要求对应 limit/observed 能从事件历史重新计算。
    if (usage !== undefined) validateRunUsage(usage, steps);
    if (terminal.type === "run.completed") {
      const final = steps.at(-1)?.completed;
      if (
        activeStep !== undefined ||
        final?.outcome !== "final" ||
        final.text_chars === 0 ||
        steps.at(-1)?.sawNonWhitespaceText !== true ||
        terminal.data.steps !== steps.length ||
        terminal.data.model_turns !== steps.length ||
        usage === undefined
      ) {
        throw new Error("completed agent run lacks a final step or aggregate usage");
      }
    } else if (terminal.type === "run.budget_exceeded") {
      validateBudgetTerminal(first.data, terminal, steps, toolValues);
      if (terminal.data.reason === "repeated_tool_call") {
        const lastThree = toolValues.slice(-3);
        const fingerprints = lastThree.map(
          (call) => call.requested.fingerprint,
        );
        if (
          lastThree.length !== 3 ||
          fingerprints[0] === undefined ||
          !fingerprints.every((value) => value === fingerprints[0]) ||
          lastThree[2]?.completed?.error_code !== "repeated_call_blocked"
        ) {
          throw new Error("repeated_tool_call terminal lacks three matching calls");
        }
      }
    } else if (terminal.type === "run.failed" || terminal.type === "run.cancelled") {
      if (
        (terminal.data.steps !== undefined &&
          terminal.data.steps !== steps.length) ||
        (terminal.data.tool_calls !== undefined &&
          terminal.data.tool_calls !==
            toolValues.filter((call) => call.completed !== undefined).length)
      ) {
        throw new Error("agent terminal counts do not match event history");
      }
    }
  } else if (steps.length > 0) {
    throw new Error("chat session contains agent steps");
  }

  return {
    // PHASE4: interrupted 表示 step/tool 没有正常闭合；consumedByModel 只由后续 step 证实。
    agentSteps: steps.map((step) => ({
      ...(step.completed === undefined ? {} : { completed: step.completed }),
      interrupted: step.completed === undefined,
      ...(step.modelUsage === undefined ? {} : { modelUsage: step.modelUsage }),
      started: step.started,
    })),
    commandAttempts: commandValues.map((attempt) => ({
      ...(attempt.approvalDecided === undefined
        ? {}
        : { approvalDecided: attempt.approvalDecided }),
      ...(attempt.approvalRequested === undefined
        ? {}
        : { approvalRequested: attempt.approvalRequested }),
      ...(attempt.completed === undefined
        ? {}
        : { completed: attempt.completed }),
      effectState:
        attempt.executionRequested === undefined
          ? "none"
          : attempt.completed === undefined ||
              attempt.completed.cleanup_verified !== true
            ? "unknown"
            : "completed",
      ...(attempt.executionRequested === undefined
        ? {}
        : { executionRequested: attempt.executionRequested }),
      output: attempt.output,
      permission: attempt.permission,
      ...(attempt.started === undefined ? {} : { started: attempt.started }),
    })),
    output,
    patchAttempts: patchValues.map((attempt) => ({
      ...(attempt.applyCompleted === undefined
        ? {}
        : { applyCompleted: attempt.applyCompleted }),
      ...(attempt.applyStarted === undefined
        ? {}
        : { applyStarted: attempt.applyStarted }),
      applyState:
        attempt.applyStarted === undefined
          ? "none"
          : attempt.applyCompleted === undefined
            ? "unknown"
            : "completed",
      ...(attempt.approvalDecided === undefined
        ? {}
        : { approvalDecided: attempt.approvalDecided }),
      ...(attempt.approvalRequested === undefined
        ? {}
        : { approvalRequested: attempt.approvalRequested }),
      plan: attempt.plan,
    })),
    runId: first.run_id,
    sessionId: first.session_id,
    started: first.data,
    terminal,
    toolCalls: toolValues.map((call) => ({
      ...(call.completed === undefined ? {} : { completed: call.completed }),
      consumedByModel: call.consumedByModel,
      interrupted: call.completed === undefined,
      requested: call.requested,
    })),
    ...(usage === undefined ? {} : { usage }),
  };
}
