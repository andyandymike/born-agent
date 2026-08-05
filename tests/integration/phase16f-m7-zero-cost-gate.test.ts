import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutcomeReport } from "../../src/coordination/outcome-report.js";
import { OutcomeReportBuilder } from "../../src/coordination/outcome-report.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import type {
  PiTuiRenderer,
  PiTuiRendererOptions,
} from "../../src/tui/pi-tui-renderer.js";
import type { TuiEphemeralState } from "../../src/tui/tui-ephemeral-state.js";
import type { TuiViewState } from "../../src/tui/tui-view-state.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  waitForAbort,
  type FakeModelTurnRequest,
  type FakeModelTurnSignal,
  type FakeStreamBehavior,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO } from "../helpers.js";

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

const TARGET = "fixtures/phase-07-fix-and-verify/src/clamp.mjs";
const VERIFY_CWD = "fixtures/phase-07-fix-and-verify";
const BUGGY = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(minimum, Math.max(maximum, value));",
  "}",
  "",
].join("\n");
const FIXED = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(maximum, Math.max(minimum, value));",
  "}",
  "",
].join("\n");
const PATCH = [
  `diff --git a/${TARGET} b/${TARGET}`,
  `--- a/${TARGET}`,
  `+++ b/${TARGET}`,
  "@@ -1,3 +1,3 @@",
  " export function clamp(value, minimum, maximum) {",
  "-  return Math.min(minimum, Math.max(maximum, value));",
  "+  return Math.min(maximum, Math.max(minimum, value));",
  " }",
  "",
].join("\n");

const PLAN_ITEMS = Object.freeze([
  Object.freeze({
    acceptance: "The clamp correction is stored as an attributed Goal change.",
    id: "apply-fix",
    required: true,
    title: "Apply the bounded clamp correction",
  }),
  Object.freeze({
    acceptance: "The checked-in local verifier passes after the correction.",
    id: "verify-fix",
    required: true,
    title: "Run the local verification",
  }),
  Object.freeze({
    acceptance: "The final source bytes are read and reviewed in the continuing run.",
    id: "review-result",
    required: true,
    title: "Review the durable result",
  }),
  Object.freeze({
    acceptance: "A current verification proves the Goal is ready for completion.",
    id: "finish-goal",
    required: true,
    title: "Close the verified Goal",
  }),
]);

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16f-m7-"));
  workspaces.push(workspace);
  const destination = join(workspace, VERIFY_CWD);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve("fixtures", "phase-07-fix-and-verify"), destination, {
    recursive: true,
  });
  await writeFile(join(workspace, ...TARGET.split("/")), BUGGY, "utf8");
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 M7 Fixture"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "--all"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: workspace,
  });
  return workspace;
}

function turn(
  name: string,
  callId: string,
  input: Readonly<Record<string, unknown>>,
): readonly FakeModelTurnSignal[] {
  return [
    {
      call: { argumentsJson: JSON.stringify(input), callId, name },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation(callId),
      providerResponseId: `response-${callId}`,
      type: "turn_completed",
    },
  ];
}

function finalTurn(text: string): readonly FakeModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    {
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    },
    {
      continuation: new FakeContinuation("plan-final"),
      providerResponseId: "response-plan-final",
      type: "turn_completed",
    },
  ];
}

function scriptedBehavior(
  createTurn: (
    index: number,
    request: FakeModelTurnRequest,
  ) => readonly FakeModelTurnSignal[],
): FakeStreamBehavior {
  let index = 0;
  return async function* (request) {
    const signals = createTurn(index, request);
    index += 1;
    yield* signals;
  };
}

function m7Backend(behavior: FakeStreamBehavior): FakeStreamingChatClient {
  const backend = new FakeStreamingChatClient(behavior, {
    model: "qwen3:1.7b",
    provider: "ollama",
  });
  Object.defineProperty(backend, "contextCapacity", {
    value: Object.freeze({
      contextWindowTokens: 131_072,
      maximumOutputTokens: 8_192,
      source: "pinned_catalog",
    }),
  });
  return backend;
}

function visibleWaitForAbort(): FakeStreamBehavior {
  const wait = waitForAbort();
  return async function* (request, signal) {
    yield { delta: "Second Goal started.", type: "text_delta" };
    yield* wait(request, signal);
  };
}

