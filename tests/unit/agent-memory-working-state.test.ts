import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import { AgentContextRuntime } from "../../src/context/agent-context-runtime.js";
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../src/context/token-estimator.js";
import { generateAgentMemoryCorpusCase } from "../../src/memory/benchmark/agent-memory-corpus.js";
import { parseAgentMemoryEvidenceManifest } from "../../src/memory/benchmark/agent-memory-evidence.js";
import type { ProjectableContextEvent } from "../../src/context/context-projector.js";

const manifestPath = resolve("tests/evidence/agent-memory-v1.json");
const fastRepresentativeCaseIds = new Set([
  "A02",
  "E03",
  "N03",
  "P01",
  "R02",
  "T03",
  "U02",
]);

type Manifest = ReturnType<typeof parseAgentMemoryEvidenceManifest>;

function runtime(
  manifest: Manifest,
  mode?: "shadow" | "working",
  observations: Array<Readonly<{
    readonly mode: "cold" | "incremental";
    readonly sourceEventCount: number;
    readonly sourceEventsApplied: number;
  }>> = [],
): AgentContextRuntime {
  const estimator = new DeterministicTokenEstimator({
    bytesPerToken: manifest.budget.bytesPerToken,
    itemOverheadTokens: manifest.budget.itemOverheadTokens,
    model: "agent-memory-am1-synthetic",
    provider: "offline-fixture",
    tokenizer: "utf8-deterministic-upper-bound",
    version: "agent-memory-am1-v1",
  });
  return new AgentContextRuntime({
    budget: resolveContextBudget(
      {
        contextWindowTokens: manifest.budget.contextWindowTokens,
        maximumOutputTokens: manifest.budget.reservedOutputTokens,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: manifest.budget.compactionThreshold,
        fixedSafetyMarginTokens: manifest.budget.fixedSafetyMarginTokens,
        reservedOutputTokens: manifest.budget.reservedOutputTokens,
      },
    ),
    estimator,
    systemInstructions:
      "AM1 synthetic equivalence. Do not call providers, tools, credentials, or networks.",
    ...(mode === undefined
      ? {}
      : {
          workingState: {
            mode,
            observation: {
              onProjection: (input) => {
                observations.push(input);
              },
            },
          },
        }),
  });
}

function event(
  sequence: number,
  type: string,
  data: unknown,
): ProjectableContextEvent {
  return Object.freeze({
    data,
    eventId: `am1-event-${String(sequence).padStart(4, "0")}`,
    runId: "am1-run",
    runSeq: sequence,
    sessionSeq: sequence,
    type,
  });
}

