import { EvalCoreError } from "./eval-errors.js";

export interface GraderContainerSpec {
  readonly phase: "worker" | "supervisor";
  readonly image: string;
  readonly network: "none";
  readonly readOnlyRoot: true;
  readonly runAs: string;
  readonly mounts: readonly { readonly source: string; readonly target: string; readonly readOnly: true }[];
  readonly environment: Readonly<Record<string, never>>;
}

export interface HiddenGraderPort {
  runWorker(spec: GraderContainerSpec, signal: AbortSignal): Promise<{ readonly observationsPath: string }>;
  runSupervisor(spec: GraderContainerSpec, observationsPath: string, signal: AbortSignal): Promise<{ readonly exitCode: number }>;
  cleanup(phase: "worker" | "supervisor"): Promise<boolean>;
}

export interface HiddenGraderRequest {
  readonly image: string;
  readonly workspacePath: string;
  readonly graderPath: string;
  readonly runnerPath: string;
  readonly observationsPath: string;
}

function assertDigestImage(image: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new EvalCoreError("eval_hidden_grader_invalid", "grader image must be digest pinned", 1);
  }
}

export class HiddenGraderRunner {
  public constructor(private readonly port: HiddenGraderPort) {}

  public async run(request: HiddenGraderRequest, signal: AbortSignal): Promise<boolean> {
    assertDigestImage(request.image);
    // PHASE14: the candidate worker never mounts grader bytes; only after worker cleanup may a supervisor see expectations and observations.
    const worker: GraderContainerSpec = Object.freeze({
      phase: "worker",
      image: request.image,
      network: "none",
      readOnlyRoot: true,
      runAs: "65532:65532",
      mounts: Object.freeze([
        Object.freeze({ source: request.workspacePath, target: "/workspace", readOnly: true }),
        Object.freeze({ source: request.runnerPath, target: "/runner", readOnly: true }),
      ]),
      environment: Object.freeze({}),
    });
    const supervisor: GraderContainerSpec = Object.freeze({
      phase: "supervisor",
      image: request.image,
      network: "none",
      readOnlyRoot: true,
      runAs: "65532:65532",
      mounts: Object.freeze([
        Object.freeze({ source: request.graderPath, target: "/grader", readOnly: true }),
        Object.freeze({ source: request.observationsPath, target: "/observations", readOnly: true }),
      ]),
      environment: Object.freeze({}),
    });

    let workerStarted = false;
    let supervisorStarted = false;
    let result: boolean | undefined;
    let failure: unknown;
    let cleanupFailure: boolean;
    try {
      workerStarted = true;
      const workerResult = await this.port.runWorker(worker, signal);
      if (!(await this.port.cleanup("worker"))) {
        throw new EvalCoreError("eval_hidden_grader_invalid", "candidate worker cleanup was not proven", 1);
      }
      workerStarted = false;
      supervisorStarted = true;
      const supervisorResult = await this.port.runSupervisor(supervisor, workerResult.observationsPath, signal);
      result = supervisorResult.exitCode === 0;
    } catch (error) {
      failure = error;
    } finally {
      if (workerStarted) await this.port.cleanup("worker").catch(() => false);
      cleanupFailure = supervisorStarted && !(await this.port.cleanup("supervisor").catch(() => false));
    }
    if (cleanupFailure) throw new EvalCoreError("eval_hidden_grader_invalid", "grader supervisor cleanup was not proven", 1);
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new EvalCoreError("eval_hidden_grader_invalid", "grader ended without a result", 1);
    return result;
  }
}
