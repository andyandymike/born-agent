import type {
  DetachedContainerRuntimePort,
  SanitizedContainerInspection,
} from "../execution/docker/container-lifecycle.js";
import type { ContainerReconciliationRuntimePort } from "../execution/docker/container-reconciliation-runtime.js";
import type {
  DigestPinnedImageReference,
  LocalDockerImageInspection,
  LocalDockerImageInspector,
} from "../execution/docker/docker-policy.js";

export const EVAL_DOCKER_IMAGE = `bornagent-eval/node@sha256:${"a".repeat(64)}`;
export const EVAL_DOCKER_WRAPPER_SHA256 = "b".repeat(64);
export const EVAL_DOCKER_IMAGE_ID = `sha256:${"c".repeat(64)}`;

interface MutableContainer {
  inspection: SanitizedContainerInspection;
}

function argumentAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined) throw new TypeError(`eval Docker argv is missing ${flag}`);
  return value;
}

function labelsFrom(argv: readonly string[]): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--label") continue;
    const pair = argv[index + 1];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair === undefined || separator <= 0) {
      throw new TypeError("eval Docker label argv is malformed");
    }
    labels[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return Object.freeze(labels);
}

function cloneInspection(
  value: SanitizedContainerInspection,
): SanitizedContainerInspection {
  return Object.freeze({ ...value, labels: Object.freeze({ ...value.labels }) });
}

export class InProcessEvalDockerRuntime
  implements
    DetachedContainerRuntimePort,
    ContainerReconciliationRuntimePort,
    LocalDockerImageInspector
{
  readonly #byId = new Map<string, MutableContainer>();
  readonly #byName = new Map<string, MutableContainer>();
  #counter = 0;

  public get liveContainerCount(): number {
    return this.#byId.size;
  }

  public async daemonOperatingSystem(): Promise<string> {
    return "linux";
  }

  public async inspectLocal(
    reference: DigestPinnedImageReference,
  ): Promise<LocalDockerImageInspection | null> {
    if (reference.reference !== EVAL_DOCKER_IMAGE) return null;
    return Object.freeze({
      architecture: "amd64",
      configuredUser: "65532:65532",
      id: EVAL_DOCKER_IMAGE_ID,
      labels: Object.freeze({
        "org.bornagent.exec-wrapper-sha256": EVAL_DOCKER_WRAPPER_SHA256,
        "org.bornagent.image-policy-version": "phase13-docker-v1",
        "org.bornagent.runtime": "node",
        "org.bornagent.runtime-version": "phase14-eval",
      }),
      operatingSystem: "linux",
      repoDigests: Object.freeze([EVAL_DOCKER_IMAGE]),
    });
  }

  public async create(
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new Error("eval Docker create cancelled");
    const name = argumentAfter(argv, "--name");
    if (this.#byName.has(name)) throw new Error("eval Docker name collision");
    this.#counter += 1;
    const containerId = this.#counter.toString(16).padStart(64, "0");
    const state: MutableContainer = {
      inspection: Object.freeze({
        containerId,
        exitCode: null,
        finishedAt: null,
        imageId: EVAL_DOCKER_IMAGE_ID,
        imageReference: EVAL_DOCKER_IMAGE,
        labels: labelsFrom(argv),
        name,
        oomKilled: false,
        running: false,
        startedAt: null,
        stateError: null,
        status: "created",
      }),
    };
    this.#byId.set(containerId, state);
    this.#byName.set(name, state);
    return containerId;
  }

  public async inspectById(
    containerId: string,
  ): Promise<SanitizedContainerInspection | null> {
    const value = this.#byId.get(containerId)?.inspection;
    return value === undefined ? null : cloneInspection(value);
  }

  public async inspectByName(
    name: string,
  ): Promise<SanitizedContainerInspection | null> {
    const value = this.#byName.get(name)?.inspection;
    return value === undefined ? null : cloneInspection(value);
  }

  public async startDetached(
    containerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error("eval Docker start cancelled");
    const state = this.#require(containerId);
    state.inspection = Object.freeze({
      ...state.inspection,
      running: true,
      startedAt: "2026-07-17T00:00:00.000Z",
      status: "running",
    });
  }

  public async *collectBoundedLogs(
    containerId: string,
    signal: AbortSignal,
  ): AsyncIterable<{
    readonly bytes: number;
    readonly stream: "stderr" | "stdout";
    readonly text: string;
  }> {
    this.#require(containerId);
    if (signal.aborted) return;
    // The deterministic command is `node --version`; expose a fixed container
    // value so tests do not inherit the host Node version.
    const output = "v-phase14-eval\n";
    yield {
      bytes: Buffer.byteLength(output, "utf8"),
      stream: "stdout",
      text: output,
    };
  }

  public async wait(
    containerId: string,
    signal: AbortSignal,
  ): Promise<number> {
    if (signal.aborted) throw new Error("eval Docker wait cancelled");
    const state = this.#require(containerId);
    if (state.inspection.running) this.#markExited(state, 0);
    return state.inspection.exitCode ?? 0;
  }

  public async stop(containerId: string, graceSeconds: number): Promise<void> {
    void graceSeconds;
    const state = this.#require(containerId);
    if (state.inspection.running) this.#markExited(state, 0);
  }

  public async kill(containerId: string): Promise<void> {
    const state = this.#require(containerId);
    if (state.inspection.running) this.#markExited(state, 137);
  }

  public async removeForce(containerId: string): Promise<void> {
    const state = this.#byId.get(containerId);
    if (state === undefined) return;
    this.#byId.delete(containerId);
    this.#byName.delete(state.inspection.name);
  }

  #require(containerId: string): MutableContainer {
    const state = this.#byId.get(containerId);
    if (state === undefined) throw new Error("eval Docker container is absent");
    return state;
  }

  #markExited(state: MutableContainer, exitCode: number): void {
    state.inspection = Object.freeze({
      ...state.inspection,
      exitCode,
      finishedAt: "2026-07-17T00:00:00.010Z",
      running: false,
      status: "exited",
    });
  }
}
