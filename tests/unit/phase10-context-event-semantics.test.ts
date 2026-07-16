import { describe, expect, it } from "vitest";

import { assertPhase10ContextEventSemantics } from "../../src/context/context-event-semantics.js";
import type { DecodedStoredEvent } from "../../src/events/event-decoder-registry.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000091";
const RUN_ONE = "20000000-0000-4000-8000-000000000091";
const RUN_TWO = "20000000-0000-4000-8000-000000000092";

function event(
  type: string,
  data: Readonly<Record<string, unknown>>,
  sessionSeq: number,
  runId: string,
): DecodedStoredEvent {
  return {
    data,
    eventId: `30000000-0000-4000-8000-${String(sessionSeq).padStart(12, "0")}`,
    runId,
    runSeq: sessionSeq,
    scope: "run",
    sessionId: SESSION_ID,
    sessionSeq,
    sourceSchemaVersion: 2,
    timestamp: "2026-07-17T00:00:00.000Z",
    type,
  } as unknown as DecodedStoredEvent;
}

function estimate(epoch: number, step = 1) {
  return {
    absolute_input_tokens: 1_000,
    compaction_target_tokens: 800,
    epoch,
    estimated_input_tokens: 900,
    step,
  };
}

function plan(epoch: number, compacted: boolean, step = 1) {
  return {
    canonical_context_sha256: "a".repeat(64),
    compacted,
    epoch,
    estimated_input_tokens: 700,
    step,
  };
}

describe("Phase 10 context event semantics", () => {
  it("carries a compacted epoch into the next resumed run", () => {
    const events = [
      event("run.started", {}, 1, RUN_ONE),
      event("context.estimate.created", estimate(0), 2, RUN_ONE),
      event(
        "context.compaction.started",
        {
          estimated_input_tokens: 900,
          from_epoch: 0,
          step: 1,
          target_input_tokens: 800,
          to_epoch: 1,
        },
        3,
        RUN_ONE,
      ),
      event("context.plan.created", plan(1, true), 4, RUN_ONE),
      event(
        "model.request.encoded",
        {
          canonical_context_sha256: "a".repeat(64),
          epoch: 1,
          step: 1,
        },
        5,
        RUN_ONE,
      ),
      event("agent.step.started", { step: 1 }, 6, RUN_ONE),
      event("run.started", {}, 7, RUN_TWO),
      event("context.estimate.created", estimate(1), 8, RUN_TWO),
      event("context.plan.created", plan(1, false), 9, RUN_TWO),
      event(
        "model.request.encoded",
        {
          canonical_context_sha256: "a".repeat(64),
          epoch: 1,
          step: 1,
        },
        10,
        RUN_TWO,
      ),
      event("agent.step.started", { step: 1 }, 11, RUN_TWO),
    ];

    expect(() => assertPhase10ContextEventSemantics(events)).not.toThrow();
    const stale = events.map((value, index) =>
      index === 7
        ? event("context.estimate.created", estimate(0), 8, RUN_TWO)
        : value,
    );
    expect(() => assertPhase10ContextEventSemantics(stale)).toThrow(
      "stale epoch",
    );
  });

  it("rejects every unencoded agent step once a run declares Phase 10", () => {
    expect(() =>
      assertPhase10ContextEventSemantics([
        event("run.started", {}, 1, RUN_ONE),
        event(
          "repository.rules.loaded",
          { relative_path: "AGENTS.md", state: "missing" },
          2,
          RUN_ONE,
        ),
        event("agent.step.started", { step: 1 }, 3, RUN_ONE),
      ]),
    ).toThrow("before model.request.encoded");

    expect(() =>
      assertPhase10ContextEventSemantics([
        event("run.started", {}, 1, RUN_ONE),
        event("context.estimate.created", estimate(0), 2, RUN_ONE),
        event("context.plan.created", plan(0, false), 3, RUN_ONE),
        event(
          "model.request.encoded",
          {
            canonical_context_sha256: "a".repeat(64),
            epoch: 0,
            step: 1,
          },
          4,
          RUN_ONE,
        ),
        event("agent.step.started", { step: 1 }, 5, RUN_ONE),
        event("agent.step.started", { step: 2 }, 6, RUN_ONE),
      ]),
    ).toThrow("before model.request.encoded");
  });
});
