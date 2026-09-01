import { afterEach } from "vitest";
import { Socket } from "node:net";

import {
  NetworkActivityLedger,
  type NetworkGuardReport,
} from "../src/providers/pi/provider-network-guard.js";

type Connect = Socket["connect"];

let activity = new NetworkActivityLedger();

export function phase8NetworkActivityLedger(): NetworkActivityLedger {
  return activity;
}

export function phase8NetworkActivityReport(): NetworkGuardReport {
  return activity.report();
}

function hasForbiddenRemoteActivity(report: NetworkGuardReport): boolean {
  return report.blockedRemoteAttemptCount !== 0 ||
    report.openedRemoteSocketCount !== 0 ||
    report.remoteProviderRequestCount !== 0 ||
    report.billableRequestCount !== 0 ||
    report.remoteFetchAttemptCount !== 0 ||
    report.remoteSocketAttemptCount !== 0;
}

export function assertNoForbiddenRemoteActivity(
  report: NetworkGuardReport = activity.report(),
): void {
  if (hasForbiddenRemoteActivity(report)) {
    throw new Error(
      `Phase 8 network evidence is not zero-cost: ${JSON.stringify(report)}`,
    );
  }
}

/**
 * Consumes the evidence from an isolated negative test that deliberately hits
 * the tripwire. It refuses to reset an empty ledger, so ordinary tests cannot
 * use this helper to hide an unobserved zero.
 */
export function consumeExpectedRemoteAttemptEvidence(): NetworkGuardReport {
  const report = activity.report();
  if (!hasForbiddenRemoteActivity(report)) {
    throw new Error("expected Phase 8 tripwire activity was not observed");
  }
  activity = new NetworkActivityLedger();
  return report;
}

function loopback(host: string | undefined): boolean {
  return host === undefined ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.toLowerCase() === "localhost";
}

function connectHost(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "object" && first !== null && "host" in first) {
    const host = (first as { readonly host?: unknown }).host;
    return typeof host === "string" ? host : undefined;
  }
  if (typeof first === "number") {
    return typeof args[1] === "string" ? args[1] : undefined;
  }
  // A string first argument is an IPC pipe path, not a TCP hostname.
  return undefined;
}

const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedConnect(
  this: Socket,
  ...args: Parameters<Connect>
): Socket {
  const host = connectHost(args);
  if (!loopback(host)) {
    activity.recordBlockedRemoteSocketAttempt();
    throw new Error("remote socket blocked by Phase 8 test tripwire");
  }
  return Reflect.apply(originalConnect, this, args) as Socket;
} as Connect;

const originalFetch = globalThis.fetch;
if (originalFetch !== undefined) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (!loopback(url.hostname)) {
      activity.recordBlockedRemoteFetchAttempt();
      throw new Error("remote fetch blocked by Phase 8 test tripwire");
    }
    return originalFetch(input, init);
  };
}

// PHASE8: Tests remove real remote credentials before any adapter is created.
// Contract fixtures inject sentinel handles directly, so a passing suite cannot
// accidentally become a paid live interoperability test.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  const snapshot = activity.report();
  activity = new NetworkActivityLedger();
  if (hasForbiddenRemoteActivity(snapshot)) {
    throw new Error(
      `Phase 8 network tripwire observed a remote attempt: ${JSON.stringify(snapshot)}`,
    );
  }
});