interface WriterProbe {
  current: V2SessionWriter | null;
}

function events(probe: WriterProbe) {
  if (probe.current === null) throw new Error("active V2 writer is unavailable");
  return probe.current.events;
}

function currentPlan(probe: WriterProbe) {
  const projection = reconstructMultiRunSession(events(probe)).taskState;
  if (projection.currentApprovedPlan === null) {
    throw new Error("current approved Plan is unavailable");
  }
  return projection.currentApprovedPlan;
}

function lastEventId(
  probe: WriterProbe,
  predicate: (event: (ReturnType<typeof events>)[number]) => boolean,
): string {
  const event = [...events(probe)].reverse().find(predicate);
  if (event === undefined) throw new Error("required durable evidence is unavailable");
  return event.eventId;
}

function planBehavior(): FakeStreamBehavior {
  return scriptedBehavior((index) => {
    switch (index) {
      case 0:
        return turn("read_file", "plan-read-source", {
          end_line: null,
          path: TARGET,
          start_line: null,
        });
      case 1:
        return turn("read_file", "plan-read-verifier", {
          end_line: null,
          path: `${VERIFY_CWD}/verify.mjs`,
          start_line: null,
        });
      case 2:
        return turn("update_plan", "plan-propose", {
          operation: "propose",
          plan: { items: PLAN_ITEMS, title: "M7 verified clamp workflow" },
        });
      case 3:
        return finalTurn("The four-item durable Plan is ready for exact review.");
      default:
        throw new Error("unexpected Plan model turn");
    }
  });
}

function buildABehavior(probe: WriterProbe): FakeStreamBehavior {
  return scriptedBehavior((index) => {
    const plan = currentPlan(probe);
    const status = (
      itemId: string,
      next: "completed" | "in_progress",
      evidenceEventIds: readonly string[],
      note: string,
    ) =>
      turn("update_plan", `run-a-${itemId}-${next}`, {
        evidence_event_ids: evidenceEventIds,
        item_id: itemId,
        note,
        operation: "set_item_status",
        plan_id: plan.planId,
        plan_sha256: plan.planSha256,
        revision: plan.revision,
        status: next,
      });
    switch (index) {
      case 0:
        return status("apply-fix", "in_progress", [], "Starting the bounded edit.");
      case 1:
        return turn("apply_patch", "run-a-patch", { patch: PATCH });
      case 2:
        return status(
          "apply-fix",
          "completed",
          [
            lastEventId(
              probe,
              (event) => event.type === "patch.apply.completed",
            ),
          ],
          "The attributed patch completed durably.",
        );
      case 3:
        return status("verify-fix", "in_progress", [], "Running the local verifier.");
      case 4:
        return turn("run_command", "run-a-verify", {
          args: ["verify.mjs"],
          cwd: VERIFY_CWD,
          executable: "node",
          purpose: "verify",
          timeout_ms: 120_000,
        });
      case 5:
        return status(
          "verify-fix",
          "completed",
          [
            lastEventId(
              probe,
              (event) => event.type === "verification.completed",
            ),
          ],
          "The checked-in verifier passed.",
        );
      case 6:
        return turn("finish_task", "run-a-finish-early", {
          status: "completed",
          summary: "The code and base verification pass, but two required Plan items remain.",
        });
      default:
        throw new Error("unexpected Build A model turn");
    }
  });
}

function buildBBehavior(probe: WriterProbe): FakeStreamBehavior {
  return scriptedBehavior((index) => {
    if (index !== 0) throw new Error("Build B must pause after one Plan revision call");
    const plan = currentPlan(probe);
    return turn("update_plan", "run-b-revise-plan", {
      base_plan_id: plan.planId,
      base_revision: plan.revision,
      base_sha256: plan.planSha256,
      operation: "revise",
      plan: {
        items: PLAN_ITEMS,
        title: "M7 verified clamp workflow, reviewed revision",
      },
    });
  });
}

