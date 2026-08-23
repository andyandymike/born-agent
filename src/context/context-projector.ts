import { canonicalJson } from "../completion/canonical-json.js";
import {
  createContextItem,
  type ContextArtifactReference,
  type ContextItem,
  type ContextItemInput,
  type ContextJson,
  type ContextPairing,
} from "./context-item.js";
import type { TokenEstimator } from "./token-estimator.js";

export interface ProjectableContextEvent {
  readonly data: unknown;
  readonly eventId: string;
  readonly runId?: string;
  readonly runSeq?: number;
  readonly sessionSeq: number;
  readonly type: string;
}

export interface FrozenRepositoryRulesInput {
  readonly artifactRef: ContextArtifactReference;
  readonly content: string;
  readonly eventId: string;
  readonly priorityExplanation: string;
  readonly sha256: string;
}

export interface SystemInstructionInput {
  readonly id: string;
  readonly text: string;
  readonly version: string;
}

export interface ContextProjectionInput {
  readonly additionalItems?: readonly ContextItem[];
  readonly artifactRefsByEventId?: Readonly<
    Record<string, readonly ContextArtifactReference[]>
  >;
  readonly epoch: number;
  readonly events: readonly ProjectableContextEvent[];
  readonly repositoryRules?: FrozenRepositoryRulesInput | null;
  readonly systemInstructions: readonly SystemInstructionInput[];
}

export interface ProjectedContextState {
  readonly activeEffectIds: readonly string[];
  readonly epoch: number;
  readonly estimatorId: string;
  readonly items: readonly ContextItem[];
  readonly safePoint: boolean;
  readonly sourceEventIds: readonly string[];
}

export class ContextProjectionError extends Error {
  public constructor(
    public readonly code:
      | "duplicate_event_id"
      | "duplicate_event_sequence"
      | "estimator_mismatch"
      | "incremental_projection_mismatch"
      | "invalid_epoch"
      | "invalid_event_data",
    message: string,
  ) {
    super(message);
    this.name = "ContextProjectionError";
  }
}

