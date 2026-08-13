import type { CliIO, CliRuntime } from "../cli/types.js";
import { ConsoleEventRenderer } from "../render/console-event-renderer.js";
import { renderOutcomeReport } from "../coordination/outcome-report-renderer.js";
import type {
  AgentExecutionPresentationPortV1,
  AgentExecutionRuntimePortV1,
} from "./agent-execution-service.js";

/** CLI composition only: adapt the broad process runtime into the owner ports. */
export function createAgentExecutionRuntimePort(
  runtime: CliRuntime,
  io: CliIO,
): AgentExecutionRuntimePortV1 {
  return Object.freeze<AgentExecutionRuntimePortV1>({
    agentModelEvidence: (provider) => runtime.agentModelEvidence(provider),
    clearTimer: (handle) => runtime.clearTimer(handle),
    createAgentToolRegistry: (options) => runtime.createAgentToolRegistry(options),
    createApprovalPrompt: () => runtime.createApprovalPrompt(io),
    ...(runtime.createCapabilityPlatform === undefined
      ? {}
      : { createCapabilityPlatform: (workspace: string) => runtime.createCapabilityPlatform!(workspace) }),
    ...(runtime.createCheckpointStore === undefined
      ? {}
      : { createCheckpointStore: (workspace: string) => runtime.createCheckpointStore!(workspace) }),
    ...(runtime.createHookCommandRunner === undefined
      ? {}
      : { createHookCommandRunner: (options: Parameters<NonNullable<CliRuntime["createHookCommandRunner"]>>[0]) => runtime.createHookCommandRunner!(options) }),
    ...(runtime.createMcpClientManager === undefined
      ? {}
      : { createMcpClientManager: (options: Parameters<NonNullable<CliRuntime["createMcpClientManager"]>>[0]) => runtime.createMcpClientManager!(options) }),
    createModelBackend: (request) => runtime.createModelBackend(request),
    ...(runtime.createRepositoryNavigationService === undefined
      ? {}
      : { createRepositoryNavigationService: (workspace: string, secrets: readonly string[], events?: Parameters<NonNullable<CliRuntime["createRepositoryNavigationService"]>>[2]) => runtime.createRepositoryNavigationService!(workspace, secrets, events) }),
    createSessionWriter: (workspace, sessionId) => runtime.createSessionWriter(workspace, sessionId),
    cwd: runtime.cwd,
    ...(runtime.dockerArtifactAcquirer === undefined ? {} : { dockerArtifactAcquirer: runtime.dockerArtifactAcquirer }),
    env: runtime.env,
    execPath: runtime.execPath,
    ...(runtime.hooksSuppressed === undefined ? {} : { hooksSuppressed: runtime.hooksSuppressed }),
    ...(runtime.modelQualificationGate === undefined ? {} : { modelQualificationGate: runtime.modelQualificationGate }),
    now: () => runtime.now(),
    ...(runtime.observeSessionWriter === undefined
      ? {}
      : { observeSessionWriter: (writer: Parameters<NonNullable<CliRuntime["observeSessionWriter"]>>[0]) => runtime.observeSessionWriter!(writer) }),
    onCancel: (listener) => runtime.onCancel(listener),
    platform: runtime.platform,
    randomUUID: () => runtime.randomUUID(),
    setTimer: (listener, delayMs) => runtime.setTimer(listener, delayMs),
    ...(runtime.supportsDelegationProposalTool === undefined
      ? {}
      : { supportsDelegationProposalTool: runtime.supportsDelegationProposalTool }),
    timestamp: () => runtime.timestamp(),
  });
}

export function createAgentExecutionPresentationPort(
  io: CliIO,
  verbose: boolean,
  reportFormat: "json" | "text" = "text",
): AgentExecutionPresentationPortV1 {
  const renderer = new ConsoleEventRenderer(io, verbose);
  return Object.freeze<AgentExecutionPresentationPortV1>({
    render: (event) => renderer.render(event),
    renderDiagnostic: (message) => renderer.renderDiagnostic(message),
    renderLegacyCompletionReport: (report, terminal) => {
      io[terminal === "completed" ? "stdout" : "stderr"].write(report);
    },
    renderOutcomeReport: (report, successful) => {
      io[successful ? "stdout" : "stderr"].write(renderOutcomeReport(report, reportFormat));
    },
    renderStorageError: () => renderer.renderStorageError(),
    renderVerbose: (value) => io.stderr.write(value),
  });
}
