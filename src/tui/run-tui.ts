import type { AgentCommandOptions } from "../agent/agent-types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { executeAgent } from "../commands/agent.js";
import { executeSessionsResume } from "../commands/sessions.js";
import { SessionCatalog } from "../sessions/session-catalog.js";
import { ApprovalController } from "./approval-controller.js";
import { PersistedEventSource } from "./persisted-event-source.js";
import { TuiAbortBridge } from "./tui-abort-bridge.js";
import { TuiApprovalPrompt } from "./tui-approval-prompt.js";
import { TuiController, type TuiCorePort } from "./tui-controller.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";

export interface TuiCommandOptions
  extends Omit<AgentCommandOptions, "task" | "verbose"> {
  readonly allowDegradedResume: boolean;
  readonly resumeSessionId: string | undefined;
  readonly task: string | undefined;
}

const SILENT_TUI_IO: CliIO = {
  stderr: { write: () => undefined },
  stdout: { write: () => undefined },
};

function usage(io: CliIO, message: string): 2 {
  io.stderr.write(`usage/config error: ${message}\n`);
  return 2;
}

function agentOptions(
  options: TuiCommandOptions,
  task: string,
): AgentCommandOptions {
  return {
    artifactCaptureBytes: options.artifactCaptureBytes,
    commandApproval: options.commandApproval,
    commandTimeoutMs: options.commandTimeoutMs,
    completionPolicy: options.completionPolicy,
    contextCompactionThreshold: options.contextCompactionThreshold,
    contextReserveOutputTokens: options.contextReserveOutputTokens,
    contextWindowTokens: options.contextWindowTokens,
    editApproval: options.editApproval,
    maxDurationMs: options.maxDurationMs,
    maxCommandOutputBytes: options.maxCommandOutputBytes,
    maxSteps: options.maxSteps,
    maxTokens: options.maxTokens,
    maxToolOutputBytes: options.maxToolOutputBytes,
    model: options.model,
    provider: options.provider,
    reportFormat: options.reportFormat,
    requireVerification: options.requireVerification,
    requestTimeoutMs: options.requestTimeoutMs,
    task,
    taskProfile: options.taskProfile,
    verbose: false,
  };
}

export async function executeTui(
  options: TuiCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  if (options.task !== undefined && options.resumeSessionId !== undefined) {
    return usage(io, "task and --resume are mutually exclusive");
  }
  const host = runtime.tuiHost;
  if (host === undefined || !host.stdinIsTTY || !host.stdoutIsTTY) {
    return usage(
      io,
      "born tui requires interactive stdin/stdout; use born agent instead",
    );
  }

  const abortBridge = new TuiAbortBridge();
  const controllerRef: { current?: TuiController } = {};
  const source = new PersistedEventSource({
    onEvent: (event) => controllerRef.current?.acceptPersistedEvent(event),
    onFatal: () => controllerRef.current?.handleSourceFatal(),
  });
  const approvalPrompt = new TuiApprovalPrompt(() => {
    if (controllerRef.current === undefined) {
      throw new Error("TUI approval prompt started before its controller");
    }
    return controllerRef.current.view;
  });
  const tuiRuntime: CliRuntime = {
    ...runtime,
    createApprovalPrompt: () => approvalPrompt,
    observeSessionWriter: (writer) => {
      runtime.observeSessionWriter?.(writer);
      source.observe(writer);
    },
    onCancel: abortBridge.onCancel,
  };
  const catalog = new SessionCatalog(runtime.cwd);
  const core: TuiCorePort = {
    cancelActiveRun: () => abortBridge.cancelActiveRun(),
    loadSession: async (sessionId) =>
      (await catalog.read(sessionId)).events as readonly TuiPersistedEvent[],
    resumeSession: (sessionId, message) =>
      executeSessionsResume(
        {
          allowDegradedResume: options.allowDegradedResume,
          message,
          sessionId,
        },
        tuiRuntime,
        SILENT_TUI_IO,
      ),
    startTask: (task) =>
      executeAgent(agentOptions(options, task), tuiRuntime, SILENT_TUI_IO),
  };
  let initialSnapshot: readonly TuiPersistedEvent[] = [];
  if (options.resumeSessionId !== undefined) {
    try {
      initialSnapshot = await core.loadSession(options.resumeSessionId);
    } catch {
      io.stderr.write("born tui: could not load the requested session\n");
      return 1;
    }
  }

  const renderer = host.createRenderer({
    onInput: (data) => controllerRef.current?.handleRawInput(data),
    secrets: [runtime.env.OPENAI_API_KEY, runtime.env.ANTHROPIC_API_KEY],
  });
  const approvalController = new ApprovalController(
    () => {
      if (controllerRef.current === undefined) {
        throw new Error("TUI approval controller is not initialized");
      }
      return controllerRef.current.view;
    },
    approvalPrompt,
  );
  const controller = new TuiController({
    approvalController,
    core,
    renderer,
    source,
  });
  controllerRef.current = controller;

  let exitCode: 0 | 1;
  try {
    controller.start(initialSnapshot);
    // PHASE11: run exit codes stay in durable events. The app remains alive
    // after completion/cancellation and returns only its own 0/1 lifecycle code.
    await controller.runInitial({
      ...(options.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
      ...(options.task === undefined ? {} : { task: options.task }),
    });
    exitCode = await controller.waitForExit();
  } catch {
    abortBridge.cancelActiveRun();
    exitCode = 1;
  } finally {
    try {
      controller.stop();
    } catch {
      exitCode = 1;
    }
  }
  return exitCode;
}
