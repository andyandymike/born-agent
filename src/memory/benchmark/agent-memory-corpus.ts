import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { ContextArtifactReference } from "../../context/context-item.js";
import type { ProjectableContextEvent } from "../../context/context-projector.js";

export const agentMemoryCorpusScenarios = Object.freeze([
  "artifact_tool_history",
  "closed_narrative_history",
  "pending_tool_history",
  "protected_error_history",
  "repository_churn",
  "tool_history",
  "unknown_opaque_history",
] as const);

export type AgentMemoryCorpusScenario =
  (typeof agentMemoryCorpusScenarios)[number];

export const agentMemoryExpectedOutcomes = Object.freeze([
  "context_protected_overflow",
  "context_unsafe_compaction",
  "planned",
] as const);

export type AgentMemoryExpectedOutcome =
  (typeof agentMemoryExpectedOutcomes)[number];

export interface AgentMemoryCorpusCaseV1 {
  readonly caseId: string;
  readonly expectedEventCount: number;
  readonly expectedOutcome: AgentMemoryExpectedOutcome;
  readonly groups: number;
  readonly payloadBytes: number;
  readonly scenario: AgentMemoryCorpusScenario;
}

export interface GeneratedAgentMemoryCorpusCaseV1 {
  readonly artifactRefsByEventId: Readonly<
    Record<string, readonly ContextArtifactReference[]>
  >;
  readonly caseDefinitionSha256: string;
  readonly eventBytes: number;
  readonly events: readonly ProjectableContextEvent[];
}

function eventId(caseId: string, sequence: number): string {
  return `am0-${caseId}-${String(sequence).padStart(6, "0")}`;
}

function event(
  definition: AgentMemoryCorpusCaseV1,
  sessionSeq: number,
  type: string,
  data: unknown,
): ProjectableContextEvent {
  return Object.freeze({
    data,
    eventId: eventId(definition.caseId, sessionSeq),
    runId: `am0-run-${definition.caseId}`,
    runSeq: sessionSeq,
    sessionSeq,
    type,
  });
}

function payload(caseId: string, group: number, bytes: number): string {
  const prefix = `${caseId}:${String(group)}:`;
  if (prefix.length >= bytes) return prefix.slice(0, bytes);
  return `${prefix}${"x".repeat(bytes - prefix.length)}`;
}

function runStarted(
  definition: AgentMemoryCorpusCaseV1,
): ProjectableContextEvent {
  return event(definition, 1, "run.started", {
    command: "agent",
    input: {
      role: "user",
      text: `Characterize synthetic memory case ${definition.caseId}.`,
    },
  });
}

function addNarrative(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    events.push(event(definition, events.length + 1, "text.delta", {
      delta: payload(definition.caseId, group, definition.payloadBytes),
      visibility: "user_visible",
    }));
  }
}

function addToolHistory(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
  artifacts: Record<string, readonly ContextArtifactReference[]>,
  withArtifacts: boolean,
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    const callId = `call-${definition.caseId}-${String(group)}`;
    events.push(event(definition, events.length + 1, "tool.call.requested", {
      arguments_json: canonicalJson({ case_id: definition.caseId, group }),
      call_id: callId,
      tool_name: "memory_fixture_lookup",
    }));
    const completed = event(
      definition,
      events.length + 1,
      "tool.call.completed",
      {
        call_id: callId,
        output: payload(definition.caseId, group, definition.payloadBytes),
        status: "success",
        tool_name: "memory_fixture_lookup",
        truncated: withArtifacts,
      },
    );
    events.push(completed);
    if (withArtifacts) {
      const sha256 = sha256Canonical({
        caseId: definition.caseId,
        group,
        payloadBytes: definition.payloadBytes,
      });
      artifacts[completed.eventId] = Object.freeze([
        Object.freeze({
          artifactId: `sha256:${sha256}`,
          bytes: definition.payloadBytes,
          mediaType: "text/plain; charset=utf-8",
          relativeRef: `.bornagent/artifacts/am0/${sha256}`,
          sha256,
        }),
      ]);
    }
  }
}

function addPendingTools(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    events.push(event(definition, events.length + 1, "tool.call.requested", {
      arguments_json: canonicalJson({
        body: payload(definition.caseId, group, definition.payloadBytes),
        group,
      }),
      call_id: `pending-${definition.caseId}-${String(group)}`,
      tool_name: "memory_fixture_pending",
    }));
  }
}

function addProtectedErrors(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    const callId = `error-${definition.caseId}-${String(group)}`;
    events.push(event(definition, events.length + 1, "tool.call.requested", {
      arguments_json: canonicalJson({ group }),
      call_id: callId,
      tool_name: "memory_fixture_error",
    }));
    events.push(event(definition, events.length + 1, "tool.call.completed", {
      call_id: callId,
      error_code: payload(
        definition.caseId,
        group,
        definition.payloadBytes,
      ),
      output: "synthetic failure",
      status: "error",
      tool_name: "memory_fixture_error",
      truncated: false,
    }));
  }
}

function addRepositoryChurn(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    events.push(
      event(
        definition,
        events.length + 1,
        "repository.source.snapshot.captured",
        {
          branch: `fixture-${String(group % 3)}`,
          checkout_sha256: sha256Canonical({ caseId: definition.caseId, group }),
          dirty: group % 2 === 1,
          workspace: "synthetic/repository",
        },
      ),
    );
  }
}

function addUnknownOpaque(
  definition: AgentMemoryCorpusCaseV1,
  events: ProjectableContextEvent[],
): void {
  for (let group = 0; group < definition.groups; group += 1) {
    events.push(event(definition, events.length + 1, "future.memory.opaque", {
      opaque: payload(definition.caseId, group, definition.payloadBytes),
    }));
  }
}

export function expectedAgentMemoryEventCount(
  definition: Pick<AgentMemoryCorpusCaseV1, "groups" | "scenario">,
): number {
  switch (definition.scenario) {
    case "artifact_tool_history":
    case "protected_error_history":
    case "tool_history":
      return 1 + definition.groups * 2;
    default:
      return 1 + definition.groups;
  }
}

export function generateAgentMemoryCorpusCase(
  definition: AgentMemoryCorpusCaseV1,
): GeneratedAgentMemoryCorpusCaseV1 {
  if (
    definition.expectedEventCount !== expectedAgentMemoryEventCount(definition)
  ) {
    throw new TypeError(
      `agent memory case ${definition.caseId} has the wrong expected event count`,
    );
  }
  const events: ProjectableContextEvent[] = [runStarted(definition)];
  const artifacts: Record<string, readonly ContextArtifactReference[]> = {};
  switch (definition.scenario) {
    case "artifact_tool_history":
      addToolHistory(definition, events, artifacts, true);
      break;
    case "closed_narrative_history":
      addNarrative(definition, events);
      break;
    case "pending_tool_history":
      addPendingTools(definition, events);
      break;
    case "protected_error_history":
      addProtectedErrors(definition, events);
      break;
    case "repository_churn":
      addRepositoryChurn(definition, events);
      break;
    case "tool_history":
      addToolHistory(definition, events, artifacts, false);
      break;
    case "unknown_opaque_history":
      addUnknownOpaque(definition, events);
      break;
  }
  const eventBytes = events.reduce(
    (total, value) => total + Buffer.byteLength(canonicalJson(value), "utf8"),
    0,
  );
  return Object.freeze({
    artifactRefsByEventId: Object.freeze(artifacts),
    caseDefinitionSha256: sha256Canonical(definition),
    eventBytes,
    events: Object.freeze(events),
  });
}
