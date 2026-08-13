import type { AgentExitCode } from "../../agent/agent-types.js";
import type { CliIO, CliRuntime } from "../../cli/types.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import type { ApplicationCommitBindingV1 } from "../application-protocol.js";
import type {
  SessionResumeOwnerPortV1,
  SessionResumePayloadV1,
  SessionResumeRunLifecyclePortV1,
} from "../use-cases/session-resume-action.js";
import {
  CliSessionResumeOwnerPort,
  executeSessionResumeThroughApplicationServiceResult,
  type SessionResumeApplicationOptionsV1,
  type SessionResumeApplicationResultV1,
} from "./session-resume-cli-adapter.js";

export interface SessionResumePhase9RequestV1 {
  readonly applicationAuthority: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly runLifecycle: SessionResumeRunLifecyclePortV1;
  }>;
  readonly options: Readonly<{
    readonly allowDegradedResume: boolean;
    readonly continueApprovedPlan?: boolean | undefined;
    readonly expectedSessionSeq: number;
    readonly inputSurface: "cli" | "tui";
    readonly message: string | undefined;
    readonly mode?: string | undefined;
    readonly modeSource?: "explicit_cli" | "explicit_tui" | "tui_default";
    readonly planRevision?: string | undefined;
    readonly planSha256?: string | undefined;
    readonly policyConfig?: string | undefined;
    readonly policyProfile?: string | undefined;
    readonly sessionId: string;
  }>;
}

/**
 * Narrow owner-internal bridge. It receives authenticated application
 * authority and normalized Phase 9 options only; no argv parsing, command
 * routing, prepared-action rendering, or authorization lives behind it.
 */
export interface SessionResumePhase9ExecutionPortV1 {
  execute(input: SessionResumePhase9RequestV1): Promise<AgentExitCode>;
}

export interface SessionResumeRuntimeRequestV1 extends SessionResumeApplicationOptionsV1 {
  readonly inputSurface: "cli" | "tui";
}

function modeSource(
  payload: SessionResumePayloadV1,
  surface: "cli" | "tui",
): "explicit_cli" | "explicit_tui" | "tui_default" | undefined {
  if (payload.mode === undefined) return undefined;
  if (surface === "cli") return "explicit_cli";
  return payload.modeSelection === "surface_default" ? "tui_default" : "explicit_tui";
}

function phase9Request(
  input: Parameters<SessionResumeOwnerPortV1["execute"]>[0],
): SessionResumePhase9RequestV1 {
  const surface = input.authenticatedMutation.surface.surface;
  if (surface !== "cli" && surface !== "tui") {
    throw new TypeError("local resume owner requires a CLI or TUI application surface");
  }
  const selectedModeSource = modeSource(input.payload, surface);
  return Object.freeze({
    applicationAuthority: Object.freeze({
      applicationCommit: input.applicationCommit,
      authenticatedMutation: input.authenticatedMutation,
      runLifecycle: input.runLifecycle,
    }),
    options: Object.freeze({
      allowDegradedResume: input.payload.allowDegradedResume,
      ...(input.payload.continueApprovedPlan === undefined
        ? {}
        : { continueApprovedPlan: input.payload.continueApprovedPlan }),
      expectedSessionSeq: input.expectedHead.sequence,
      inputSurface: surface,
      message: input.payload.message,
      ...(input.payload.mode === undefined ? {} : { mode: input.payload.mode }),
      ...(selectedModeSource === undefined
        ? {}
        : { modeSource: selectedModeSource }),
      ...(input.payload.planRevision === undefined ? {} : { planRevision: input.payload.planRevision }),
      ...(input.payload.planSha256 === undefined ? {} : { planSha256: input.payload.planSha256 }),
      ...(input.payload.policyConfig === undefined ? {} : { policyConfig: input.payload.policyConfig }),
      ...(input.payload.policyProfile === undefined ? {} : { policyProfile: input.payload.policyProfile }),
      sessionId: input.sessionId,
    }),
  });
}

/** Build the exact-evidence owner without exposing it to a product surface. */
export function createSessionResumeOwnerPortForRuntime(input: Readonly<{
  readonly phase9: SessionResumePhase9ExecutionPortV1;
  readonly runtime: CliRuntime;
}>): SessionResumeOwnerPortV1 {
  return new CliSessionResumeOwnerPort({
    dispatch: async (ownerInput) => input.phase9.execute(phase9Request(ownerInput)),
    runtime: input.runtime,
  });
}

/**
 * Surface-neutral product entrypoint for CLI and TUI. Every invocation uses
 * the authenticated ApplicationService composite; the supplied Phase 9 port
 * can execute only after the exact prepared action has committed authority.
 */
export async function executeSessionResumeThroughRuntimeAdapter(input: Readonly<{
  readonly io: CliIO;
  readonly phase9: SessionResumePhase9ExecutionPortV1;
  readonly request: SessionResumeRuntimeRequestV1;
  readonly runtime: CliRuntime;
}>): Promise<SessionResumeApplicationResultV1> {
  if (input.runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("session resume runtime adapter requires a Host control state root");
  }
  return executeSessionResumeThroughApplicationServiceResult(
    input.request,
    input.runtime,
    input.io,
    createSessionResumeOwnerPortForRuntime({ phase9: input.phase9, runtime: input.runtime }),
  );
}