describe("AM1 bounded working-state projection", () => {
  it("keeps every AM0 event semantic byte-equivalent across representative prefix append", async () => {
    const manifest = parseAgentMemoryEvidenceManifest(
      await readFile(manifestPath, "utf8"),
    );
    for (const definition of manifest.cases.filter(
      ({ caseId }) => fastRepresentativeCaseIds.has(caseId),
    )) {
      const generated = generateAgentMemoryCorpusCase(definition);
      const split = Math.max(1, Math.floor(generated.events.length / 2));
      const observations: Array<Readonly<{
        readonly mode: "cold" | "incremental";
        readonly sourceEventCount: number;
        readonly sourceEventsApplied: number;
      }>> = [];
      const incremental = runtime(manifest, "working", observations);
      const cold = runtime(manifest);
      const prefixes = [
        generated.events.slice(0, split),
        generated.events,
        generated.events,
      ] as const;
      for (const prefix of prefixes) {
        const input = {
          artifactRefsByEventId: generated.artifactRefsByEventId,
          epoch: 0,
          events: prefix,
        } as const;
        const expected = cold.project(input);
        const actual = incremental.project(input);
        expect(canonicalJson(actual), definition.caseId).toBe(
          canonicalJson(expected),
        );
        let expectedPlan: ReturnType<AgentContextRuntime["planProjected"]> | Error;
        let actualPlan: ReturnType<AgentContextRuntime["planProjected"]> | Error;
        try {
          expectedPlan = cold.planProjected(expected);
        } catch (error) {
          expectedPlan = error as Error;
        }
        try {
          actualPlan = incremental.planProjected(actual);
        } catch (error) {
          actualPlan = error as Error;
        }
        if (expectedPlan instanceof Error || actualPlan instanceof Error) {
          expect(actualPlan).toMatchObject({
            code: (expectedPlan as Error & { readonly code?: string }).code,
          });
        } else {
          expect(canonicalJson(actualPlan.plan), definition.caseId).toBe(
            canonicalJson(expectedPlan.plan),
          );
          expect(Buffer.from(actualPlan.materialized.bytes)).toEqual(
            Buffer.from(expectedPlan.materialized.bytes),
          );
        }
      }
      expect(observations.map(({ mode }) => mode), definition.caseId).toEqual([
        "cold",
        "incremental",
        "incremental",
      ]);
      expect(observations.at(-1)?.sourceEventsApplied, definition.caseId).toBe(0);
      expect(observations[1]?.sourceEventsApplied, definition.caseId).toBe(
        generated.events.length - split,
      );
    }
  }, 60_000);

  it("reprojects an existing tool pair when an appended artifact binds its prefix", async () => {
    const manifest = parseAgentMemoryEvidenceManifest(
      await readFile(manifestPath, "utf8"),
    );
    const observations: Array<Readonly<{
      readonly mode: "cold" | "incremental";
      readonly sourceEventCount: number;
      readonly sourceEventsApplied: number;
    }>> = [];
    const incremental = runtime(manifest, "working", observations);
    const cold = runtime(manifest);
    const request = event(2, "tool.call.requested", {
      arguments_json: "{}",
      call_id: "call-am1-artifact",
      tool_name: "read_file",
    });
    const prefix = Object.freeze([
      event(1, "run.started", {
        command: "agent",
        input: { role: "user", text: "Inspect a file." },
      }),
      request,
      event(3, "tool.call.completed", {
        call_id: "call-am1-artifact",
        output: "bounded output",
        status: "success",
        tool_name: "read_file",
        truncated: true,
      }),
    ]);
    incremental.project({ epoch: 0, events: prefix });
    const artifactSha256 = sha256Canonical({ fixture: "am1-artifact" });
    const appended = Object.freeze([
      ...prefix,
      event(4, "artifact.stored", {
        artifact_id: `sha256:${artifactSha256}`,
        bytes: 128,
        media_type: "text/plain; charset=utf-8",
        object_ref: `.bornagent/artifacts/${artifactSha256}`,
        origin_event_id: request.eventId,
        sha256: artifactSha256,
      }),
    ]);

    const expected = cold.project({ epoch: 0, events: appended });
    const actual = incremental.project({ epoch: 0, events: appended });

    expect(canonicalJson(actual)).toBe(canonicalJson(expected));
    expect(observations.at(-1)).toMatchObject({
      mode: "incremental",
      sourceEventCount: 4,
      sourceEventsApplied: 1,
    });
  });

  it("falls back to the cold oracle when the prefix or projection configuration changes", async () => {
    const manifest = parseAgentMemoryEvidenceManifest(
      await readFile(manifestPath, "utf8"),
    );
    const observations: Array<Readonly<{
      readonly mode: "cold" | "incremental";
      readonly sourceEventCount: number;
      readonly sourceEventsApplied: number;
    }>> = [];
    const selected = runtime(manifest, "working", observations);
    const events = Object.freeze([
      event(1, "run.started", {
        command: "agent",
        input: { role: "user", text: "Original prefix." },
      }),
      event(2, "text.delta", { delta: "answer", visibility: "user_visible" }),
    ]);
    selected.project({ epoch: 0, events });
    selected.project({
      additionalItems: [],
      epoch: 0,
      events: Object.freeze([
        event(1, "run.started", {
          command: "agent",
          input: { role: "user", text: "Rewritten prefix." },
        }),
        events[1]!,
      ]),
    });

    expect(observations.map(({ mode }) => mode)).toEqual(["cold", "cold"]);
  });
});
