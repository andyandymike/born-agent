import type { ProviderId } from "../../model/model-backend.js";
import { resolveLoopbackOllamaURL } from "../../security/loopback-ollama-url.js";

export const REMOTE_PROVIDER_FORBIDDEN_CODE =
  "remote_provider_forbidden_by_cost_policy";

export type ProviderTransportScope =
  | "in_process_contract"
  | "provider_network";

export interface NetworkGuardReport {
  readonly allowedInProcessContractCount: number;
  readonly allowedLoopbackRequestCount: number;
  readonly billableRequestCount: number;
  readonly blockedRemoteAttemptCount: number;
  readonly guardDecisionCount: number;
  readonly openedRemoteSocketCount: number;
  readonly remoteFetchAttemptCount: number;
  readonly remoteProviderRequestCount: number;
  readonly remoteSocketAttemptCount: number;
}

export type ProviderNetworkGuardDecision =
  | "allow_in_process_contract"
  | "allow_loopback_provider"
  | "block_remote_provider";

interface MutableNetworkActivityCounters {
  allowedInProcessContractCount: number;
  allowedLoopbackRequestCount: number;
  billableRequestCount: number;
  blockedRemoteAttemptCount: number;
  guardDecisionCount: number;
  openedRemoteSocketCount: number;
  remoteFetchAttemptCount: number;
  remoteProviderRequestCount: number;
  remoteSocketAttemptCount: number;
}

function emptyCounters(): MutableNetworkActivityCounters {
  return {
    allowedInProcessContractCount: 0,
    allowedLoopbackRequestCount: 0,
    billableRequestCount: 0,
    blockedRemoteAttemptCount: 0,
    guardDecisionCount: 0,
    openedRemoteSocketCount: 0,
    remoteFetchAttemptCount: 0,
    remoteProviderRequestCount: 0,
    remoteSocketAttemptCount: 0,
  };
}

/**
 * Shared accounting seam for the policy guard and lower-level transports.
 *
 * The guard records policy decisions. A socket/fetch tripwire can receive the
 * same ledger and record attempts that bypassed the guard. This makes a zero
 * report an observed fact instead of a fixture-owned constant.
 */
export class NetworkActivityLedger {
  readonly #counters = emptyCounters();

  recordGuardDecision(decision: ProviderNetworkGuardDecision): void {
    this.#counters.guardDecisionCount += 1;
    switch (decision) {
      case "allow_in_process_contract":
        this.#counters.allowedInProcessContractCount += 1;
        return;
      case "allow_loopback_provider":
        this.#counters.allowedLoopbackRequestCount += 1;
        return;
      case "block_remote_provider":
        this.#counters.blockedRemoteAttemptCount += 1;
        return;
    }
  }

  recordBlockedRemoteFetchAttempt(): void {
    this.#counters.blockedRemoteAttemptCount += 1;
    this.#counters.remoteFetchAttemptCount += 1;
    // An outbound HTTP attempt is conservatively a provider request attempt.
    // The tripwire blocks it before it can become billable.
    this.#counters.remoteProviderRequestCount += 1;
  }

  recordBlockedRemoteSocketAttempt(): void {
    this.#counters.blockedRemoteAttemptCount += 1;
    this.#counters.remoteSocketAttemptCount += 1;
  }

  recordOpenedRemoteSocket(): void {
    this.#counters.openedRemoteSocketCount += 1;
    this.#counters.remoteSocketAttemptCount += 1;
  }

  recordRemoteProviderRequestSent(input: { readonly billable: boolean }): void {
    this.#counters.remoteProviderRequestCount += 1;
    if (input.billable) this.#counters.billableRequestCount += 1;
  }

  report(): NetworkGuardReport {
    return Object.freeze({ ...this.#counters });
  }
}

export class ProviderNetworkPolicyError extends Error {
  readonly code = REMOTE_PROVIDER_FORBIDDEN_CODE;
  readonly exitCode = 2;

  constructor(provider: ProviderId) {
    super(
      `${REMOTE_PROVIDER_FORBIDDEN_CODE}: ${provider} cannot open a remote provider connection under local_free_only`,
    );
    this.name = "ProviderNetworkPolicyError";
  }
}

export class ProviderNetworkGuard {
  readonly #activity: NetworkActivityLedger;

  constructor(activity = new NetworkActivityLedger()) {
    this.#activity = activity;
  }

  assertAllowed(input: {
    readonly endpoint: string | undefined;
    readonly provider: ProviderId;
    readonly transportScope: ProviderTransportScope;
  }): void {
    if (input.transportScope === "in_process_contract") {
      this.#activity.recordGuardDecision("allow_in_process_contract");
      return;
    }

    // PHASE8: fail before a request object or socket exists. A provider being
    // free, trial-backed, proxied, or metadata-only is not a mechanical proof
    // of zero cost; only literal-loopback Ollama crosses this boundary.
    if (input.provider !== "ollama" || input.endpoint === undefined) {
      this.#activity.recordGuardDecision("block_remote_provider");
      throw new ProviderNetworkPolicyError(input.provider);
    }

    const result = resolveLoopbackOllamaURL(input.endpoint);
    if (!result.ok) {
      this.#activity.recordGuardDecision("block_remote_provider");
      throw new ProviderNetworkPolicyError(input.provider);
    }
    this.#activity.recordGuardDecision("allow_loopback_provider");
  }

  report(): NetworkGuardReport {
    return this.#activity.report();
  }
}
