import type {
  CommandActionIdentity,
  CommandPurpose,
  EnvironmentPolicyIdentity,
  ExecutionInputFingerprints,
  LifecycleScriptFingerprints,
  PackageManagerIdentity as PermissionPackageManagerIdentity,
} from "../permissions/permission-types.js";

export type ExecutionPurpose = CommandPurpose;

export type ExecutionTermination =
  | "cancelled"
  | "cleanup_failed"
  | "exit"
  | "output_limit_exceeded"
  | "signal"
  | "spawn_error"
  | "stale"
  | "timeout";

export interface ExecutionIntent {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly purpose: ExecutionPurpose;
}

export interface ExecutionRequest {
  /** Host path used only by the executor. It must never be rendered in an event. */
  readonly executableFile: string;
  readonly logicalExecutable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly purpose: ExecutionPurpose;
}

export type ExecutionEnvironmentIdentity = EnvironmentPolicyIdentity;
export type ExecutionInputIdentity = ExecutionInputFingerprints;
export type PackageManagerIdentity = PermissionPackageManagerIdentity;
export type LifecycleScriptIdentity = LifecycleScriptFingerprints;

export interface ReviewedLifecycleScript {
  readonly name: string;
  readonly body: string;
}

export interface ExecutionReview {
  readonly lifecycleScripts: readonly ReviewedLifecycleScript[];
  readonly warning: string;
}

export type NormalizedExecutionAction = CommandActionIdentity;

export interface PreparedExecution {
  readonly request: ExecutionRequest;
  readonly actionIdentity: CommandActionIdentity;
  readonly actionSha256: string;
  readonly executionInputsSha256: string;
  readonly review: ExecutionReview;
  revalidate(): Promise<"current" | "stale">;
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly termination: ExecutionTermination;
  readonly processIdentity?: string;
  readonly cleanupVerified: boolean;
  readonly errorCode?: string;
}

export type ExecutionSignal =
  | { readonly type: "started"; readonly processIdentity?: string }
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly chunk: string;
      readonly chunkBytes: number;
    }
  | { readonly type: "completed"; readonly result: ExecutionResult };

export interface Executor {
  execute(
    prepared: PreparedExecution,
    signal: AbortSignal,
  ): AsyncIterable<ExecutionSignal>;
}

export class ExecutionPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionPreparationError";
  }
}
