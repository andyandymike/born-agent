import type { CliIO, CliRuntime } from "../cli/types.js";
import type {
  DelegationOwnerInteractionPortV1,
  DelegationOwnerRuntimePortV1,
} from "./delegation-owner-execution-service.js";

/** CLI composition only; execution core consumes the explicit owner ports. */
export function createDelegationOwnerRuntimePort(
  runtime: CliRuntime,
  io: CliIO,
): DelegationOwnerRuntimePortV1 {
  return Object.freeze<DelegationOwnerRuntimePortV1>({
    ...(runtime.acquireDelegationGroupLease === undefined
      ? {}
      : { acquireDelegationGroupLease: (input) => runtime.acquireDelegationGroupLease!(input) }),
    ...(runtime.createCapabilityPlatform === undefined
      ? {}
      : { createCapabilityPlatform: (workspace) => runtime.createCapabilityPlatform!(workspace) }),
    ...(runtime.createDelegationChildLauncher === undefined
      ? {}
      : { createDelegationChildLauncher: (options) => runtime.createDelegationChildLauncher!({ ...options, io }) }),
    ...(runtime.createManagedWorktreeManager === undefined
      ? {}
      : { createManagedWorktreeManager: (options) => runtime.createManagedWorktreeManager!({ ...options, io }) }),
    cwd: runtime.cwd,
    ...(runtime.delegationCoordinatorIdentity === undefined
      ? {}
      : { delegationCoordinatorIdentity: () => runtime.delegationCoordinatorIdentity!() }),
    ...(runtime.delegationWriterFactory === undefined
      ? {}
      : { delegationWriterFactory: (context) => runtime.delegationWriterFactory!(context) }),
    env: runtime.env,
    ...(runtime.inspectDelegationOperations === undefined
      ? {}
      : { inspectDelegationOperations: (sessionId) => runtime.inspectDelegationOperations!(sessionId) }),
    ...(runtime.inspectDelegationGroupLease === undefined
      ? {}
      : { inspectDelegationGroupLease: (input) => runtime.inspectDelegationGroupLease!(input) }),
    ...(runtime.modelQualificationGate === undefined
      ? {}
      : { modelQualificationGate: runtime.modelQualificationGate }),
    ...(runtime.observeSessionWriter === undefined
      ? {}
      : { observeSessionWriter: (writer) => runtime.observeSessionWriter!(writer) }),
    onCancel: (listener) => runtime.onCancel(listener),
    platform: runtime.platform,
    randomUUID: () => runtime.randomUUID(),
    ...(runtime.reconcileDelegationGroupTakeover === undefined
      ? {}
      : { reconcileDelegationGroupTakeover: (input) => runtime.reconcileDelegationGroupTakeover!(input) }),
    ...(runtime.reconcileDelegationPreEffectOperation === undefined
      ? {}
      : { reconcileDelegationPreEffectOperation: (input) => runtime.reconcileDelegationPreEffectOperation!(input) }),
    ...(runtime.releaseDelegationGroupLease === undefined
      ? {}
      : { releaseDelegationGroupLease: (input) => runtime.releaseDelegationGroupLease!(input) }),
    timestamp: () => runtime.timestamp(),
  });
}

export function createDelegationOwnerInteractionPort(
  runtime: CliRuntime,
  io: CliIO,
): DelegationOwnerInteractionPortV1 {
  return Object.freeze({
    createApprovalPrompt: () => runtime.createApprovalPrompt(io),
  });
}
