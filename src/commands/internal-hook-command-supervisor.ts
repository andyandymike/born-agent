import type { CliIO, CliRuntime } from "../cli/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface InternalHookCommandSupervisorOptions {
  readonly invocationId: string;
  readonly runId: string;
  readonly sessionId: string;
}

export async function executeInternalHookCommandSupervisor(
  options: InternalHookCommandSupervisorOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 8> {
  try {
    if (![options.invocationId, options.runId, options.sessionId].every((value) => UUID.test(value))) {
      throw new Error("internal Hook supervisor identity is invalid");
    }
    if (runtime.runInternalHookCommandSupervisor === undefined) {
      throw new Error("runtime has no internal Hook supervisor entry");
    }
    await runtime.runInternalHookCommandSupervisor(options);
    return 0;
  } catch {
    // This boundary never prints bootstrap, path, environment, nonce, output,
    // or nested error text. The parent and operation journal own diagnosis.
    io.stderr.write("hook_effect_unknown: internal Hook supervisor did not finish cleanly\n");
    return 8;
  }
}
