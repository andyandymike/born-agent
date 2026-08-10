import type { CliIO, CliRuntime } from "../cli/types.js";
import { DelegationError } from "../delegation/delegation-errors.js";

export interface InternalDelegationChildOptions {
  readonly envelopePath: string;
  readonly nonce: string;
  readonly operationId: string;
}

export async function executeInternalDelegationChild(
  options: InternalDelegationChildOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.operationId)) {
      throw new DelegationError("delegation_child_protocol_invalid", "internal child operation ID is invalid");
    }
    if (options.nonce.length < 32 || options.nonce.length > 128 || options.envelopePath.length < 1) {
      throw new DelegationError("delegation_child_protocol_invalid", "internal child bootstrap is invalid");
    }
    if (runtime.runInternalDelegationChild === undefined) {
      throw new DelegationError("delegation_handshake_failed", "runtime has no internal delegated child entry");
    }
    await runtime.runInternalDelegationChild({
      envelopePath: options.envelopePath,
      io,
      nonce: options.nonce,
      operationId: options.operationId,
    });
    return 0;
  } catch (error) {
    if (error instanceof DelegationError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write("delegation_effect_reconciliation_required: internal child failed without a trusted terminal receipt\n");
    return 8;
  }
}
