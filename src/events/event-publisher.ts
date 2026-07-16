import type { RunEvent, RunEventDraft } from "./run-event.js";
import { isTerminalRunEvent } from "./run-event.js";
import { runEventSchema } from "./run-event-schema.js";
import {
  completionVerificationIdsMatch,
  completionVerificationsMatchEvents,
} from "./verification-evidence-binding.js";
import {
  evidenceChangedPaths,
  evidenceDiffStat,
  netChangedPaths,
  sameDiffStat,
  samePaths,
} from "../completion/completion-evidence-bindings.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";

export interface RunEventRenderer {
  render(event: RunEvent): Promise<void> | void;
}

export interface EventPublisherOptions {
  readonly randomUUID: () => string;
  readonly renderer: RunEventRenderer;
  readonly runId: string;
  readonly sessionId: string;
  readonly timestamp: () => string;
  readonly writer: SessionWriter;
}

export class EventPersistenceError extends Error {
  constructor(cause: unknown) {
    super("session persistence failed", { cause });
    this.name = "EventPersistenceError";
  }
}

interface AgentStepState {
  // PHASE4: Publisher 维护写入时状态机，防止 step、usage、tool pair 和 terminal 顺序矛盾。
  completed: boolean;
  modelUsage?: Extract<RunEvent, { type: "model.usage" }>["data"];
  outcome?: "final" | "tool_call";
  textChars: number;
  toolCallId?: string;
}

interface ToolCallState {
  readonly argumentsJson: string;
  completed: boolean;
  readonly name: string;
  readonly step: number;
}

interface PatchPlanState {
  readonly callId: string;
  readonly planId: string;
  readonly step: number;
}

interface ApprovalState {
  readonly actionKind: "apply_patch" | "run_command";
  readonly actionSha256: string;
  readonly callId: string;
  decision?: "approved" | "cancelled" | "denied";
  readonly requestId: string;
  readonly planId?: string;
  readonly step: number;
}

interface PatchApplyState extends PatchPlanState {
  readonly approvalRequestId: string;
  completed: boolean;
  completedData?: Extract<RunEvent, { type: "patch.apply.completed" }>["data"];
}

interface PermissionState {
  readonly actionSha256: string;
  readonly effect: "allow" | "ask" | "deny";
  readonly step: number;
}

interface CommandExecutionState {
  readonly actionSha256: string;
  readonly callId: string;
  cleanupVerified?: boolean;
  completed: boolean;
  completedData?: Extract<RunEvent, { type: "command.completed" }>["data"];
  readonly executionId: string;
  readonly output: Extract<RunEvent, { type: "command.output" }>["data"][];
  readonly purpose: "inspect" | "verify";
  readonly requestedData: Extract<
    RunEvent,
    { type: "command.execution.requested" }
  >["data"];
  readonly step: number;
  stderrBytes: number;
  stderrChunks: number;
  stdoutBytes: number;
  stdoutChunks: number;
  started: boolean;
}

interface VerificationState {
  completed?: Extract<RunEvent, { type: "verification.completed" }>["data"];
  readonly started: Extract<RunEvent, { type: "verification.started" }>["data"];
}

interface CompletionCandidateState {
  readonly candidate: Extract<RunEvent, { type: "completion.candidate" }>["data"];
  evaluated?: Extract<RunEvent, { type: "completion.evaluated" }>["data"];
}

type CompletionEvidenceState = Extract<
  RunEvent,
  { type: "completion.evidence" }
>["data"];

function approvalActionSha256(
  data: Extract<RunEvent, { type: "approval.requested" | "approval.decided" }>["data"],
): string {
  return data.action === "apply_patch"
    ? (data.action_sha256 ?? data.plan_id)
    : data.action_sha256;
}

const REGISTRY_PRE_EXECUTION_ERROR_CODES = new Set([
  "arguments_schema_mismatch",
  "arguments_too_large",
  "invalid_arguments_json",
  "tool_cancelled",
]);

function isPreExecutionToolError(
  data: Extract<RunEvent, { type: "tool.call.completed" }>["data"],
): boolean {
  return data.status === "error" &&
    (data.error_category === "permission" ||
      (data.error_code !== undefined &&
        REGISTRY_PRE_EXECUTION_ERROR_CODES.has(data.error_code)));
}

function finishArgumentsMatch(
  argumentsJson: string,
  candidate: Extract<RunEvent, { type: "completion.candidate" }>["data"],
): boolean {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return (
      Object.keys(record).sort().join(",") === "status,summary" &&
      record.status === candidate.status &&
      record.summary === candidate.summary
    );
  } catch {
    return false;
  }
}

