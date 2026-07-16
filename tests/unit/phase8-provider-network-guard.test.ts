import { describe, expect, it } from "vitest";
import { Socket } from "node:net";

import {
  NetworkActivityLedger,
  ProviderNetworkGuard,
  ProviderNetworkPolicyError,
  REMOTE_PROVIDER_FORBIDDEN_CODE,
} from "../../src/providers/pi/provider-network-guard.js";
import {
  consumeExpectedRemoteAttemptEvidence,
  phase8NetworkActivityLedger,
} from "../setup-network-tripwire.js";

describe("ProviderNetworkGuard", () => {
  it.each([
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
  ])("allows literal-loopback Ollama %s", (endpoint) => {
    const guard = new ProviderNetworkGuard();

    guard.assertAllowed({
      endpoint,
      provider: "ollama",
      transportScope: "provider_network",
    });

    expect(guard.report()).toEqual({
      allowedInProcessContractCount: 0,
      allowedLoopbackRequestCount: 1,
      billableRequestCount: 0,
      blockedRemoteAttemptCount: 0,
      guardDecisionCount: 1,
      openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 0,
      remoteProviderRequestCount: 0,
      remoteSocketAttemptCount: 0,
    });
  });

  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["anthropic", "https://api.anthropic.com"],
    ["ollama", "http://ollama.example:11434/v1"],
  ] as const)(
    "rejects %s before remote request creation",
    (provider, endpoint) => {
      const guard = new ProviderNetworkGuard();

      expect(() =>
        guard.assertAllowed({
          endpoint,
          provider,
          transportScope: "provider_network",
        }),
      ).toThrowError(ProviderNetworkPolicyError);
      expect(() =>
        new ProviderNetworkGuard().assertAllowed({
          endpoint,
          provider,
          transportScope: "provider_network",
        }),
      ).toThrowError(REMOTE_PROVIDER_FORBIDDEN_CODE);
      expect(guard.report().blockedRemoteAttemptCount).toBe(1);
      expect(guard.report().openedRemoteSocketCount).toBe(0);
      expect(guard.report().billableRequestCount).toBe(0);
    },
  );

  it("allows a synthetic production-adapter contract runtime in-process", () => {
    const guard = new ProviderNetworkGuard();

    guard.assertAllowed({
      endpoint: undefined,
      provider: "anthropic",
      transportScope: "in_process_contract",
    });

    expect(guard.report().blockedRemoteAttemptCount).toBe(0);
    expect(guard.report().allowedInProcessContractCount).toBe(1);
    expect(guard.report().guardDecisionCount).toBe(1);
  });

  it("records real lower-level fetch and socket tripwire attempts in the same report", async () => {
    const guard = new ProviderNetworkGuard(phase8NetworkActivityLedger());

    await expect(fetch("https://phase8-tripwire.invalid/v1/models")).rejects.toThrow(
      "remote fetch blocked by Phase 8 test tripwire",
    );
    const socket = new Socket();
    expect(() =>
      socket.connect({ host: "phase8-tripwire.invalid", port: 443 }),
    ).toThrow("remote socket blocked by Phase 8 test tripwire");

    const report = guard.report();
    expect(report).toMatchObject({
      billableRequestCount: 0,
      blockedRemoteAttemptCount: 2,
      openedRemoteSocketCount: 0,
      remoteFetchAttemptCount: 1,
      remoteProviderRequestCount: 1,
      remoteSocketAttemptCount: 1,
    });
    expect(consumeExpectedRemoteAttemptEvidence()).toEqual(report);
  });

  it("derives sent-request and opened-socket counters from lower-level accounting", () => {
    const activity = new NetworkActivityLedger();
    activity.recordOpenedRemoteSocket();
    activity.recordRemoteProviderRequestSent({ billable: true });

    expect(activity.report()).toMatchObject({
      billableRequestCount: 1,
      openedRemoteSocketCount: 1,
      remoteProviderRequestCount: 1,
      remoteSocketAttemptCount: 1,
    });
  });
});
