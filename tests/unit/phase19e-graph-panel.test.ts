import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalTaskGraphIdentity } from "../../src/task-graph/task-graph-identity.js";
import type { TaskGraphRevisionProjectionV1 } from "../../src/task-graph/task-graph-projector.js";
import type {
  TaskBudgetCountersV1,
  TaskExecutionProjectionV1,
} from "../../src/scheduling/task-execution-projector.js";
import { renderGraphPanel } from "../../src/tui/components/graph-panel.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";

const EVENT_ID = "19000000-0000-4000-8000-000000000099";

function counters(overrides: Partial<TaskBudgetCountersV1> = {}): TaskBudgetCountersV1 {
  return {
    artifactBytes: 0,
    attempts: 0,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: 0,
    commandOutputBytes: 0,
    durationMs: 0,
    modelSteps: 0,
    reportedTokens: 0,
    ...overrides,
  };
}

describe("Phase 19E Graph panel", () => {
  it("renders replayed Graph status, budget, node order, and blocker evidence", async () => {
    const source = JSON.parse(
      await readFile(
        resolve("fixtures/task-orchestration/m10-durable-graph/graph.json"),
        "utf8",
      ),
    ) as unknown;
    const identity = canonicalTaskGraphIdentity(source);
    const revision: TaskGraphRevisionProjectionV1 = {
      approvedEventId: EVENT_ID,
      artifact: {
        artifactId: `sha256:${identity.graphSha256}`,
        bytes: identity.byteLength,
        objectRef: `task-graph/${identity.graphSha256}.json`,
        sha256: identity.graphSha256,
      },
      binding: identity.content.binding,
      content: identity.content,
      createdEventId: EVENT_ID,
      decisionEventId: EVENT_ID,
      graphId: identity.content.graphId,
      graphSha256: identity.graphSha256,
      revision: 1,
      status: "waiting_for_user",
      terminalEventId: null,
    };
    const graphBudget = identity.content.graphBudget;
    const execution: TaskExecutionProjectionV1 = {
      activeAttempt: null,
      blocker: {
        code: "task_waiting_for_user",
        eventId: EVENT_ID,
        nodeId: "ui-change",
      },
      budget: {
        consumed: counters({
          artifactBytes: 512,
          attempts: 2,
          commandExecutions: 1,
          reportedTokens: 1024,
        }),
        limits: counters({
          artifactBytes: graphBudget.maxArtifactBytes,
          attempts: graphBudget.maxAttempts,
          changedBytes: graphBudget.maxChangedBytes,
          changedFiles: graphBudget.maxChangedFiles,
          commandExecutions: graphBudget.maxCommandExecutions,
          commandOutputBytes: graphBudget.maxCommandOutputBytes,
          durationMs: graphBudget.maxDurationMs,
          modelSteps: graphBudget.maxModelSteps,
          reportedTokens: graphBudget.maxReportedTokens,
        }),
        remaining: counters(),
        reserved: counters(),
        usageCompleteness: "partial",
      },
      enqueue: {
        enqueueId: EVENT_ID,
        eventId: EVENT_ID,
        requestedExecution: "foreground",
        runtimeProfileId: "local-free-v1",
      },
      graph: revision,
      lastSessionSeq: 12,
      nodes: identity.content.nodes.map((node, index) => ({
        attempts: [],
        nextAttemptOrigin: index === 0 ? null : "initial",
        node,
        nodeId: node.nodeId,
        status: index === 0 ? "succeeded" : "ready",
        terminalEventId: index === 0 ? EVENT_ID : null,
      })),
      readyNodeIds: ["core-change"],
      schedulerLeaseNonceSha256: null,
      status: "waiting_for_user",
    };
    const initial = createInitialTuiViewState();
    const lines = renderGraphPanel({
      ...initial,
      taskExecution: execution,
      taskGraph: {
        currentApproved: revision,
        currentDraft: null,
        currentExecution: revision,
        lastSessionSeq: 12,
        revisions: [revision],
        trackingMode: "phase19",
      },
    });

    expect(lines[0]).toBe(
      "GRAPH | 19000000-0000-4000-8000-000000000004@1 | waiting_for_user | sha=982127498238",
    );
    expect(lines).toContain(
      "GRAPH BUDGET | attempts=2/4 | commands=1/3 | artifacts=512/1310720 | usage=partial",
    );
    expect(lines).toContain(
      "GRAPH NODE | 1:inspect | succeeded | attempts=0 | next=none",
    );
    expect(lines).toContain(
      "GRAPH NODE | 2:core-change | ready | attempts=0 | next=initial",
    );
    expect(lines).toContain("GRAPH BLOCKER | task_waiting_for_user");
  });

  it("stays absent for legacy sessions", () => {
    expect(renderGraphPanel(createInitialTuiViewState())).toEqual([]);
  });
});