export class EventPublisher {
  private activeAgentStep: number | undefined;
  private readonly approvals = new Map<string, ApprovalState>();
  private readonly agentSteps = new Map<number, AgentStepState>();
  private command: "agent" | "chat" | undefined;
  private taskProfile: "read-only" | "coding" | undefined;
  private taskProfileExplicit = false;
  private outputChars = 0;
  private seq = 0;
  private started = false;
  private terminal = false;
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly commandExecutions = new Map<string, CommandExecutionState>();
  private readonly commandExecutionsByCall = new Map<string, string>();
  private readonly completionCandidates = new Map<string, CompletionCandidateState>();
  private readonly completionEvidence = new Map<string, CompletionEvidenceState>();
  private readonly patchApplies = new Map<string, PatchApplyState>();
  private readonly patchPlans = new Map<string, PatchPlanState>();
  private readonly permissions = new Map<string, PermissionState>();
  private readonly verifications = new Map<string, VerificationState>();
  private usagePublished = false;
  private verificationGeneration = 0;

  constructor(private readonly options: EventPublisherOptions) {}

  get outputLength(): number {
    return this.outputChars;
  }

  get completedToolCalls(): number {
    return [...this.toolCalls.values()].filter((call) => call.completed).length;
  }

  get startedAgentSteps(): number {
    return this.agentSteps.size;
  }

  async publish(draft: RunEventDraft): Promise<RunEvent> {
    // PHASE4: 持久化是 render、下一次 model observation 和真实 tool action 的审计边界；
    // writer 失败时内存状态不前进，调用方也不得继续产生未记录的副作用。
    // Persist-before-render is also the AgentLoop's audit boundary: no model/tool
    // action may depend on an event that failed to reach the session log.
    this.validateTransition(draft);
    const event = runEventSchema.parse({
      ...draft,
      event_id: this.options.randomUUID(),
      run_id: this.options.runId,
      schema_version: 1,
      seq: this.seq + 1,
      session_id: this.options.sessionId,
      timestamp: this.options.timestamp(),
    });
    try {
      await this.options.writer.write(event);
    } catch (error) {
      throw new EventPersistenceError(error);
    }
    this.applyTransition(event);
    await this.options.renderer.render(event);
    return event;
  }

  private validateTransition(draft: RunEventDraft): void {
    if (this.terminal) {
      throw new Error("cannot publish after terminal event");
    }
    if (!this.started && draft.type !== "run.started") {
      throw new Error("run.started must be the first event");
    }
    if (this.started && draft.type === "run.started") {
      throw new Error("run.started can only be published once");
    }
    if (draft.type === "usage" && this.usagePublished) {
      throw new Error("usage can only be published once");
    }

    if (this.command === "agent") {
      this.validateAgentTransition(draft);
    } else if (
      this.command === "chat" &&
      (draft.type === "agent.step.started" ||
        draft.type === "agent.step.completed" ||
        draft.type === "approval.decided" ||
        draft.type === "approval.requested" ||
        draft.type === "completion.candidate" ||
        draft.type === "completion.evidence" ||
        draft.type === "completion.evaluated" ||
        draft.type === "command.completed" ||
        draft.type === "command.execution.requested" ||
        draft.type === "command.output" ||
        draft.type === "command.started" ||
        draft.type === "model.usage" ||
        draft.type === "patch.apply.completed" ||
        draft.type === "patch.apply.started" ||
        draft.type === "patch.plan.created" ||
        draft.type === "permission.evaluated" ||
        draft.type === "run.budget_exceeded" ||
        draft.type === "run.incomplete" ||
        draft.type === "verification.completed" ||
        draft.type === "verification.started")
    ) {
      throw new Error("chat run cannot publish agent events");
    }
    if (
      this.command === "chat" &&
      draft.type === "run.completed" &&
      draft.data.completion_mode === "verified_finish_task"
    ) {
      throw new Error("chat run cannot claim verified finish_task completion");
    }

    if (draft.type === "tool.call.requested") {
      if (this.toolCalls.has(draft.data.call_id)) {
        throw new Error("tool call id must be unique");
      }
    }
    if (draft.type === "tool.call.completed") {
      const requested = this.toolCalls.get(draft.data.call_id);
      if (
        requested === undefined ||
        requested.completed ||
        requested.name !== draft.data.tool_name ||
        requested.step !== draft.data.step
      ) {
        throw new Error("tool result must match one pending tool call");
      }
      if (
        requested.name === "apply_patch" &&
        draft.data.status === "success" &&
        this.patchApplies.get(draft.data.call_id)?.completed !== true
      ) {
        throw new Error("successful apply_patch result requires completed apply evidence");
      }
      const permission = this.permissions.get(draft.data.call_id);
      const executionId = this.commandExecutionsByCall.get(draft.data.call_id);
      const execution =
        executionId === undefined
          ? undefined
          : this.commandExecutions.get(executionId);
      if (
        requested.name === "run_command" &&
        permission === undefined &&
        !isPreExecutionToolError(draft.data)
      ) {
        throw new Error("run_command result requires permission evidence");
      }
      if (
        requested.name === "run_command" &&
        permission?.effect === "ask" &&
        ![...this.approvals.values()].some(
          (approval) =>
            approval.callId === draft.data.call_id &&
            approval.actionKind === "run_command" &&
            approval.decision !== undefined,
        )
      ) {
        throw new Error("run_command result requires an approval decision");
      }
      if (
        requested.name === "run_command" &&
        execution !== undefined &&
        !execution.completed
      ) {
        throw new Error("run_command result cannot precede command completion");
      }
      if (
        requested.name === "run_command" &&
        draft.data.status === "success" &&
        (execution?.completed !== true || execution.cleanupVerified !== true)
      ) {
        throw new Error("successful run_command result requires completed command evidence");
      }
      if (requested.name === "finish_task") {
        const completion = this.completionCandidates.get(draft.data.call_id);
        const effect = completion?.evaluated?.effect;
        if (completion?.evaluated === undefined) {
          throw new Error("finish_task result requires a completion evaluation");
        }
        if (
          (effect === "continue" &&
            (draft.data.status !== "error" ||
              draft.data.error_code !== "completion_rejected")) ||
          (effect === "error" &&
            (draft.data.status !== "error" ||
              draft.data.error_code !== "completion_evaluation_failed")) ||
          (effect !== "continue" &&
            effect !== "error" &&
            draft.data.status !== "success")
        ) {
          throw new Error("finish_task result does not match completion effect");
        }
      }
    }
    if (
      draft.type === "run.completed" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.completed output_chars does not match text deltas");
    }
    if (
      (draft.type === "run.failed" || draft.type === "run.cancelled") &&
      draft.data.output_chars !== undefined &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error(`${draft.type} output_chars does not match text deltas`);
    }
    if (
      draft.type === "run.budget_exceeded" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.budget_exceeded output_chars does not match text deltas");
    }
    if (
      draft.type === "run.incomplete" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.incomplete output_chars does not match text deltas");
    }
    if (draft.type === "run.completed") {
      if ([...this.toolCalls.values()].some((call) => !call.completed)) {
        throw new Error("completed run cannot contain an interrupted tool call");
      }
      if (
        draft.data.tool_calls !== undefined &&
        draft.data.tool_calls !== this.completedToolCalls
      ) {
        throw new Error("run.completed tool_calls does not match tool events");
      }
      if (
        [...this.commandExecutions.values()].some(
          (execution) =>
            !execution.completed || execution.cleanupVerified !== true,
        )
      ) {
        throw new Error("completed run cannot contain an unknown command effect");
      }
    }
    if (
      draft.type === "run.incomplete" &&
      [...this.toolCalls.values()].some((call) => !call.completed)
    ) {
      throw new Error("incomplete run cannot contain an unmatched tool call");
    }
  }

