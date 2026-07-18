import type { CliIO } from "../cli/types.js";
import type { EvalExitCode } from "./eval-exit-code.js";

export interface EvalCliResult {
  readonly exitCode: EvalExitCode;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface EvalRunCliOptions {
  readonly suite: string;
  readonly provider: string;
  readonly model: string;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly repetitions?: string;
  readonly task?: string;
  readonly ollamaEndpoint?: string;
  readonly ollamaModelDigest?: string;
  readonly json: boolean;
}

export interface EvalCliRuntime {
  list(options: { readonly json: boolean }): Promise<EvalCliResult>;
  run(options: EvalRunCliOptions): Promise<EvalCliResult>;
  show(options: { readonly runId: string; readonly attempt?: string; readonly json: boolean }): Promise<EvalCliResult>;
  compare(options: { readonly baselineId: string; readonly candidateId: string; readonly json: boolean }): Promise<EvalCliResult>;
}

function emit(result: EvalCliResult, io: CliIO): EvalExitCode {
  if (result.stdout !== undefined) io.stdout.write(result.stdout);
  if (result.stderr !== undefined) io.stderr.write(result.stderr);
  return result.exitCode;
}

function unavailable(io: CliIO): 1 {
  io.stderr.write("eval runtime is unavailable\n");
  return 1;
}

export async function executeEvalList(runtime: EvalCliRuntime | undefined, io: CliIO, json: boolean): Promise<EvalExitCode> {
  return runtime === undefined ? unavailable(io) : emit(await runtime.list({ json }), io);
}

export async function executeEvalRun(runtime: EvalCliRuntime | undefined, io: CliIO, options: EvalRunCliOptions): Promise<EvalExitCode> {
  return runtime === undefined ? unavailable(io) : emit(await runtime.run(options), io);
}

export async function executeEvalShow(runtime: EvalCliRuntime | undefined, io: CliIO, options: { readonly runId: string; readonly attempt?: string; readonly json: boolean }): Promise<EvalExitCode> {
  return runtime === undefined ? unavailable(io) : emit(await runtime.show(options), io);
}

export async function executeEvalCompare(runtime: EvalCliRuntime | undefined, io: CliIO, options: { readonly baselineId: string; readonly candidateId: string; readonly json: boolean }): Promise<EvalExitCode> {
  return runtime === undefined ? unavailable(io) : emit(await runtime.compare(options), io);
}
