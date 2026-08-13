import type { SessionRegistry } from "./session-registry.js";

/**
 * AS3.3: catalog/materialization and active-run cancellation share one
 * append-only journal, but application use cases receive only the lifecycle
 * they own. This is interface segregation, not a durable-format split.
 */
export type SessionCatalogRegistryV1 = Pick<SessionRegistry,
  | "adoptLegacy"
  | "appendMaterialization"
  | "appendMaterializationIntent"
  | "create"
  | "findCreatedByOperation"
  | "head"
  | "project"
  | "resourceScope"
>;

export type RunLifecycleRegistryV1 = Pick<SessionRegistry,
  | "bindRunCancelRequest"
  | "closeRunCancelBarrier"
  | "observeRunOwner"
  | "readRunCancelBarrier"
  | "registerRunOwner"
  | "requestRunCancel"
>;

export type ApplicationSessionRegistryV1 = SessionCatalogRegistryV1 & RunLifecycleRegistryV1;
