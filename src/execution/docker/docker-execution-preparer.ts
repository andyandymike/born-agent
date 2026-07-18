import type {
  ExecutionIntent,
  ExecutionPreparerLike,
  PreparedExecution,
} from "../execution-types.js";
import { createCommandActionIdentity } from "../../permissions/action-digest.js";
import type { NormalizedCommandAction } from "../../permissions/permission-types.js";
import { WorkspaceSnapshotPlanner, type WorkspaceSnapshotPlan } from "../snapshot/workspace-snapshot-planner.js";
import type { SnapshotSourceAdapter } from "../snapshot/workspace-snapshotter.js";
import { SandboxPathMapper } from "./sandbox-path-mapper.js";
import {
  validateDockerImagePolicy,
  validateDockerResourceLimits,
  validateLocalDockerImage,
  type DockerImagePolicy,
  type DockerImagePolicyInput,
  type DockerResourceLimits,
  type LocalDockerImageInspector,
  type ValidatedLocalDockerImage,
} from "./docker-policy.js";
import {
  buildSandboxEnvironment,
  SANDBOX_ENVIRONMENT_POLICY,
} from "./sandbox-environment.js";

const DOCKER_PREPARED = Symbol("bornagent.docker-prepared");

export interface DockerPreparedExecution extends PreparedExecution {
  readonly [DOCKER_PREPARED]: true;
  readonly docker: {
    readonly commandArgs: readonly string[];
    readonly containerCwd: string;
    readonly executionId: string | null;
    readonly hostPlatform: "linux" | "win32";
    readonly image: ValidatedLocalDockerImage;
    readonly limits: DockerResourceLimits;
    readonly plan: WorkspaceSnapshotPlan;
    readonly runId: string;
    readonly source: DockerWorkspaceSnapshotSource;
    readonly workspaceRealPath: string;
  };
}

export interface DockerWorkspaceSnapshotSource extends SnapshotSourceAdapter {
  readonly workspaceRealPath: string;
}

export interface DockerExecutionPreparerOptions {
  readonly hostPlatform: "linux" | "win32";
  readonly imageInspector: LocalDockerImageInspector;
  readonly imagePolicy: DockerImagePolicyInput;
  readonly limits: DockerResourceLimits;
  readonly localPreparer: ExecutionPreparerLike;
  readonly runId: string;
  readonly source: DockerWorkspaceSnapshotSource;
}

function pathArgumentIndexes(
  executable: string,
  args: readonly string[],
): readonly number[] {
  if (executable === "node" && args[0] !== undefined && args[0] !== "--version") {
    return Object.freeze([0]);
  }
  if (executable === "git") {
    const separator = args.indexOf("--");
    return separator < 0
      ? Object.freeze([])
      : Object.freeze(args.slice(separator + 1).map((_value, index) => separator + index + 1));
  }
  return Object.freeze([]);
}

function normalizedDockerAction(
  local: PreparedExecution,
  policy: DockerImagePolicy,
  image: ValidatedLocalDockerImage,
  limits: DockerResourceLimits,
  plan: WorkspaceSnapshotPlan,
): NormalizedCommandAction {
  const action = local.actionIdentity;
  return {
    actionKind: "command",
    argv: action.argv,
    binary: action.binary,
    canonicalCwd: action.canonicalCwd,
    environmentPolicy: {
      id: SANDBOX_ENVIRONMENT_POLICY.id,
      variableNames: buildSandboxEnvironment(policy).names,
      version: SANDBOX_ENVIRONMENT_POLICY.version,
    },
    executionEnvironment: {
      executor: "docker",
      imageDigest: image.image.digest,
      imageIdentity: image.identity,
      imageReference: image.image.reference,
      network: "none",
      policyVersion: policy.imagePolicyVersion,
      resourceLimits: limits,
      snapshotSha256: plan.manifest.sha256,
      sourceStateSha256: plan.sourceStateSha256,
      wrapperSha256: policy.wrapperSha256,
    },
    executionInputs: action.executionInputs,
    lifecycleScripts: action.lifecycleScripts,
    logicalExecutable: action.logicalExecutable,
    outputLimitBytes: action.outputLimitBytes,
    packageManager: action.packageManager,
    purpose: action.purpose,
    timeoutMs: action.timeoutMs,
  };
}

