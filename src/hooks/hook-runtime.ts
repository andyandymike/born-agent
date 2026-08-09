import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { CapabilitySnapshotV1, FrozenCapabilityRecord } from "../capabilities/capability-types.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { ParsedCapabilityComponent } from "../capabilities/plugin-manifest-schema.js";
import { HookError } from "./hook-errors.js";
import {
  HookCommandExecutionError,
  type HookCommandRunnerLike,
  type HookCommandRunnerResult,
} from "./hook-command-runner.js";
import type {
  Phase18HookRunEventData,
  Phase18HookRunEventType,
} from "./hook-event-schema.js";
import type {
  EffectHookPipeline,
  HookActionProjection,
  HookEventV1,
  HookPipelineDecision,
  HookPipelineInput,
} from "./hook-pipeline.js";

type HookMetadata = Extract<ParsedCapabilityComponent, { kind: "hook" }>;

interface FrozenHook {
  readonly metadata: HookMetadata;
  readonly record: FrozenCapabilityRecord;
}

export interface HookDurableFacts {
  readonly cleanEffectReconciliation: boolean;
  readonly cleanEffectReconciliationEvidence: readonly string[];
  readonly currentVerifications: readonly {
    readonly command: string;
    readonly evidence: readonly string[];
  }[];
  readonly planApproved: boolean;
  readonly planApprovalEvidence: readonly string[];
}

export interface HookEventAppender {
  append<TType extends Phase18HookRunEventType>(
    type: TType,
    data: Phase18HookRunEventData<TType>,
    eventId?: string,
  ): Promise<void>;
}

const KNOWN_ACTION_KINDS = new Set([
  "apply_patch",
  "run_command",
  "mcp.tool.call",
  "mcp.resource.read",
  "mcp.prompt.get",
  "finish_task",
]);

function hooks(snapshot: CapabilitySnapshotV1): readonly FrozenHook[] {
  const values = snapshot.plugins.flatMap((plugin) => plugin.components)
    .filter((record) => record.identity.kind === "hook")
    .map((record): FrozenHook => {
      if (record.metadata.kind !== "hook") throw new HookError("hook_manifest_invalid", "Hook metadata kind is inconsistent");
      for (const actionKind of [
        ...(record.metadata.matcher?.action_kinds ?? []),
        ...(record.metadata.handler.type === "declarative_gate" && record.metadata.handler.predicate.type === "deny_action_kinds"
          ? record.metadata.handler.predicate.action_kinds
          : []),
      ]) {
        if (!KNOWN_ACTION_KINDS.has(actionKind)) {
          throw new HookError("hook_manifest_invalid", `unknown Hook action kind: ${actionKind}`);
        }
      }
      return Object.freeze({ metadata: record.metadata, record });
    })
    .sort((left, right) => left.record.identity.qualifiedId.localeCompare(right.record.identity.qualifiedId));
  if (values.length > 32) throw new HookError("hook_match_limit_exceeded", "a run may enable at most 32 Hooks");
  return Object.freeze(values);
}

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matches(hook: FrozenHook, event: HookEventV1, action: HookActionProjection | undefined): boolean {
  if (hook.metadata.event !== event) return false;
  const matcher = hook.metadata.matcher;
  if (matcher === undefined) return true;
  if (matcher.tool_names !== undefined && (action?.toolName === undefined || !matcher.tool_names.includes(action.toolName))) return false;
  if (matcher.action_kinds !== undefined && (action?.actionKind === undefined || !matcher.action_kinds.includes(action.actionKind))) return false;
  if (matcher.path_prefixes !== undefined && !matcher.path_prefixes.some((prefix) => action?.paths?.some((path) => pathMatches(prefix, path)))) return false;
  if (matcher.capability_ids !== undefined && !matcher.capability_ids.some((id) => action?.capabilityIds?.includes(id))) return false;
  if (matcher.terminal_states !== undefined && (action?.terminalState === undefined || !matcher.terminal_states.includes(action.terminalState))) return false;
  return true;
}