function record(value: unknown, event: ProjectableContextEvent): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextProjectionError(
      "invalid_event_data",
      `${event.type} data must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  data: Record<string, unknown>,
  key: string,
  event: ProjectableContextEvent,
): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ContextProjectionError(
      "invalid_event_data",
      `${event.type}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function jsonValue(value: unknown, event: ProjectableContextEvent): ContextJson {
  try {
    return JSON.parse(canonicalJson(value)) as ContextJson;
  } catch (error) {
    throw new ContextProjectionError(
      "invalid_event_data",
      `${event.type} data is not canonical JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function eventPairId(
  prefix: string,
  identity: string,
  event: ProjectableContextEvent,
): string {
  return `${prefix}:${event.runId ?? "session"}:${identity}`;
}

function pairing(
  id: string,
  kind: ContextPairing["kind"],
  role: string,
): ContextPairing {
  return { id, kind, role };
}

function layer(item: ContextItem): number {
  switch (item.kind) {
    case "system_instruction":
      return 0;
    case "user_message":
      return 1;
    case "repository_rules":
      return 2;
    case "skill_arguments":
    case "skill_entry":
      return 3;
    case "mcp_prompt":
      return 4;
    case "skill_resource":
    case "mcp_resource":
      return 5;
    case "approval_history":
    case "mutation_fact":
    case "state_fact":
      return 6;
    default:
      return 7;
  }
}

function canonicalItemOrder(left: ContextItem, right: ContextItem): number {
  return (
    layer(left) - layer(right) ||
    left.recency - right.recency ||
    left.id.localeCompare(right.id)
  );
}

function uniqueArtifacts(
  artifacts: readonly ContextArtifactReference[],
): readonly ContextArtifactReference[] {
  return Object.freeze(
    [...new Map(artifacts.map((artifact) => [artifact.artifactId, artifact])).values()]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  );
}

export class ContextProjector {
  public constructor(private readonly estimator: TokenEstimator) {}

  public project(input: ContextProjectionInput): ProjectedContextState {
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
      throw new ContextProjectionError(
        "invalid_epoch",
        "context epoch must be a nonnegative safe integer",
      );
    }
    const events = [...input.events].sort(
      (left, right) =>
        left.sessionSeq - right.sessionSeq ||
        left.eventId.localeCompare(right.eventId),
    );
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    for (const event of events) {
      if (eventIds.has(event.eventId)) {
        throw new ContextProjectionError(
          "duplicate_event_id",
          `duplicate event id ${event.eventId}`,
        );
      }
      if (sequences.has(event.sessionSeq)) {
        throw new ContextProjectionError(
          "duplicate_event_sequence",
          `duplicate event sequence ${event.sessionSeq}`,
        );
      }
      eventIds.add(event.eventId);
      sequences.add(event.sessionSeq);
    }

    const artifactsByOrigin = new Map<
      string,
      ContextArtifactReference[]
    >();
    for (const [eventId, references] of Object.entries(
      input.artifactRefsByEventId ?? {},
    )) {
      artifactsByOrigin.set(eventId, [...references]);
    }
    for (const event of events) {
      if (event.type !== "artifact.stored") continue;
      const data = record(event.data, event);
      const originEventId = requiredString(data, "origin_event_id", event);
      const artifactId = requiredString(data, "artifact_id", event);
      const sha256 = requiredString(data, "sha256", event);
      const bytes = data.bytes;
      if (
        !Number.isSafeInteger(bytes) ||
        (bytes as number) < 0 ||
        artifactId !== `sha256:${sha256}`
      ) {
        throw new ContextProjectionError(
          "invalid_event_data",
          "artifact.stored identity is invalid",
        );
      }
      const references = artifactsByOrigin.get(originEventId) ?? [];
      references.push({
        artifactId,
        bytes: bytes as number,
        mediaType: requiredString(data, "media_type", event),
        relativeRef: requiredString(data, "object_ref", event),
        sha256,
      });
      artifactsByOrigin.set(originEventId, references);
    }

    const items: ContextItem[] = [];
    const activeEffects = new Set<string>();
    const toolArtifactsByPair = new Map<
      string,
      readonly ContextArtifactReference[]
    >();
    const add = (seed: ContextItemInput): void => {
      items.push(createContextItem(seed, this.estimator));
    };
    const latestRepositorySource = [...events].reverse().find((event) => event.type === "repository.source.snapshot.captured");
    const latestRepositoryIndex = [...events].reverse().find((event) => event.type === "repository.index.selected");

    for (const instruction of [...input.systemInstructions].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      add({
        authority: "authoritative",
        content: instruction.text,
        kind: "system_instruction",
        metadata: { instruction_id: instruction.id, version: instruction.version },
        priority: "critical",
        protectedCategory: "system_policy",
        recency: 0,
        role: "system",
        sourceEventIds: [`system:${instruction.id}:${instruction.version}`],
        visibility: "provider_context",
      });
    }
    if (input.repositoryRules !== undefined && input.repositoryRules !== null) {
      add({
        artifactRefs: [input.repositoryRules.artifactRef],
        // PHASE10: repository rules are frozen, delimited untrusted
        // instructions below current user policy; their hash never grants new
        // PermissionEngine authority.
        authority: "untrusted_content",
        content: input.repositoryRules.content,
        kind: "repository_rules",
        metadata: {
          priority_explanation: input.repositoryRules.priorityExplanation,
          sha256: input.repositoryRules.sha256,
        },
        priority: "critical",
        protectedCategory: "repository_rules",
        recency: 0,
        role: "system",
        sourceEventIds: [input.repositoryRules.eventId],
        visibility: "provider_context",
      });
    }

    for (const event of events) {
      const data = record(event.data, event);
      const artifacts = uniqueArtifacts(
        artifactsByOrigin.get(event.eventId) ?? [],
      );
      const base = {
        artifactRefs: artifacts,
        recency: event.sessionSeq,
        sourceEventIds: [event.eventId] as readonly string[],
      };
      switch (event.type) {
        case "run.started": {
          const eventInput = record(data.input, event);
          if (eventInput.role !== "user") break;
          add({
            ...base,
            authority: "authoritative",
            content: requiredString(eventInput, "text", event),
            kind: "user_message",
            metadata: { command: requiredString(data, "command", event) },
            priority: "critical",
            protectedCategory: "user_instruction",
            role: "user",
            turnId: event.runId ?? event.eventId,
            visibility: "provider_context",
          });
          break;
        }
        case "user.message":
          add({
            ...base,
            authority: "authoritative",
            content: requiredString(data, "text", event),
            kind: "user_message",
            priority: "critical",
            protectedCategory: "user_instruction",
            role: "user",
            turnId: requiredString(data, "turn_id", event),
            visibility: "provider_context",
          });
          break;
        case "session.resume.requested": {
          const sourceRunId = requiredString(data, "source_run_id", event);
          for (const effectId of [...activeEffects]) {
            if (effectId.startsWith(`model:${sourceRunId}:`)) {
              activeEffects.delete(effectId);
            }
          }
          if (typeof data.message === "string" && data.message.length > 0) {
            add({
              ...base,
              authority: "authoritative",
              content: data.message,
              kind: "user_message",
              metadata: {
                requested_mode: requiredString(data, "requested_mode", event),
                source_run_id: sourceRunId,
              },
              priority: "critical",
              protectedCategory: "user_instruction",
              role: "user",
              turnId: event.eventId,
              visibility: "provider_context",
            });
          }
          break;
        }
        case "approval.expired":
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson({ ...data, authority: "historical_only" }),
            kind: "approval_history",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "approval_history",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "side_effect.reconciled": {
          const sourceRunId = requiredString(data, "source_run_id", event);
          const effectId = requiredString(data, "effect_id", event);
          activeEffects.delete(`mutation:${sourceRunId}:${effectId}`);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory:
              data.observed === "applied"
                ? "change_journal"
                : "pending_effects",
            role: "system",
            visibility: "provider_context",
          });
          break;
        }
        case "resume.pending_call.adopted": {
          const sourceRunId = requiredString(data, "source_run_id", event);
          const sourceCallId = requiredString(data, "source_call_id", event);
          const callId = requiredString(data, "call_id", event);
          const sourcePairId = `tool:${sourceRunId}:${sourceCallId}`;
          const adoptedPairId = eventPairId("tool", callId, event);
          activeEffects.delete(sourcePairId);
          activeEffects.add(adoptedPairId);
          toolArtifactsByPair.set(adoptedPairId, artifacts);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson({
              adopted_call_id: callId,
              source_call_id: sourceCallId,
              source_run_id: sourceRunId,
              status: "adopted_by_new_run",
            }),
            kind: "tool_observation",
            metadata: jsonValue(data, event),
            pairing: pairing(sourcePairId, "tool", "observation"),
            priority: "critical",
            protectedCategory: "pending_effects",
            role: "tool",
            visibility: "provider_context",
          });
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "tool_call",
            metadata: jsonValue(data, event),
            pairing: pairing(adoptedPairId, "tool", "call"),
            priority: "critical",
            protectedCategory: "pending_effects",
            role: "assistant",
            visibility: "provider_context",
          });
          break;
        }
        case "backend.canonical_boundary.created":
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "backend_budget_epoch",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "backend.selected":
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "backend_budget_epoch",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "repository.source.snapshot.captured":
          if (event.eventId !== latestRepositorySource?.eventId) break;
          add({
            ...base,
            authority: "authoritative",
            content: `BORNAGENT_REPOSITORY_STATE_V1\n${canonicalJson({ kind: "source", ...data })}`,
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "repository_state",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "repository.index.selected":
          if (event.eventId !== latestRepositoryIndex?.eventId) break;
          add({
            ...base,
            authority: "authoritative",
            content: `BORNAGENT_REPOSITORY_STATE_V1\n${canonicalJson({ kind: "index", ...data })}`,
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "repository_state",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "repository.index.invalidated":
          if (latestRepositoryIndex !== undefined && latestRepositoryIndex.sessionSeq > event.sessionSeq) break;
          add({
            ...base,
            authority: "authoritative",
            content: `BORNAGENT_REPOSITORY_STATE_V1\n${canonicalJson({ kind: "invalidated", ...data })}`,
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory: "unresolved_errors",
            role: "system",
            visibility: "provider_context",
          });
          break;
        case "text.delta":
          add({
            ...base,
            authority: "narrative",
            content: requiredString(data, "delta", event),
            kind: "assistant_message",
            priority: "low",
            role: "assistant",
            turnId: event.runId ?? null,
            visibility:
              data.visibility === "internal_candidate"
                ? "internal_candidate"
                : "user_visible",
          });
          break;
        case "tool.call.requested": {
          const callId = requiredString(data, "call_id", event);
          const pairId = eventPairId("tool", callId, event);
          activeEffects.add(pairId);
          toolArtifactsByPair.set(pairId, artifacts);
          add({
            ...base,
            authority: "historical_only",
            content: requiredString(data, "arguments_json", event),
            kind: "tool_call",
            metadata: {
              call_id: callId,
              tool_name: requiredString(data, "tool_name", event),
            },
            pairing: pairing(pairId, "tool", "call"),
            priority: "high",
            role: "assistant",
            turnId: event.runId ?? null,
            visibility: "provider_context",
          });
          break;
        }
        case "tool.call.completed":
        case "tool.call.recovered": {
          const callId = requiredString(data, "call_id", event);
          const pairId = eventPairId("tool", callId, event);
          const status = requiredString(data, "status", event);
          activeEffects.delete(pairId);
          const observationArtifacts = uniqueArtifacts([
            ...artifacts,
            ...(toolArtifactsByPair.get(pairId) ?? []),
          ]);
          add({
            ...base,
            artifactRefs: observationArtifacts,
            authority: "historical_only",
            content: requiredString(data, "output", event),
            kind: "tool_observation",
            metadata: {
              call_id: callId,
              error_code:
                typeof data.error_code === "string" ? data.error_code : null,
              output_bytes: new TextEncoder().encode(
                requiredString(data, "output", event),
              ).byteLength,
              status,
              tool_name: requiredString(data, "tool_name", event),
              truncated: data.truncated === true,
            },
            pairing: pairing(pairId, "tool", "observation"),
            priority: status === "error" ? "critical" : "normal",
            protectedCategory: null,
            role: "tool",
            turnId: event.runId ?? null,
            visibility: "provider_context",
          });
          if (status === "error") {
            const errorFact = {
              call_id: callId,
              error_code:
                typeof data.error_code === "string" ? data.error_code : null,
              status,
              tool_name: requiredString(data, "tool_name", event),
            } as const;
            add({
              ...base,
              authority: "historical_only",
              content: canonicalJson(errorFact),
              kind: "state_fact",
              metadata: errorFact,
              priority: "critical",
              protectedCategory: "unresolved_errors",
              role: "system",
              visibility: "provider_context",
            });
          }
          break;
        }
        case "patch.plan.created": {
          const pairId = eventPairId(
            "mutation",
            requiredString(data, "plan_id", event),
            event,
          );
          activeEffects.add(pairId);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "mutation_fact",
            metadata: jsonValue(data, event),
            pairing: pairing(pairId, "mutation", "proposal"),
            priority: "high",
            role: "tool",
            visibility: "provider_context",
          });
          break;
        }
        case "approval.requested":
        case "approval.decided": {
          const approvalId = requiredString(data, "approval_request_id", event);
          const identity =
            typeof data.plan_id === "string"
              ? data.plan_id
              : requiredString(data, "call_id", event);
          const pairId = eventPairId("mutation", identity, event);
          if (event.type === "approval.requested") {
            activeEffects.add(pairId);
          } else if (data.decision !== "approved") {
            activeEffects.delete(pairId);
          }
          add({
            ...base,
            // PHASE10: an old approval remains auditable context but is
            // explicitly historical-only; replay cannot restore its authority.
            authority: "historical_only",
            content: canonicalJson({
              ...data,
              authority: "historical_only",
            }),
            kind: "approval_history",
            metadata: {
              approval_request_id: approvalId,
              authority: "historical_only",
              decision:
                typeof data.decision === "string" ? data.decision : null,
            },
            pairing: pairing(
              pairId,
              "mutation",
              event.type === "approval.requested"
                ? "approval_request"
                : "approval_decision",
            ),
            priority: "critical",
            protectedCategory: "approval_history",
            role: "system",
            visibility: "provider_context",
          });
          break;
        }
        case "patch.apply.started":
        case "patch.apply.completed": {
          const pairId = eventPairId(
            "mutation",
            requiredString(data, "plan_id", event),
            event,
          );
          if (event.type === "patch.apply.started") activeEffects.add(pairId);
          else activeEffects.delete(pairId);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "mutation_fact",
            metadata: jsonValue(data, event),
            pairing: pairing(
              pairId,
              "mutation",
              event.type === "patch.apply.started" ? "apply_start" : "change",
            ),
            priority: "critical",
            protectedCategory:
              event.type === "patch.apply.started"
                ? "pending_effects"
                : "change_journal",
            role: "tool",
            visibility: "provider_context",
          });
          break;
        }
        case "command.execution.requested":
        case "command.completed": {
          const executionId = requiredString(data, "execution_id", event);
          const pairId = eventPairId("command", executionId, event);
          if (event.type === "command.execution.requested") {
            activeEffects.add(pairId);
          } else {
            activeEffects.delete(pairId);
          }
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind:
              event.type === "command.execution.requested"
                ? "tool_call"
                : "tool_observation",
            metadata: jsonValue(data, event),
            pairing: pairing(
              pairId,
              "tool",
              event.type === "command.execution.requested"
                ? "call"
                : "observation",
            ),
            priority: "high",
            protectedCategory:
              event.type === "command.completed"
                ? data.termination === "exit" && data.exit_code === 0
                  ? "verification_state"
                  : "unresolved_errors"
                : null,
            role:
              event.type === "command.execution.requested"
                ? "assistant"
                : "tool",
            visibility: "provider_context",
          });
          break;
        }
        case "verification.started":
        case "verification.completed": {
          const verificationId = requiredString(data, "verification_id", event);
          const pairId = eventPairId("verification", verificationId, event);
          if (event.type === "verification.started") activeEffects.add(pairId);
          else activeEffects.delete(pairId);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "state_fact",
            metadata: jsonValue(data, event),
            pairing: pairing(
              pairId,
              "tool",
              event.type === "verification.started" ? "call" : "observation",
            ),
            priority: "critical",
            protectedCategory:
              event.type === "verification.completed"
                ? data.status === "failed"
                  ? "unresolved_errors"
                  : "verification_state"
                : "verification_state",
            role: "system",
            visibility: "provider_context",
          });
          break;
        }
        case "completion.candidate":
        case "completion.evaluated": {
          const candidate = requiredString(data, "candidate_sha256", event);
          const pairId = eventPairId("completion", candidate, event);
          if (event.type === "completion.candidate") activeEffects.add(pairId);
          else activeEffects.delete(pairId);
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind:
              event.type === "completion.candidate"
                ? "completion_candidate"
                : "completion_decision",
            metadata: jsonValue(data, event),
            pairing: pairing(
              pairId,
              "completion",
              event.type === "completion.candidate" ? "candidate" : "decision",
            ),
            priority: "high",
            protectedCategory:
              event.type === "completion.evaluated" && data.effect !== "accept"
                ? "unresolved_errors"
                : null,
            role: "system",
            visibility:
              event.type === "completion.candidate"
                ? "internal_candidate"
                : "provider_context",
          });
          break;
        }
        case "agent.step.started":
          activeEffects.add(
            eventPairId("model", String(data.step ?? event.runSeq ?? 0), event),
          );
          break;
        case "agent.step.completed":
          activeEffects.delete(
            eventPairId("model", String(data.step ?? event.runSeq ?? 0), event),
          );
          break;
        case "run.budget_exceeded":
        case "run.failed":
        case "run.incomplete":
          add({
            ...base,
            authority: "historical_only",
            content: canonicalJson(data),
            kind: "state_fact",
            metadata: jsonValue(data, event),
            priority: "critical",
            protectedCategory:
              event.type === "run.budget_exceeded"
                ? "backend_budget_epoch"
                : "unresolved_errors",
            role: "system",
            visibility: "provider_context",
          });
          break;
        default:
          // Opaque checkpoint bytes and unknown narrative are intentionally not
          // promoted into provider-neutral text by the context core.
          break;
      }
    }

    for (const item of input.additionalItems ?? []) {
      if (item.estimatorId !== this.estimator.estimatorId) {
        throw new ContextProjectionError(
          "estimator_mismatch",
          `context item ${item.id} used another estimator`,
        );
      }
      items.push(item);
    }
    items.sort(canonicalItemOrder);
    const seenItemIds = new Set<string>();
    for (const item of items) {
      if (seenItemIds.has(item.id)) {
        throw new ContextProjectionError(
          "duplicate_event_id",
          `duplicate projected context item ${item.id}`,
        );
      }
      seenItemIds.add(item.id);
    }
    const activeEffectIds = Object.freeze(
      [...activeEffects].sort((left, right) => left.localeCompare(right)),
    );
    return Object.freeze({
      activeEffectIds,
      epoch: input.epoch,
      estimatorId: this.estimator.estimatorId,
      items: Object.freeze(items),
      safePoint: activeEffectIds.length === 0,
      sourceEventIds: Object.freeze(events.map(({ eventId }) => eventId)),
    });
  }
}