function buildCBehavior(probe: WriterProbe): FakeStreamBehavior {
  return scriptedBehavior((index) => {
    const plan = currentPlan(probe);
    const status = (
      itemId: string,
      next: "completed" | "in_progress",
      evidenceEventIds: readonly string[],
      note: string,
    ) =>
      turn("update_plan", `run-c-${itemId}-${next}`, {
        evidence_event_ids: evidenceEventIds,
        item_id: itemId,
        note,
        operation: "set_item_status",
        plan_id: plan.planId,
        plan_sha256: plan.planSha256,
        revision: plan.revision,
        status: next,
      });
    switch (index) {
      case 0:
        return status("review-result", "in_progress", [], "Reviewing final source bytes.");
      case 1:
        return turn("read_file", "run-c-review-source", {
          end_line: null,
          path: TARGET,
          start_line: null,
        });
      case 2:
        return status(
          "review-result",
          "completed",
          [
            lastEventId(
              probe,
              (event) =>
                event.type === "tool.call.completed" &&
                event.data.call_id === "run-c-review-source",
            ),
          ],
          "The continuing run reviewed the corrected source.",
        );
      case 3:
        return status("finish-goal", "in_progress", [], "Producing current verification evidence.");
      case 4:
        return turn("run_command", "run-c-verify", {
          args: ["verify.mjs"],
          cwd: VERIFY_CWD,
          executable: "node",
          purpose: "verify",
          timeout_ms: 120_000,
        });
      case 5:
        return status(
          "finish-goal",
          "completed",
          [
            lastEventId(
              probe,
              (event) => event.type === "verification.completed",
            ),
          ],
          "Current verification passed and all required Plan items are terminal.",
        );
      case 6:
        return turn("finish_task", "run-c-finish", {
          status: "completed",
          summary: "The cross-run Goal change is verified and every required Plan item is complete.",
        });
      default:
        throw new Error("unexpected Build C model turn");
    }
  });
}

class M7Renderer implements PiTuiRenderer {
  readonly start = vi.fn(() => {
    queueMicrotask(() => this.submit("Fix and verify the clamp through a reviewed Plan"));
  });
  readonly stop = vi.fn();
  completedGoalReport: OutcomeReport | null = null;
  draftAfterCancellation: string | null = null;
  error: Error | null = null;
  finalReportSha256: string | null = null;
  planWorkspaceWasReadOnly = false;

  private readonly approvalRequests = new Set<string>();
  private cancellationDraftSubmitted = false;
  private cancellationRequested = false;
  private checkingPlanWorkspace = false;
  private exiting = false;
  private pendingCommandRetry = false;
  private planDecisions = new Set<string>();
  private retryWhenIdle = false;
  private secondGoalSubmitted = false;
  private readonly terminalRuns: string[] = [];

  constructor(
    private readonly onInput: PiTuiRendererOptions["onInput"],
    private readonly verifyPlanWorkspace: () => Promise<void>,
  ) {}

  update(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    try {
      this.updateInner(view, ephemeral);
    } catch (error) {
      this.error =
        error instanceof Error ? error : new Error("M7 renderer update failed");
      throw error;
    }
  }