function declarativeDecision(
  hook: FrozenHook,
  action: HookActionProjection | undefined,
  facts: HookDurableFacts,
): HookPipelineDecision {
  if (hook.metadata.handler.type !== "declarative_gate") {
    throw new HookError("hook_event_unsupported", "command Hook runner is unavailable");
  }
  const predicate = hook.metadata.handler.predicate;
  let passed: boolean;
  let evidence: readonly string[] = [];
  switch (predicate.type) {
    case "require_plan_approval":
      passed = facts.planApproved;
      evidence = facts.planApprovalEvidence;
      break;
    case "deny_path_prefixes":
      passed = !predicate.prefixes.some((prefix) => action?.paths?.some((path) => pathMatches(prefix, path)));
      break;
    case "require_latest_verification":
      {
        const current = new Map(
          facts.currentVerifications.map((verification) => [verification.command, verification]),
        );
        const selected = predicate.commands.map((command) => current.get(command));
        passed = selected.every((verification) => verification !== undefined);
        evidence = selected.flatMap((verification) => verification?.evidence ?? []);
      }
      break;
    case "deny_action_kinds":
      passed = action?.actionKind === undefined || !predicate.action_kinds.includes(action.actionKind);
      break;
    case "require_clean_effect_reconciliation":
      passed = facts.cleanEffectReconciliation;
      evidence = facts.cleanEffectReconciliationEvidence;
      break;
  }
  // PHASE18: a Hook has no allow output. no_objection merely leaves all
  // existing policy, approval, mode, source, and completion gates intact.
  return passed
    ? Object.freeze({ decision: "no_objection", evidence: Object.freeze([...new Set(evidence)]) })
    : Object.freeze({
        code: "hook_gate_denied",
        decision: "deny",
        evidence: Object.freeze([...new Set(evidence)]),
        message: hook.metadata.handler.message,
      });
}

export class HookRuntime implements EffectHookPipeline {
  readonly #hooks: readonly FrozenHook[];
  #invocations = 0;

  constructor(private readonly options: {
    readonly artifacts: ArtifactSessionRuntimeLike;
    readonly commandRunner?: HookCommandRunnerLike;
    readonly events: HookEventAppender;
    readonly facts: () => HookDurableFacts;
    readonly randomUUID: () => string;
    readonly runId: string;
    readonly sessionId: string;
    readonly snapshot: CapabilitySnapshotV1;
    readonly timestamp: () => string;
    readonly workspaceLogicalId: string;
  }) {
    this.#hooks = hooks(options.snapshot);
  }

