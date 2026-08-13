export interface DomainHarnessV1 {
  readonly kind: "bornagent_domain_harness";
  readonly schemaVersion: 1;
}

export interface DomainHarnessCarrierV1 {
  readonly controlPlaneStateRoot?: string;
  readonly domainHarness?: DomainHarnessV1;
}

export function createDomainHarness(): DomainHarnessV1 {
  return Object.freeze({ kind: "bornagent_domain_harness", schemaVersion: 1 });
}

/**
 * AS4.1: direct domain mutation is an explicit test/eval capability, never an
 * accidental consequence of a missing product configuration value.
 */
export function isDomainHarnessRuntime(runtime: DomainHarnessCarrierV1): boolean {
  if (runtime.domainHarness === undefined) return false;
  if (
    runtime.domainHarness.kind !== "bornagent_domain_harness" ||
    runtime.domainHarness.schemaVersion !== 1 ||
    runtime.controlPlaneStateRoot !== undefined
  ) {
    throw new TypeError("domain harness identity is invalid or overlaps a product control state root");
  }
  return true;
}