  private updateInner(view: TuiViewState, ephemeral: TuiEphemeralState): void {
    if (this.exiting) return;
    const approval = view.approval;
    if (
      approval?.expiresState.status === "active" &&
      !this.approvalRequests.has(approval.requestId)
    ) {
      this.approvalRequests.add(approval.requestId);
      queueMicrotask(() => {
        this.onInput?.("\t");
        this.onInput?.("\r");
      });
      return;
    }

    const dialog = ephemeral.planDecisionDialog;
    if (dialog !== null) {
      this.pendingCommandRetry = false;
      this.retryWhenIdle = false;
      const key = `${dialog.planId}:${String(dialog.revision)}:${dialog.action}`;
      if (!this.planDecisions.has(key)) {
        this.planDecisions.add(key);
        queueMicrotask(() => {
          this.onInput?.("\t");
          this.onInput?.("\r");
        });
      }
      return;
    }

    const diagnostic = ephemeral.coreDiagnostic;
    if (view.run?.status === "running" && this.pendingCommandRetry) {
      this.pendingCommandRetry = false;
      this.retryWhenIdle = false;
    }
    const retryableIdleRace =
      diagnostic?.startsWith("Run active") === true ||
      diagnostic?.includes("only while the session is idle") === true ||
      diagnostic?.includes("Session refresh") === true;
    if (retryableIdleRace && this.pendingCommandRetry) {
      this.retryWhenIdle = true;
      return;
    }
    if (
      this.retryWhenIdle &&
      this.pendingCommandRetry &&
      diagnostic === null
    ) {
      this.retryWhenIdle = false;
      queueMicrotask(() => this.onInput?.("\r"));
      return;
    }
    if (
      diagnostic?.startsWith("Run active") === true &&
      this.cancellationDraftSubmitted &&
      !this.cancellationRequested
    ) {
      this.cancellationRequested = true;
      queueMicrotask(() => this.onInput?.("\u0003"));
      return;
    }
    if (
      diagnostic !== null &&
      !retryableIdleRace &&
      !diagnostic.includes("Cancelled")
    ) {
      this.fail(new Error(diagnostic));
      return;
    }

    if (
      view.run !== null &&
      view.run.status === "running" &&
      this.terminalRuns.length === 4 &&
      this.secondGoalSubmitted &&
      view.transcript.some(
        (item) =>
          item.kind === "model" &&
          item.runId === view.run?.id &&
          item.status === "streaming",
      ) &&
      !this.cancellationDraftSubmitted
    ) {
      this.cancellationDraftSubmitted = true;
      queueMicrotask(() => this.submit("draft retained across active cancellation"));
      return;
    }

    if (
      view.run === null ||
      view.run.status === "running" ||
      this.terminalRuns.includes(view.run.id)
    ) {
      return;
    }
    this.terminalRuns.push(view.run.id);
    switch (this.terminalRuns.length) {
      case 1:
        if (this.checkingPlanWorkspace) return;
        this.checkingPlanWorkspace = true;
        void this.verifyPlanWorkspace()
          .then(() => {
            this.planWorkspaceWasReadOnly = true;
            this.submitCommand("/plan approve-build");
          })
          .catch((error: unknown) =>
            this.fail(
              error instanceof Error
                ? error
                : new Error("Plan workspace verification failed"),
            ),
          );
        return;
      case 2:
        this.submitCommand("/continue");
        return;
      case 3:
        this.submitCommand("/plan approve-build");
        return;
      case 4:
        if (view.outcomeReport?.outcome !== "completed") {
          this.fail(new Error("the first Goal did not reach verified completion"));
          return;
        }
        this.completedGoalReport = view.outcomeReport;
        this.secondGoalSubmitted = true;
        setTimeout(
          () => {
            this.submit("Start a second Goal and then cancel it");
            for (const delay of [1_000, 3_000, 6_000]) {
              setTimeout(() => {
                if (!this.cancellationDraftSubmitted && !this.exiting) {
                  this.onInput?.("\r");
                }
              }, delay);
            }
          },
          1_000,
        );
        return;
      case 5:
        this.draftAfterCancellation = ephemeral.draftInput;
        this.finalReportSha256 = view.outcomeReport?.reportSha256 ?? null;
        this.exiting = true;
        queueMicrotask(() => {
          this.onInput?.("\u0003");
          this.onInput?.("\u0003");
        });
        return;
      default:
        this.fail(new Error("unexpected extra TUI run"));
    }
  }

  private fail(error: Error): void {
    if (this.error !== null) return;
    this.error = error;
    this.exiting = true;
    queueMicrotask(() => {
      this.onInput?.("\u0003");
      this.onInput?.("\u0003");
    });
    for (const delay of [500, 1_500, 3_000, 5_000]) {
      setTimeout(() => {
        this.onInput?.("\u0003");
        this.onInput?.("\u0003");
        this.onInput?.("\u0004");
      }, delay);
    }
  }

  public failAfterTimeout(): void {
    this.fail(
      new Error(
        `M7 TUI watchdog expired after ${String(this.terminalRuns.length)} terminal runs; ` +
          `backend cancellation submitted=${String(this.cancellationDraftSubmitted)}, ` +
          `requested=${String(this.cancellationRequested)}`,
      ),
    );
  }

  private submit(value: string): void {
    this.onInput?.(value);
    this.onInput?.("\r");
  }

