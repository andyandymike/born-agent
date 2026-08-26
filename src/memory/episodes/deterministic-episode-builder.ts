import { createHash } from "node:crypto";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { inspectMl1MemoryAdmission, type Ml1MemoryAdmissionResult } from "./memory-admission.js";
import { createMl1EpisodeRecordV1, type Ml1EpisodeRecordV1, type Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";

export type Ml1EpisodeBuildResult =
  | Readonly<{ admission: Extract<Ml1MemoryAdmissionResult, { admitted: false }>; status: "not_admitted" }>
  | Readonly<{ record: Ml1EpisodeRecordV1; status: "admitted" }>;

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeTaskPreview(input: string): string {
  const normalized = input.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (Buffer.byteLength(normalized, "utf8") <= 2_048) return normalized;
  const ellipsis = "…";
  let preview = "";
  for (const scalar of normalized) {
    if (Buffer.byteLength(`${preview}${scalar}${ellipsis}`, "utf8") > 2_048) break;
    preview += scalar;
  }
  return `${preview}${ellipsis}`;
}

function exactRawHash(evidence: ExactSessionEvidenceV1, event: DecodedStoredEvent): string {
  const value = evidence.rawSha256.get(event.eventId);
  if (value === undefined) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "episode source lacks an exact raw hash");
  }
  return value;
}

export function calculateMl1RangeSha256(
  evidence: ExactSessionEvidenceV1,
  events: readonly DecodedStoredEvent[],
  runId: string,
): string {
  return sha256Canonical({
    records: events.map((event) => ({
      event_id: event.eventId,
      raw_sha256: exactRawHash(evidence, event),
      sequence: event.sessionSeq,
    })),
    run_id: runId,
    schema_version: 1,
    session_id: evidence.sessionId,
  });
}

export function buildDeterministicMl1Episode(input: Readonly<{
  readonly evidence: ExactSessionEvidenceV1;
  readonly repositoryId: string;
  readonly runId: string;
  readonly scope: Ml1MemoryScopeV1;
}>): Ml1EpisodeBuildResult {
  // MEMORY-ML1: 只从 exact、完整、成功终态重算 episode；任何缺口都拒绝，绝不让模型猜摘要。
  if (input.repositoryId !== input.scope.applicationRepositoryId) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "session catalog and memory scope disagree");
  }
  let reconstructed: ReturnType<typeof reconstructMultiRunSession>;
  try {
    reconstructed = reconstructMultiRunSession(input.evidence.events);
  } catch (error) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "session evidence does not reconstruct strictly", { cause: error });
  }
  const runEvents = input.evidence.events.filter(
    (event) => event.scope === "run" && event.runId === input.runId,
  );
  const start = runEvents.find((event) => event.type === "run.started");
  const end = runEvents.find((event) => event.type === "run.completed");
  if (
    start?.type !== "run.started" ||
    end?.type !== "run.completed" ||
    runEvents.filter((event) => event.type === "run.started").length !== 1 ||
    runEvents.filter((event) => event.type === "run.completed").length !== 1 ||
    input.evidence.events.at(-1)?.eventId !== end.eventId ||
    reconstructed.lastRun?.runId !== input.runId ||
    reconstructed.status !== "completed" ||
    start.data.command !== "agent"
  ) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "only an exact terminal completed Agent run is admitted");
  }
  const applicationCommit = start.data.application_commit;
  if (
    applicationCommit === undefined ||
    applicationCommit.principal_id !== input.scope.ownerPrincipalId ||
    applicationCommit.operation_id !== input.runId
  ) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "run application authority does not match memory scope");
  }
  const range = input.evidence.events.slice(start.sessionSeq - 1, end.sessionSeq);
  if (
    range[0]?.eventId !== start.eventId ||
    range.at(-1)?.eventId !== end.eventId ||
    range.some((event, index) => event.sessionSeq !== start.sessionSeq + index) ||
    runEvents.some((event) => event.sessionSeq < start.sessionSeq || event.sessionSeq > end.sessionSeq)
  ) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "run source range is not exact and contiguous");
  }
  const task = start.data.input.text;
  const taskPreview = normalizeTaskPreview(task);
  if (
    end.data.completion_mode === undefined ||
    end.data.steps === undefined ||
    end.data.tool_calls === undefined
  ) {
    throw new Ml1MemoryError("memory_episode_not_admitted", "completed run lacks current Agent terminal counters");
  }
  const completion = {
    evidenceSha256: end.data.evidence_sha256 ?? null,
    mode: end.data.completion_mode,
    reportSha256: end.data.report_sha256 ?? null,
    steps: end.data.steps,
    toolCalls: end.data.tool_calls,
  } as const;
  const source = {
    endEventId: end.eventId,
    endRawSha256: exactRawHash(input.evidence, end),
    endSequence: end.sessionSeq,
    kind: "session_run_range" as const,
    rangeSha256: calculateMl1RangeSha256(input.evidence, range, input.runId),
    runId: input.runId,
    sessionId: input.evidence.sessionId,
    startEventId: start.eventId,
    startRawSha256: exactRawHash(input.evidence, start),
    startSequence: start.sessionSeq,
  };
  const recordId = `episode_${sha256Canonical({ schema_version: 1, scope: input.scope, source })}`;
  const text = [
    `Task: ${taskPreview}`,
    "Outcome: completed",
    `Completion mode: ${completion.mode}`,
    `Steps: ${String(completion.steps)}`,
    `Tool calls: ${String(completion.toolCalls)}`,
    `Evidence: ${completion.evidenceSha256 ?? "none"}`,
  ].join("\n");
  const content = {
    completion,
    kind: "episode" as const,
    occurredAt: end.timestamp,
    origin: "deterministic_episode" as const,
    recordId,
    schemaVersion: 1 as const,
    scope: input.scope,
    source,
    taskInputSha256: hashText(task),
    taskPreview,
    text,
  };
  const admission = inspectMl1MemoryAdmission([task, canonicalJson(content)]);
  if (!admission.admitted) {
    return Object.freeze({ admission, status: "not_admitted" });
  }
  return Object.freeze({ record: createMl1EpisodeRecordV1(content), status: "admitted" });
}
