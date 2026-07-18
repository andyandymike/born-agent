import type { DockerExecutionImageIdentity } from "../execution/docker/acquisition/docker-image-identity.js";

export type PermissionEffect = "allow" | "ask" | "deny";

export type CommandPurpose = "inspect" | "verify";

export type Sha256Hex = string;

export interface EnvironmentPolicyIdentity {
  readonly id: string;
  readonly variableNames: readonly string[];
  readonly version: string;
}

export interface DockerCommandEnvironmentIdentity {
  readonly executor: "docker";
  readonly imageDigest: string;
  readonly imageIdentity?: DockerExecutionImageIdentity | undefined;
  readonly imageReference: string;
  readonly network: "none";
  readonly policyVersion: string;
  readonly resourceLimits: {
    readonly cpus: number;
    readonly memoryMiB: number;
    readonly pids: number;
    readonly tmpMiB: number;
  };
  readonly snapshotSha256: string;
  readonly sourceStateSha256: string;
  readonly wrapperSha256: string;
}

export interface BinaryFingerprint {
  /** Internal canonical identity. It must not be copied into display text or events. */
  readonly canonicalIdentity: string;
  readonly bytesSha256: Sha256Hex;
  readonly version: string;
}

export interface PackageManagerIdentity {
  readonly binary: BinaryFingerprint;
  readonly logicalName: "npm" | "pnpm";
  readonly version: string;
}

export interface LifecycleScriptFingerprints {
  readonly mainBodySha256: Sha256Hex;
  readonly postBodySha256: Sha256Hex | null;
  readonly preBodySha256: Sha256Hex | null;
  readonly scriptName: string;
}

export interface RunnerConfigFingerprint {
  readonly canonicalPath: string;
  readonly sha256: Sha256Hex;
}

export interface ExecutionInputFingerprints {
  readonly lockfileSha256: Sha256Hex | null;
  readonly manifestSha256: Sha256Hex | null;
  readonly runnerConfigHashes: readonly RunnerConfigFingerprint[];
}

export interface NormalizedCommandAction {
  readonly actionKind: "command";
  /** Exact argv. These strings are never joined and re-parsed as a shell command. */
  readonly argv: readonly string[];
  readonly binary: BinaryFingerprint;
  /** Workspace-relative POSIX form; `.` is the workspace root. */
  readonly canonicalCwd: string;
  readonly environmentPolicy: EnvironmentPolicyIdentity;
  /**
   * Absent means the legacy/local host executor. Docker actions always carry
   * their complete isolation identity so a local approval can never authorize
   * a container action (or vice versa).
   */
  readonly executionEnvironment?: DockerCommandEnvironmentIdentity;
  readonly executionInputs: ExecutionInputFingerprints;
  readonly lifecycleScripts: LifecycleScriptFingerprints | null;
  readonly logicalExecutable: string;
  readonly outputLimitBytes: number;
  readonly packageManager: PackageManagerIdentity | null;
  readonly purpose: CommandPurpose;
  readonly timeoutMs: number;
}

export interface CommandActionIdentity extends NormalizedCommandAction {
  readonly actionSha256: Sha256Hex;
  readonly executionInputsSha256: Sha256Hex;
}

export type NormalizedAction = CommandActionIdentity | McpPermissionActionIdentity;

export interface PermissionContext {
  /**
   * Action digests loaded from the trusted, checked-in Phase 6 fixture review.
   * Repository/model text must never be allowed to append to this collection.
   */
  readonly reviewedLocalActionSha256?:
    | ReadonlySet<Sha256Hex>
    | readonly Sha256Hex[];
  /** Exact reviewed offline MCP start digests. User approval cannot add one. */
  readonly reviewedOfflineMcpActionSha256?:
    | ReadonlySet<Sha256Hex>
    | readonly Sha256Hex[];
  /** Server ids whose exact start action passed the offline review gate. */
  readonly reviewedOfflineMcpServerIds?:
    | ReadonlySet<string>
    | readonly string[];
}

interface PermissionDecisionBase {
  readonly effect: PermissionEffect;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly ruleId: string;
}

export interface AllowPermissionDecision extends PermissionDecisionBase {
  readonly effect: "allow";
}

export interface AskPermissionDecision extends PermissionDecisionBase {
  readonly effect: "ask";
  readonly reasonCode: string;
}

export interface DenyPermissionDecision extends PermissionDecisionBase {
  readonly effect: "deny";
  readonly reasonCode: string;
}

export type PermissionDecision =
  | AllowPermissionDecision
  | AskPermissionDecision
  | DenyPermissionDecision;

export type PolicyDecision =
  | { readonly effect: "allow"; readonly ruleId: string }
  | {
      readonly effect: "ask";
      readonly reasonCode: string;
      readonly ruleId: string;
    }
  | {
      readonly effect: "deny";
      readonly reasonCode: string;
      readonly ruleId: string;
    };

export interface PermissionPolicy {
  readonly id: string;
  readonly version: string;
  evaluate(
    action: NormalizedAction,
    context: PermissionContext,
  ): PolicyDecision;
}

export interface PermissionEngineLike {
  evaluate(
    action: NormalizedAction,
    context?: PermissionContext,
  ): PermissionDecision;
}
import type { McpPermissionActionIdentity } from "../mcp/mcp-action-identity.js";