  private submitCommand(value: string): void {
    this.pendingCommandRetry = true;
    queueMicrotask(() => this.submit(value));
    for (const delay of [25, 100, 250]) {
      setTimeout(() => {
        if (this.pendingCommandRetry && !this.exiting) this.onInput?.("\r");
      }, delay);
    }
  }
}

class ReplayRenderer implements PiTuiRenderer {
  readonly start = vi.fn(() => {
    queueMicrotask(() => this.submit(`/session ${this.sessionId}`));
  });
  readonly stop = vi.fn();
  reportSha256: string | null = null;
  private exiting = false;

  constructor(
    private readonly sessionId: string,
    private readonly onInput: PiTuiRendererOptions["onInput"],
  ) {}

  update(view: TuiViewState): void {
    if (
      this.exiting ||
      view.session.id !== this.sessionId ||
      view.outcomeReport === null
    ) {
      return;
    }
    this.reportSha256 = view.outcomeReport.reportSha256;
    this.exiting = true;
    queueMicrotask(() => {
      this.onInput?.("\u0003");
      this.onInput?.("\u0003");
    });
  }

  private submit(value: string): void {
    this.onInput?.(value);
    this.onInput?.("\r");
  }
}

describe("Phase 16F M7 zero-cost gate", () => {
  it("completes the reviewed multi-run Goal, starts a new Goal, and replays the same final report", async () => {
    const cwd = await fixtureWorkspace();
    const probe: WriterProbe = { current: null };
    const backends = [
      m7Backend(planBehavior()),
      m7Backend(buildABehavior(probe)),
      m7Backend(buildBBehavior(probe)),
      m7Backend(buildCBehavior(probe)),
      m7Backend(visibleWaitForAbort()),
    ];
    let backendIndex = 0;
    let renderer: M7Renderer | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const memory = createMemoryIO();
    const node = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      cwd,
      env: {},
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase16f-m7",
    });
    const runtime: CliRuntime = {
      ...node,
      agentModelEvidence: () => ({
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      }),
      createModelBackend: () => {
        const backend = backends[backendIndex];
        backendIndex += 1;
        if (backend === undefined) throw new Error("unexpected backend request");
        return backend;
      },
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
      observeSessionWriter: (writer) => {
        probe.current = writer as V2SessionWriter;
      },
      tuiHost: {
        createRenderer: (options) => {
          renderer = new M7Renderer(options.onInput, async () => {
            const status = await execFileAsync("git", ["status", "--porcelain"], {
              cwd,
            });
            expect(status.stdout).toBe("");
            expect(await readFile(join(cwd, ...TARGET.split("/")), "utf8")).toBe(
              BUGGY,
            );
          });
          watchdog = setTimeout(() => {
            renderer?.failAfterTimeout();
          }, 25_000);
          return renderer;
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
    };
    const exitCode = await runCli(
      [
        "tui",
        "--allow-degraded-resume",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--edit-approval",
        "ask",
        "--command-approval",
        "ask",
        "--max-steps",
        "12",
        "--report-format",
        "json",
      ],
      memory.io,
      runtime,
    );
    if (watchdog !== undefined) clearTimeout(watchdog);

    expect(
      exitCode,
      JSON.stringify({
          error: renderer?.error?.stack ?? null,
          backendCalls: backends.map((backend) => backend.calls.length),
          backendIndex,
          stderr: memory.readStderr(),
          stdout: memory.readStdout(),
          tail:
            probe.current === null
              ? []
              : probe.current.events.slice(-20).map((event) => ({
                  data: event.data,
                  runId: "runId" in event ? event.runId : null,
                  seq: event.sessionSeq,
                  type: event.type,
                })),
        }),
    ).toBe(0);
    expect(
      renderer?.error,
      JSON.stringify({
        backendCalls: backends.map((backend) => backend.calls.length),
        backendIndex,
        tail:
          probe.current?.events.slice(-16).map((event) => ({
            data: event.data,
            seq: event.sessionSeq,
            type: event.type,
          })) ?? [],
      }),
    ).toBeNull();
    expect(renderer?.planWorkspaceWasReadOnly).toBe(true);
    expect(renderer?.draftAfterCancellation).toBe(
      "draft retained across active cancellation",
    );
    expect(await readFile(join(cwd, ...TARGET.split("/")), "utf8")).toBe(FIXED);
    expect(backendIndex).toBe(5);
    expect(backends.map((backend) => backend.calls.length)).toEqual([
      4, 7, 1, 7, 1,
    ]);

    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    );
    expect(file).toBeDefined();
    const sessionId = file!.slice(0, -".jsonl".length);
    const stored = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file!),
    );
    const reconstructed = reconstructMultiRunSession(stored);
    const starts = stored.filter((event) => event.type === "run.started");
    const goals = stored.filter((event) => event.type === "goal.created");
    expect(starts).toHaveLength(5);
    expect(goals).toHaveLength(2);
    expect(goals[0]!.data.goal_id).not.toBe(goals[1]!.data.goal_id);
    expect(
      stored.filter(
        (event) =>
          event.type === "tool.call.completed" &&
          event.data.tool_name === "read_file" &&
          event.runId === starts[0]!.runId,
      ),
    ).toHaveLength(2);
    expect(
      stored.filter((event) => event.type === "patch.apply.completed"),
    ).toHaveLength(1);
    expect(
      stored.filter((event) => event.type === "approval.requested"),
    ).toHaveLength(3);
    expect(
      stored.find(
        (event) =>
          event.type === "run.incomplete" &&
          event.data.reason === "plan_incomplete",
      ),
    ).toBeDefined();
    expect(
      stored.find(
        (event) =>
          event.type === "run.incomplete" &&
          event.data.reason === "plan_approval_required",
      ),
    ).toBeDefined();
    expect(
      stored.find(
        (event) =>
          event.type === "run.completed" &&
          event.data.completion_mode === "verified_finish_task",
      ),
    ).toBeDefined();
    expect(stored.at(-1)?.type).toBe("run.cancelled");
    expect(reconstructed.status).toBe("cancelled");

    const firstGoalTerminalIndex = stored.findIndex(
      (event) =>
        event.type === "run.completed" && event.runId === starts[3]!.runId,
    );
    expect(firstGoalTerminalIndex).toBeGreaterThan(0);
    const completedPrefix = reconstructMultiRunSession(
      stored.slice(0, firstGoalTerminalIndex + 1),
    );
    const completedReport = new OutcomeReportBuilder().build(completedPrefix);
    expect(renderer?.completedGoalReport?.reportSha256).toBe(
      completedReport.reportSha256,
    );
    expect(completedReport).toMatchObject({
      changes: [{ path: TARGET, sourceRunIds: [starts[1]!.runId] }],
      outcome: "completed",
      plan: { execution: { completedItems: 4, revision: 2, totalItems: 4 } },
    });

    const show = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "show", sessionId, "--json"],
        show.io,
        runtime,
      ),
      show.readStderr(),
    ).toBe(0);
    const shown = JSON.parse(show.readStdout()) as {
      readonly outcomeReport: { readonly reportSha256: string };
    };
    expect(shown.outcomeReport.reportSha256).toBe(renderer?.finalReportSha256);

    let replayRenderer: ReplayRenderer | undefined;
    let replayTimedOut = false;
    let replayWatchdog: ReturnType<typeof setTimeout> | undefined;
    const replayRuntime: CliRuntime = {
      ...runtime,
      createModelBackend: () => {
        throw new Error("replay-only TUI must not create a backend");
      },
      tuiHost: {
        createRenderer: (options) => {
          replayRenderer = new ReplayRenderer(sessionId, options.onInput);
          replayWatchdog = setTimeout(() => {
            replayTimedOut = true;
            for (let index = 0; index < 4; index += 1) {
              options.onInput?.("\u0003");
            }
          }, 10_000);
          return replayRenderer;
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
    };
    const replayIo = createMemoryIO();
    const replayExit = await runCli(
        ["tui", "--provider", "ollama", "--model", "qwen3:1.7b"],
        replayIo.io,
        replayRuntime,
      );
    if (replayWatchdog !== undefined) clearTimeout(replayWatchdog);
    expect(replayExit, replayIo.readStderr()).toBe(0);
    expect(replayTimedOut).toBe(false);
    expect(replayRenderer?.reportSha256).toBe(shown.outcomeReport.reportSha256);
  }, 40_000);
});