  list(): readonly Readonly<Record<string, unknown>>[] {
    return Object.freeze(this.#hooks.map((hook) => Object.freeze({
      event: hook.metadata.event,
      failure_policy: hook.metadata.failure_policy,
      handler: hook.metadata.handler.type,
      hook_id: hook.record.identity.qualifiedId,
      mode: hook.metadata.mode,
      timeout_ms: hook.metadata.timeout_ms ?? 10_000,
    })));
  }

  async run(
    event: HookEventV1,
    input: HookPipelineInput,
    signal: AbortSignal,
  ): Promise<HookPipelineDecision> {
    if (signal.aborted) throw new HookError("hook_invocation_cancelled", "Hook pipeline was cancelled");
    const matched = this.#hooks.filter((hook) => matches(hook, event, input.action));
    if (matched.length > 8) throw new HookError("hook_match_limit_exceeded", "more than eight Hooks matched one lifecycle event");
    let denied: HookPipelineDecision | undefined;
    const evidence: string[] = [];
    for (const [order, hook] of matched.entries()) {
      if (this.#invocations >= 128) throw new HookError("hook_invocation_limit_exceeded", "Hook invocation budget is exhausted");
      this.#invocations += 1;
      const invocationId = this.options.randomUUID();
      const envelope = {
        ...(input.action === undefined ? {} : { original_action: input.action }),
        ...(input.completion === undefined ? {} : { completion: input.completion }),
        event,
        hook_identity: hook.record.identity,
        invocation_id: invocationId,
        mode: hook.metadata.mode,
        occurred_at: this.options.timestamp(),
        ...(input.result === undefined ? {} : { result: input.result }),
        run_id: this.options.runId,
        schema_version: 1,
        session_id: this.options.sessionId,
        workspace: { logical_id: this.options.workspaceLogicalId },
      } as const;
      const serialized = canonicalJson(envelope);
      if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
        if (hook.metadata.mode === "gate") throw new HookError("hook_gate_output_invalid", "Hook input exceeds 64 KiB");
        await this.options.events.append("hook.invocation.failed", {
          code: "hook_observer_degraded",
          effect_state: "none",
          failure_policy: hook.metadata.failure_policy,
          invocation_id: invocationId,
        });
        continue;
      }
      const inputSha256 = sha256Canonical(envelope);
      await this.options.events.append("hook.matched", {
        event,
        hook_identity: { ...hook.record.identity, kind: "hook" },
        input_sha256: inputSha256,
        invocation_id: invocationId,
        order,
        ...(input.action?.originalActionSha256 === undefined ? {} : { original_action_sha256: input.action.originalActionSha256 }),
      });
      const requestedEventId = this.options.randomUUID();
      await this.options.events.append("hook.invocation.requested", {
        event,
        handler: hook.metadata.handler.type,
        hook_identity: { ...hook.record.identity, kind: "hook" },
        hook_input_artifact_id: `sha256:${inputSha256}`,
        hook_input_sha256: inputSha256,
        invocation_id: invocationId,
        mode: hook.metadata.mode,
      }, requestedEventId);
      await this.options.artifacts.materializeText({
        bytes: Buffer.from(serialized, "utf8"),
        expectedSha256: inputSha256,
        mediaType: "text/plain; charset=utf-8",
        originEventId: requestedEventId,
      });
      if (denied !== undefined && hook.metadata.mode === "gate") {
        await this.options.events.append("hook.invocation.failed", {
          code: "hook_short_circuited",
          effect_state: "none",
          failure_policy: hook.metadata.failure_policy,
          invocation_id: invocationId,
        });
        continue;
      }
      if (hook.metadata.handler.type === "command") {
        if (this.options.commandRunner === undefined) {
          const code = hook.metadata.mode === "gate" ? "hook_event_unsupported" : "hook_observer_degraded";
          await this.options.events.append("hook.invocation.failed", {
            code,
            effect_state: "none",
            failure_policy: hook.metadata.failure_policy,
            invocation_id: invocationId,
          });
          if (hook.metadata.mode === "gate") {
            denied = { code, decision: "deny", invocationId, message: "command Hook runner is unavailable" };
          }
          continue;
        }
        let result: HookCommandRunnerResult;
        try {
          result = await this.options.commandRunner.run({
            events: {
              approvalDecided: async (approval) => this.options.events.append("hook.approval.decided", {
                action_sha256: approval.actionSha256,
                approval_request_id: approval.requestId,
                decision: approval.decision,
                invocation_id: approval.invocationId,
              }),
              approvalRequested: async (approval) => this.options.events.append("hook.approval.requested", {
                action_sha256: approval.actionSha256,
                approval_request_id: approval.requestId,
                invocation_id: approval.invocationId,
              }),
              permissionEvaluated: async (permission) => this.options.events.append("hook.permission.evaluated", {
                action_sha256: permission.actionSha256,
                effect: permission.effect,
                invocation_id: permission.invocationId,
                reason_code: permission.reasonCode,
              }),
              started: async (started) => this.options.events.append("hook.invocation.started", {
                action_sha256: started.actionSha256,
                invocation_id: started.invocationId,
                pid: started.pid,
                process_identity_sha256: started.processIdentitySha256,
              }),
            },
            hook: hook.record,
            inputBytes: Buffer.from(serialized, "utf8"),
            inputSha256,
            invocationId,
            signal,
          });
        } catch (error) {
          if (!(error instanceof HookCommandExecutionError)) throw error;
          await this.options.events.append("hook.invocation.failed", {
            code: error.code,
            effect_state: error.effectState,
            failure_policy: hook.metadata.failure_policy,
            invocation_id: invocationId,
          });
          if (error.effectState === "unknown") {
            throw new HookError("hook_effect_unknown", error.message, 1, { cause: error });
          }
          if (error.code === "hook_invocation_cancelled") throw error;
          if (hook.metadata.mode === "gate") {
            denied = {
              code: error.code,
              decision: "deny",
              invocationId,
              message: error.message,
            };
          } else if (hook.metadata.failure_policy === "fail_closed") {
            throw new HookError("hook_observer_degraded", error.message, 8, { cause: error });
          }
          continue;
        }
        const requiresOriginalRevalidation = hook.metadata.mode === "gate" &&
          (event === "tool.before_effect" || event === "completion.before_commit");
        if (
          (requiresOriginalRevalidation && input.revalidateOriginalAction === undefined) ||
          (input.revalidateOriginalAction !== undefined && !(await input.revalidateOriginalAction()))
        ) {
          await this.options.events.append("hook.invocation.failed", {
            code: "hook_original_action_stale",
            effect_state: "none",
            failure_policy: hook.metadata.failure_policy,
            invocation_id: invocationId,
          });
          if (hook.metadata.mode === "gate") {
            denied = {
              code: "hook_original_action_stale",
              decision: "deny",
              invocationId,
              message: "original action changed while its command Hook was running",
            };
            continue;
          }
          throw new HookError(
            "hook_original_action_stale",
            "original action changed while its command Hook was running",
          );
        }
        const terminalEventId = this.options.randomUUID();
        const outputBytes = Buffer.from(canonicalJson({
          action_sha256: result.actionSha256,
          kind: result.kind,
          stderr: result.stderr,
          stdout: result.stdout,
        }), "utf8");
        const outputArtifact = await this.options.artifacts.materializeText({
          bytes: outputBytes,
          mediaType: "text/plain; charset=utf-8",
          originEventId: requestedEventId,
        });
        if (result.kind === "gate") {
          const commandDecision: HookPipelineDecision = Object.freeze({
            ...(result.code === undefined ? {} : { code: result.code }),
            decision: result.decision,
            evidence: Object.freeze([...new Set([...result.evidence, outputArtifact.artifactId])]),
            invocationId,
            ...(result.message === undefined ? {} : { message: result.message }),
          });
          evidence.push(...(commandDecision.evidence ?? []));
          await this.options.events.append("hook.invocation.decided", {
            ...(commandDecision.code === undefined ? {} : { code: commandDecision.code }),
            decision: commandDecision.decision,
            evidence: [...(commandDecision.evidence ?? [])],
            invocation_id: invocationId,
            ...(commandDecision.message === undefined ? {} : { message: commandDecision.message }),
          }, terminalEventId);
          if (commandDecision.decision === "deny") denied = commandDecision;
        } else {
          await this.options.events.append("hook.invocation.completed", {
            artifact_ids: [outputArtifact.artifactId],
            invocation_id: invocationId,
            ...(result.message === undefined ? {} : { message: result.message }),
            status: "observed",
          }, terminalEventId);
        }
        continue;
      }
      const decision = declarativeDecision(hook, input.action, this.options.facts());
      evidence.push(...(decision.evidence ?? []));
      await this.options.events.append("hook.invocation.decided", {
        ...(decision.code === undefined ? {} : { code: decision.code }),
        decision: decision.decision,
        evidence: [...(decision.evidence ?? [])],
        invocation_id: invocationId,
        ...(decision.message === undefined ? {} : { message: decision.message }),
      });
      if (decision.decision === "deny") denied = { ...decision, invocationId };
    }
    return denied ?? Object.freeze({
      decision: "no_objection",
      evidence: Object.freeze([...new Set(evidence)]),
    });
  }
}