  private validateAgentTransition(draft: RunEventDraft): void {
    // PHASE4: 这些检查发生在写盘前；任何非法 transition 都不会进入 session 或 renderer。
    if (draft.type === "agent.step.started") {
      const expected = this.agentSteps.size + 1;
      if (this.activeAgentStep !== undefined || draft.data.step !== expected) {
        throw new Error(`agent step must start at ${expected}`);
      }
      if (draft.data.step === 1 && draft.data.input_kind !== "user_task") {
        throw new Error("first agent step must consume the user task");
      }
      if (draft.data.step > 1) {
        // PHASE4: 后续 step 必须消费前一步已持久化完成的工具 observation。
        if (draft.data.input_kind !== "tool_result") {
          throw new Error("later agent steps must consume a tool result");
        }
        const previous = this.agentSteps.get(draft.data.step - 1);
        const call =
          previous?.toolCallId === undefined
            ? undefined
            : this.toolCalls.get(previous.toolCallId);
        if (
          previous?.completed !== true ||
          previous.outcome !== "tool_call" ||
          call?.completed !== true
        ) {
          throw new Error("tool_result step requires a completed previous tool call");
        }
      }
      return;
    }
    if (draft.type === "text.delta") {
      if (this.activeAgentStep === undefined) {
        throw new Error("agent text delta requires an active step");
      }
      if (
        (this.taskProfile === "coding" &&
          draft.data.visibility !== "internal_candidate") ||
        (this.taskProfile === "read-only" &&
          draft.data.visibility === "internal_candidate")
      ) {
        throw new Error("text delta visibility does not match task profile");
      }
      return;
    }
    if (draft.type === "model.usage") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        this.activeAgentStep !== draft.data.step ||
        step === undefined ||
        step.modelUsage !== undefined
      ) {
        throw new Error("model usage must appear once in its active step");
      }
      return;
    }
    if (draft.type === "agent.step.completed") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        this.activeAgentStep !== draft.data.step ||
        step === undefined ||
        step.completed
      ) {
        throw new Error("agent step completion must match one active step");
      }
      if (draft.data.text_chars !== step.textChars) {
        throw new Error("agent step text_chars does not match text deltas");
      }
      return;
    }
    if (draft.type === "tool.call.requested") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        step?.completed !== true ||
        step.outcome !== "tool_call" ||
        step.toolCallId !== draft.data.call_id
      ) {
        throw new Error("agent tool request must match a tool_call step");
      }
      return;
    }
    if (draft.type === "patch.plan.created") {
      const call = this.toolCalls.get(draft.data.call_id);
      if (
        call?.name !== "apply_patch" ||
        call.completed ||
        call.step !== draft.data.step ||
        this.patchPlans.has(draft.data.call_id)
      ) {
        throw new Error("patch plan must match one pending apply_patch call");
      }
      return;
    }
    if (draft.type === "permission.evaluated") {
      const call = this.toolCalls.get(draft.data.call_id);
      if (
        call?.name !== "run_command" ||
        call.completed ||
        call.step !== draft.data.step ||
        this.permissions.has(draft.data.call_id)
      ) {
        throw new Error("permission evaluation must match one pending run_command call");
      }
      return;
    }
    if (draft.type === "approval.requested") {
      if (this.approvals.has(draft.data.approval_request_id)) {
        throw new Error("approval request id must be unique");
      }
      if (
        [...this.approvals.values()].some(
          (approval) => approval.callId === draft.data.call_id,
        )
      ) {
        throw new Error("tool call can request approval only once");
      }
      if (draft.data.action === "apply_patch") {
        const plan = this.patchPlans.get(draft.data.call_id);
        if (
          plan?.planId !== draft.data.plan_id ||
          plan.step !== draft.data.step ||
          (draft.data.action_sha256 !== undefined &&
            draft.data.action_sha256 !== plan.planId)
        ) {
          throw new Error("approval request must match one patch plan");
        }
      } else {
        const call = this.toolCalls.get(draft.data.call_id);
        const permission = this.permissions.get(draft.data.call_id);
        if (
          call?.name !== "run_command" ||
          call.completed ||
          call.step !== draft.data.step ||
          permission?.effect !== "ask" ||
          permission.step !== draft.data.step ||
          permission.actionSha256 !== draft.data.action_sha256
        ) {
          throw new Error("command approval request must match an ask decision");
        }
      }
      return;
    }
    if (draft.type === "approval.decided") {
      const approval = this.approvals.get(draft.data.approval_request_id);
      if (
        approval === undefined ||
        approval.decision !== undefined ||
        approval.actionKind !== draft.data.action ||
        approval.callId !== draft.data.call_id ||
        approval.actionSha256 !== approvalActionSha256(draft.data) ||
        approval.step !== draft.data.step
      ) {
        throw new Error("approval decision must match one pending request");
      }
      if (
        draft.data.action === "apply_patch" &&
        approval.planId !== draft.data.plan_id
      ) {
        throw new Error("approval decision must match its patch plan");
      }
      return;
    }
    if (draft.type === "patch.apply.started") {
      const approval = this.approvals.get(draft.data.approval_request_id);
      if (
        approval?.decision !== "approved" ||
        approval.callId !== draft.data.call_id ||
        approval.planId !== draft.data.plan_id ||
        approval.step !== draft.data.step ||
        this.patchApplies.has(draft.data.call_id)
      ) {
        throw new Error("patch apply must follow its approved request");
      }
      return;
    }
    if (draft.type === "patch.apply.completed") {
      const apply = this.patchApplies.get(draft.data.call_id);
      if (
        apply === undefined ||
        apply.completed ||
        apply.approvalRequestId !== draft.data.approval_request_id ||
        apply.planId !== draft.data.plan_id ||
        apply.step !== draft.data.step
      ) {
        throw new Error("patch completion must match one started apply");
      }
      return;
    }
    if (draft.type === "command.execution.requested") {
      // PHASE6: this event must persist before spawn; failure after this point but before
      // command.started is conservatively an unknown effect during cross-process replay.
      const call = this.toolCalls.get(draft.data.call_id);
      const permission = this.permissions.get(draft.data.call_id);
      const approval = [...this.approvals.values()].find(
        (candidate) =>
          candidate.callId === draft.data.call_id &&
          candidate.actionKind === "run_command",
      );
      const approvalMatches =
        permission?.effect === "ask"
          ? approval?.decision === "approved" &&
            approval.requestId === draft.data.approval_request_id &&
            approval.actionSha256 === draft.data.action_sha256
          : draft.data.approval_request_id === undefined;
      if (
        call?.name !== "run_command" ||
        call.completed ||
        call.step !== draft.data.step ||
        permission === undefined ||
        permission.effect === "deny" ||
        permission.step !== draft.data.step ||
        permission.actionSha256 !== draft.data.action_sha256 ||
        !approvalMatches ||
        this.commandExecutions.has(draft.data.execution_id) ||
        this.commandExecutionsByCall.has(draft.data.call_id)
      ) {
        throw new Error("command execution request lacks matching permission");
      }
      return;
    }
    if (draft.type === "command.started") {
      const execution = this.commandExecutions.get(draft.data.execution_id);
      if (
        execution === undefined ||
        execution.started ||
        execution.completed ||
        execution.callId !== draft.data.call_id ||
        execution.step !== draft.data.step ||
        execution.actionSha256 !== draft.data.action_sha256
      ) {
        throw new Error("command start must match one execution request");
      }
      return;
    }
    if (draft.type === "command.output") {
      const execution = this.commandExecutions.get(draft.data.execution_id);
      const expectedIndex =
        draft.data.channel === "stdout"
          ? execution?.stdoutChunks
          : execution?.stderrChunks;
      if (
        execution === undefined ||
        !execution.started ||
        execution.completed ||
        execution.callId !== draft.data.call_id ||
        execution.step !== draft.data.step ||
        execution.actionSha256 !== draft.data.action_sha256 ||
        draft.data.chunk_index !== expectedIndex
      ) {
        throw new Error("command output must be contiguous for one active execution");
      }
      return;
    }
    if (draft.type === "command.completed") {
      const execution = this.commandExecutions.get(draft.data.execution_id);
      const completedBeforeStart =
        execution?.started === false &&
        (draft.data.termination === "spawn_error" ||
          draft.data.termination === "cancelled") &&
        draft.data.stdout_bytes === 0 &&
        draft.data.stderr_bytes === 0;
      if (
        execution === undefined ||
        (!execution.started && !completedBeforeStart) ||
        execution.completed ||
        execution.callId !== draft.data.call_id ||
        execution.step !== draft.data.step ||
        execution.actionSha256 !== draft.data.action_sha256 ||
        execution.stdoutBytes !== draft.data.stdout_bytes ||
        execution.stderrBytes !== draft.data.stderr_bytes
      ) {
        throw new Error("command completion must match one active execution and its bytes");
      }
      return;
    }
    if (draft.type === "verification.started") {
      // PHASE7: the before-snapshot is persisted before spawn so a test cannot silently
      // rewrite source/HEAD/index and establish its own new "passing" baseline.
      const execution = this.commandExecutions.get(
        draft.data.command_execution_id,
      );
      if (
        this.taskProfile !== "coding" ||
        execution === undefined ||
        execution.purpose !== "verify" ||
        execution.started ||
        execution.completed ||
        execution.callId !== draft.data.call_id ||
        execution.step !== draft.data.step ||
        execution.actionSha256 !== draft.data.action_sha256 ||
        draft.data.generation !== this.verificationGeneration ||
        this.verifications.has(draft.data.verification_id)
      ) {
        throw new Error("verification start must match one approved pending verify command");
      }
      return;
    }
    if (draft.type === "verification.completed") {
      const verification = this.verifications.get(draft.data.verification_id);
      const execution = this.commandExecutions.get(
        draft.data.command_execution_id,
      );
      const commandCompleted = execution?.completedData;
      // PHASE7: exit_code alone is not proof of a completed verifier. Preserve
      // the command's first-cause termination and reject any passed claim unless
      // the process reached a normal exit.
      const verificationExitCode =
        commandCompleted?.termination === "exit"
          ? commandCompleted.exit_code
          : null;
      if (
        verification === undefined ||
        verification.completed !== undefined ||
        execution === undefined ||
        commandCompleted === undefined ||
        execution.cleanupVerified !== true ||
        verification.started.call_id !== draft.data.call_id ||
        verification.started.step !== draft.data.step ||
        verification.started.command_execution_id !==
          draft.data.command_execution_id ||
        verification.started.action_sha256 !== draft.data.action_sha256 ||
        verification.started.generation !== draft.data.started_generation ||
        draft.data.completed_generation !== this.verificationGeneration ||
        verification.started.snapshot_sha256 !==
          draft.data.before_snapshot_sha256 ||
        commandCompleted.duration_ms !== draft.data.duration_ms ||
        verificationExitCode !== draft.data.exit_code ||
        (draft.data.status === "passed" &&
          commandCompleted.termination !== "exit")
      ) {
        throw new Error("verification completion does not match command and start evidence");
      }
      return;
    }
    if (draft.type === "completion.evidence") {
      if (
        this.taskProfile !== "coding" ||
        draft.data.evidence.runId !== this.options.runId ||
        draft.data.evidence.sessionId !== this.options.sessionId ||
        this.completionEvidence.has(draft.data.evidence_sha256)
      ) {
        throw new Error("completion evidence must be a unique projection for this run");
      }
      const changedPaths = netChangedPaths(
        [...this.patchApplies.values()].flatMap((apply) =>
          apply.completedData === undefined ? [] : [apply.completedData]
        ),
      );
      if (
        !samePaths(changedPaths, evidenceChangedPaths(draft.data.evidence))
      ) {
        throw new Error("completion evidence changed paths do not match patch journal");
      }
      const classifiedExecutions = new Set(
        [...this.verifications.values()].map(
          (verification) => verification.started.command_execution_id,
        ),
      );
      const hasCompletedUnclassifiedVerification = [
        ...this.commandExecutions.values(),
      ].some(
        (execution) =>
          execution.purpose === "verify" &&
          execution.completedData !== undefined &&
          execution.cleanupVerified === true &&
          this.toolCalls.get(execution.callId)?.completed === true &&
          !classifiedExecutions.has(execution.executionId),
      );
      if (
        !completionVerificationsMatchEvents(draft.data, (verificationId) => {
          const verification = this.verifications.get(verificationId);
          const execution =
            verification === undefined
              ? undefined
              : this.commandExecutions.get(
                  verification.started.command_execution_id,
                );
          if (
            verification?.completed === undefined ||
            execution?.completedData === undefined
          ) {
            return undefined;
          }
          return {
            commandCompleted: execution.completedData,
            commandOutput: execution.output,
            commandRequested: execution.requestedData,
            verificationCompleted: verification.completed,
            verificationStarted: verification.started,
          };
        }, hasCompletedUnclassifiedVerification)
      ) {
        throw new Error("completion verification evidence does not match events");
      }
      return;
    }
    if (draft.type === "completion.candidate") {
      const call = this.toolCalls.get(draft.data.call_id);
      if (
        this.taskProfile !== "coding" ||
        call?.name !== "finish_task" ||
        call.completed ||
        call.step !== draft.data.step ||
        this.completionCandidates.has(draft.data.call_id) ||
        !finishArgumentsMatch(call.argumentsJson, draft.data)
      ) {
        throw new Error("completion candidate must match one pending finish_task call");
      }
      return;
    }
    if (draft.type === "completion.evaluated") {
      const completion = this.completionCandidates.get(draft.data.call_id);
      const call = this.toolCalls.get(draft.data.call_id);
      if (
        completion === undefined ||
        completion.evaluated !== undefined ||
        call?.completed === true ||
        completion.candidate.step !== draft.data.step ||
        completion.candidate.candidate_sha256 !== draft.data.candidate_sha256
      ) {
        throw new Error("completion evaluation must match one pending candidate");
      }
      if (
        completion.candidate.status === "blocked" &&
        draft.data.effect !== "error" &&
        (draft.data.effect !== "incomplete" ||
          !draft.data.reasons.includes("task_blocked"))
      ) {
        throw new Error("blocked finish candidate must evaluate to task_blocked");
      }
      const changedPaths = netChangedPaths(
        [...this.patchApplies.values()].flatMap((apply) =>
          apply.completedData === undefined ? [] : [apply.completedData]
        ),
      );
      if (
        draft.data.effect !== "error" &&
        !samePaths(changedPaths, draft.data.changed_paths)
      ) {
        throw new Error("completion changed paths do not match patch journal");
      }
      const evidence =
        draft.data.evidence_sha256 === undefined
          ? undefined
          : this.completionEvidence.get(draft.data.evidence_sha256);
      if (
        draft.data.effect !== "continue" &&
        draft.data.effect !== "error"
      ) {
        const expectedOutcome =
          draft.data.effect === "accept" ? "completed" : "incomplete";
        if (
          evidence === undefined ||
          evidence.outcome !== expectedOutcome ||
          evidence.report_sha256 !== draft.data.report_sha256 ||
          evidence.evidence.modelNarrative !== completion.candidate.summary ||
          (evidence.outcome === "incomplete" &&
            !draft.data.reasons.includes(evidence.evidence.reason))
        ) {
          throw new Error("completion evaluation lacks matching persisted evidence");
        }
        if (
          !samePaths(
            draft.data.changed_paths,
            evidenceChangedPaths(evidence.evidence),
          )
        ) {
          throw new Error("completion changed paths do not match persisted evidence");
        }
        if (
          !sameDiffStat(
            draft.data.diff_stat,
            evidenceDiffStat(evidence.evidence),
          )
        ) {
          throw new Error("completion diff stat does not match persisted evidence");
        }
      }
      if (draft.data.effect === "accept") {
        const allCurrentPassed = draft.data.verification_ids.every((id) => {
          const verification = this.verifications.get(id)?.completed;
          return (
            verification?.status === "passed" &&
            !verification.stale &&
            verification.completed_generation === this.verificationGeneration
          );
        });
        if (
          evidence === undefined ||
          !completionVerificationIdsMatch(
            evidence,
            draft.data.verification_ids,
          ) ||
          draft.data.verification_ids.length === 0 ||
          !allCurrentPassed
        ) {
          throw new Error("accepted completion references invalid verification evidence");
        }
      }
      return;
    }
    if (draft.type === "usage") {
      // PHASE4: run usage 只能在 step 外发布，且必须逐字段等于全部 model.usage 的和。
      if (this.activeAgentStep !== undefined) {
        throw new Error("run usage cannot appear inside an agent step");
      }
      const usages = [...this.agentSteps.values()].map((step) => step.modelUsage);
      if (usages.some((usage) => usage === undefined)) {
        throw new Error("agent run usage requires usage for every step");
      }
      const known = usages.filter((usage) => usage !== undefined);
      const cached = known
        .map((usage) => usage.cached_input_tokens)
        .filter((value) => value !== undefined);
      if (
        draft.data.input_tokens !==
          known.reduce((sum, usage) => sum + usage.input_tokens, 0) ||
        draft.data.output_tokens !==
          known.reduce((sum, usage) => sum + usage.output_tokens, 0) ||
        draft.data.total_tokens !==
          known.reduce((sum, usage) => sum + usage.total_tokens, 0) ||
        draft.data.model_turns !== known.length ||
        (cached.length === 0
          ? draft.data.cached_input_tokens !== undefined
          : draft.data.cached_input_tokens !==
            cached.reduce((sum, value) => sum + value, 0)) ||
        draft.data.usage_incomplete === true
      ) {
        throw new Error("run usage does not match model usage events");
      }
      return;
    }
    if (draft.type === "run.completed") {
      // PHASE7: coding completion is a persisted policy decision paired with finish_task;
      // the model's natural-language final remains only a candidate.
      const finalStep = this.agentSteps.get(this.agentSteps.size);
      if (
        this.activeAgentStep !== undefined ||
        finalStep?.completed !== true ||
        draft.data.steps !== this.agentSteps.size ||
        draft.data.model_turns !== this.agentSteps.size ||
        !this.usagePublished
      ) {
        throw new Error("agent completion does not match completed step evidence");
      }
      if (
        (this.taskProfile === "coding" &&
          draft.data.completion_mode !== "verified_finish_task") ||
        (this.taskProfile === "read-only" &&
          ((this.taskProfileExplicit &&
            draft.data.completion_mode !== "model_final") ||
            draft.data.completion_mode === "verified_finish_task"))
      ) {
        throw new Error("completion mode does not match task profile");
      }
      if (draft.data.completion_mode === "verified_finish_task") {
        const callId = finalStep.toolCallId;
        const completion =
          callId === undefined
            ? undefined
            : this.completionCandidates.get(callId)?.evaluated;
        const tool = callId === undefined ? undefined : this.toolCalls.get(callId);
        if (
          finalStep.outcome !== "tool_call" ||
          tool?.name !== "finish_task" ||
          tool.completed !== true ||
          completion?.effect !== "accept" ||
          completion.evidence_sha256 !== draft.data.evidence_sha256 ||
          completion.report_sha256 !== draft.data.report_sha256
        ) {
          throw new Error("verified completion lacks accepted finish_task evidence");
        }
      } else if (finalStep.outcome !== "final") {
        throw new Error("model-final completion requires a final agent step");
      }
      return;
    }
    if (draft.type === "run.incomplete") {
      const finalStep = this.agentSteps.get(this.agentSteps.size);
      if (
        this.activeAgentStep !== undefined ||
        draft.data.steps !== this.agentSteps.size ||
        draft.data.tool_calls !== this.completedToolCalls ||
        !this.usagePublished
      ) {
        throw new Error("run.incomplete counts do not match agent evidence");
      }
      if (draft.data.evidence_sha256 !== undefined) {
        const evidence = this.completionEvidence.get(draft.data.evidence_sha256);
        if (
          evidence?.outcome !== "incomplete" ||
          evidence.report_sha256 !== draft.data.report_sha256 ||
          evidence.evidence.reason !== draft.data.reason
        ) {
          throw new Error("run.incomplete lacks matching persisted evidence");
        }
      }
      if (
        draft.data.reason === "completion_signal_required" &&
        (this.taskProfile !== "coding" || finalStep?.outcome !== "final")
      ) {
        throw new Error("completion signal terminal requires a coding model final");
      }
      if (
        finalStep?.outcome === "tool_call" &&
        finalStep.toolCallId !== undefined &&
        this.toolCalls.get(finalStep.toolCallId)?.name === "finish_task"
      ) {
        const completion = this.completionCandidates.get(
          finalStep.toolCallId,
        )?.evaluated;
        if (
          completion?.effect !== "incomplete" ||
          !completion.reasons.includes(draft.data.reason) ||
          completion.evidence_sha256 !== draft.data.evidence_sha256 ||
          completion.report_sha256 !== draft.data.report_sha256
        ) {
          throw new Error("run.incomplete does not match finish_task evidence");
        }
      }
      if (draft.data.reason === "task_blocked") {
        const callId = finalStep?.toolCallId;
        const completion =
          callId === undefined
            ? undefined
            : this.completionCandidates.get(callId)?.evaluated;
        const tool = callId === undefined ? undefined : this.toolCalls.get(callId);
        if (
          finalStep?.outcome !== "tool_call" ||
          completion?.effect !== "incomplete" ||
          !completion.reasons.includes("task_blocked") ||
          tool?.completed !== true
        ) {
          throw new Error("task_blocked terminal lacks matching finish_task evidence");
        }
      }
      return;
    }
    if (draft.type === "run.budget_exceeded") {
      // PHASE4: budget terminal 的 step/tool 计数必须与已落盘事件一致，不能相信调用方自报。
      if (
        draft.data.steps !== this.agentSteps.size ||
        draft.data.tool_calls !== this.completedToolCalls
      ) {
        throw new Error("budget terminal counts do not match agent events");
      }
      return;
    }
    if (draft.type === "run.failed" || draft.type === "run.cancelled") {
      if (
        (draft.data.steps !== undefined &&
          draft.data.steps !== this.agentSteps.size) ||
        (draft.data.tool_calls !== undefined &&
          draft.data.tool_calls !== this.completedToolCalls)
      ) {
        throw new Error("agent terminal counts do not match agent events");
      }
    }
  }

  private applyTransition(event: RunEvent): void {
    this.seq = event.seq;
    if (event.type === "run.started") {
      this.started = true;
      this.command = event.data.command;
      if (event.data.command === "agent") {
        this.taskProfile = event.data.task_profile ?? "read-only";
        this.taskProfileExplicit = event.data.task_profile !== undefined;
      }
    } else if (event.type === "text.delta") {
      this.outputChars += event.data.delta.length;
      if (this.activeAgentStep !== undefined) {
        const step = this.agentSteps.get(this.activeAgentStep);
        if (step !== undefined) step.textChars += event.data.delta.length;
      }
    } else if (event.type === "agent.step.started") {
      this.agentSteps.set(event.data.step, {
        completed: false,
        textChars: 0,
      });
      this.activeAgentStep = event.data.step;
    } else if (event.type === "model.usage") {
      const step = this.agentSteps.get(event.data.step);
      if (step !== undefined) step.modelUsage = event.data;
    } else if (event.type === "agent.step.completed") {
      const step = this.agentSteps.get(event.data.step);
      if (step !== undefined) {
        step.completed = true;
        step.outcome = event.data.outcome;
        if (event.data.tool_call_id !== undefined) {
          step.toolCallId = event.data.tool_call_id;
        }
      }
      this.activeAgentStep = undefined;
    } else if (event.type === "usage") {
      this.usagePublished = true;
    } else if (event.type === "tool.call.requested") {
      this.toolCalls.set(event.data.call_id, {
        argumentsJson: event.data.arguments_json,
        completed: false,
        name: event.data.tool_name,
        step: event.data.step,
      });
    } else if (event.type === "tool.call.completed") {
      const requested = this.toolCalls.get(event.data.call_id);
      if (requested !== undefined) requested.completed = true;
    } else if (event.type === "patch.plan.created") {
      this.patchPlans.set(event.data.call_id, {
        callId: event.data.call_id,
        planId: event.data.plan_id,
        step: event.data.step,
      });
    } else if (event.type === "permission.evaluated") {
      this.permissions.set(event.data.call_id, {
        actionSha256: event.data.action_sha256,
        effect: event.data.effect,
        step: event.data.step,
      });
    } else if (event.type === "approval.requested") {
      this.approvals.set(event.data.approval_request_id, {
        actionKind: event.data.action,
        actionSha256: approvalActionSha256(event.data),
        callId: event.data.call_id,
        requestId: event.data.approval_request_id,
        step: event.data.step,
        ...(event.data.action === "apply_patch"
          ? { planId: event.data.plan_id }
          : {}),
      });
    } else if (event.type === "approval.decided") {
      const approval = this.approvals.get(event.data.approval_request_id);
      if (approval !== undefined) approval.decision = event.data.decision;
    } else if (event.type === "patch.apply.started") {
      this.patchApplies.set(event.data.call_id, {
        approvalRequestId: event.data.approval_request_id,
        callId: event.data.call_id,
        completed: false,
        planId: event.data.plan_id,
        step: event.data.step,
      });
    } else if (event.type === "patch.apply.completed") {
      const apply = this.patchApplies.get(event.data.call_id);
      if (apply !== undefined) {
        apply.completed = true;
        apply.completedData = event.data;
        this.verificationGeneration += 1;
      }
    } else if (event.type === "command.execution.requested") {
      this.commandExecutions.set(event.data.execution_id, {
        actionSha256: event.data.action_sha256,
        callId: event.data.call_id,
        completed: false,
        executionId: event.data.execution_id,
        output: [],
        purpose: event.data.purpose,
        requestedData: event.data,
        step: event.data.step,
        stderrBytes: 0,
        stderrChunks: 0,
        stdoutBytes: 0,
        stdoutChunks: 0,
        started: false,
      });
      this.commandExecutionsByCall.set(
        event.data.call_id,
        event.data.execution_id,
      );
    } else if (event.type === "command.started") {
      const execution = this.commandExecutions.get(event.data.execution_id);
      if (execution !== undefined) execution.started = true;
    } else if (event.type === "command.output") {
      const execution = this.commandExecutions.get(event.data.execution_id);
      if (execution !== undefined) {
        execution.output.push(event.data);
        if (event.data.channel === "stdout") {
          execution.stdoutBytes += event.data.bytes;
          execution.stdoutChunks += 1;
        } else {
          execution.stderrBytes += event.data.bytes;
          execution.stderrChunks += 1;
        }
      }
    } else if (event.type === "command.completed") {
      const execution = this.commandExecutions.get(event.data.execution_id);
      if (execution !== undefined) {
        execution.completed = true;
        execution.completedData = event.data;
        execution.cleanupVerified = event.data.cleanup_verified;
      }
    } else if (event.type === "verification.started") {
      this.verifications.set(event.data.verification_id, {
        started: event.data,
      });
    } else if (event.type === "verification.completed") {
      const verification = this.verifications.get(event.data.verification_id);
      if (verification !== undefined) verification.completed = event.data;
    } else if (event.type === "completion.candidate") {
      this.completionCandidates.set(event.data.call_id, {
        candidate: event.data,
      });
    } else if (event.type === "completion.evidence") {
      this.completionEvidence.set(event.data.evidence_sha256, event.data);
    } else if (event.type === "completion.evaluated") {
      const completion = this.completionCandidates.get(event.data.call_id);
      if (completion !== undefined) completion.evaluated = event.data;
    }
    if (isTerminalRunEvent(event)) this.terminal = true;
  }
}
