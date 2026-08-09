import type { CliIO, CliRuntime } from "../cli/types.js";
import { BackgroundError } from "../background/background-errors.js";

export interface InternalGraphWorkerOptions {
  readonly operationId: string;
  readonly repositoryId: string;
}

export async function executeInternalGraphWorker(
  options: InternalGraphWorkerOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 3 | 8> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.operationId)) {
      throw new BackgroundError("worker_protocol_mismatch", "internal worker operation ID is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(options.repositoryId)) {
      throw new BackgroundError("worker_protocol_mismatch", "internal worker repository ID is invalid");
    }
    const execute = runtime.runInternalGraphWorker;
    if (execute === undefined) throw new BackgroundError("background_executable_unsealed", "runtime has no internal worker entry");
    await execute({ io, operationId: options.operationId, repositoryId: options.repositoryId });
    return 0;
  } catch (error) {
    if (error instanceof BackgroundError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write("worker_reconciliation_required: internal worker failed without a terminal receipt\n");
    return 8;
  }
}