export function isDockerPreparedExecution(
  prepared: PreparedExecution,
): prepared is DockerPreparedExecution {
  return (prepared as Partial<DockerPreparedExecution>)[DOCKER_PREPARED] === true;
}

export class DockerExecutionPreparer implements ExecutionPreparerLike {
  readonly #imagePolicy: DockerImagePolicy;
  readonly #limits: DockerResourceLimits;

  public constructor(private readonly options: DockerExecutionPreparerOptions) {
    this.#imagePolicy = validateDockerImagePolicy(options.imagePolicy);
    this.#limits = validateDockerResourceLimits(options.limits);
  }

  async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    const [local, plan, inspection] = await Promise.all([
      this.options.localPreparer.prepare(intent),
      new WorkspaceSnapshotPlanner(this.options.source).plan(),
      this.options.imageInspector.inspectLocal(this.#imagePolicy.image),
    ]);
    const image = validateLocalDockerImage(this.#imagePolicy, inspection);
    const mapper = new SandboxPathMapper({
      hostPlatform: this.options.hostPlatform,
      hostWorkspaceRoot: this.options.source.workspaceRealPath,
      manifest: plan.manifest,
    });
    const containerCwd = mapper.mapHostCwd(local.request.cwd);
    const commandArgs = mapper.mapArguments({
      args: local.request.args,
      hostCwd: local.request.cwd,
      pathArgumentIndexes: pathArgumentIndexes(
        local.request.logicalExecutable,
        local.request.args,
      ),
    });
    const actionIdentity = createCommandActionIdentity(
      normalizedDockerAction(local, this.#imagePolicy, image, this.#limits, plan),
    );
    const revalidate = async (): Promise<"current" | "stale"> => {
      try {
        const [localState, currentPlan, currentInspection] = await Promise.all([
          local.revalidate(),
          new WorkspaceSnapshotPlanner(this.options.source).plan(),
          this.options.imageInspector.inspectLocal(this.#imagePolicy.image),
        ]);
        const currentImage = validateLocalDockerImage(this.#imagePolicy, currentInspection);
        const currentAction = createCommandActionIdentity(
          normalizedDockerAction(
            local,
            this.#imagePolicy,
            currentImage,
            this.#limits,
            currentPlan,
          ),
        );
        return localState === "current" &&
          currentAction.actionSha256 === actionIdentity.actionSha256 &&
          currentImage.configImageId === image.configImageId
          ? "current"
          : "stale";
      } catch {
        return "stale";
      }
    };
    const build = (executionId: string | null): DockerPreparedExecution => {
      const prepared: DockerPreparedExecution = {
        [DOCKER_PREPARED]: true,
        actionIdentity,
        actionSha256: actionIdentity.actionSha256,
        bindExecutionContext: ({ executionId: selected }) => build(selected),
        docker: Object.freeze({
          commandArgs,
          containerCwd,
          executionId,
          hostPlatform: this.options.hostPlatform,
          image,
          limits: this.#limits,
          plan,
          runId: this.options.runId,
          source: this.options.source,
          workspaceRealPath: this.options.source.workspaceRealPath,
        }),
        environmentEvidence: Object.freeze({
          executor: "docker",
          imageDigest: image.image.digest,
          imageIdentity: image.identity,
          isolation: "docker",
          network: "none",
          policyVersion: this.#imagePolicy.imagePolicyVersion,
          resourceLimits: this.#limits,
          snapshotSha256: plan.manifest.sha256,
        }),
        executionInputsSha256: actionIdentity.executionInputsSha256,
        request: Object.freeze({
          ...local.request,
          environment: buildSandboxEnvironment(this.#imagePolicy).values,
          executableFile: local.request.logicalExecutable,
        }),
        revalidate,
        review: Object.freeze({
          environmentLines: Object.freeze([
            "executor: docker",
            `image: ${image.image.reference}`,
            "network: none",
            `workspace: disposable snapshot ${plan.manifest.sha256}`,
            `limits: ${this.#limits.cpus} CPUs, ${this.#limits.memoryMiB} MiB, ${this.#limits.pids} PIDs, ${local.request.timeoutMs}ms`,
          ]),
          lifecycleScripts: local.review.lifecycleScripts,
          warning:
            "Docker reduces approved repository code access to a disposable snapshot; the daemon, kernel, image trust, and repository-contained secrets remain outside this guarantee. Snapshot outputs are not copied back.",
        }),
      };
      return Object.freeze(prepared);
    };
    return build(null);
  }
}
