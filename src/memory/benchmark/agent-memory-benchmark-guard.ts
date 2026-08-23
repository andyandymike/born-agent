import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

import { sha256Canonical } from "../../completion/canonical-json.js";

const guardedCredentialNames = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
] as const);

export const agentMemoryBenchmarkGuardDescriptorV1 = Object.freeze({
  credentialPolicy: "deny-known-provider-env-read-v1",
  guardedCredentialNames,
  networkPolicy: "deny-fetch-dns-tcp-udp-v1",
  providerPolicy: "no-provider-construction-or-dispatch-v1",
  schemaVersion: 1,
});

export const agentMemoryBenchmarkGuardIdentitySha256 = sha256Canonical(
  agentMemoryBenchmarkGuardDescriptorV1,
);

export class AgentMemoryBenchmarkGuardError extends Error {
  override readonly name = "AgentMemoryBenchmarkGuardError";

  public constructor(
    public readonly code:
      | "agent_memory_benchmark_credential_denied"
      | "agent_memory_benchmark_network_denied"
      | "agent_memory_benchmark_provider_denied",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface AgentMemoryBenchmarkGuard {
  readonly credentialReadAttemptCount: number;
  readonly networkAttemptCount: number;
  readonly providerCallCount: number;
  assertClean(): void;
  denyProviderUse(): never;
  restore(): void;
}

function deniedNetwork(): never {
  throw new AgentMemoryBenchmarkGuardError(
    "agent_memory_benchmark_network_denied",
    "agent memory characterization is local-only",
  );
}

export function sanitizedAgentMemoryBenchmarkEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      guardedCredentialNames.includes(
        key as (typeof guardedCredentialNames)[number],
      ) ||
      /(?:api[_-]?key|credential|password|secret|token)$/iu.test(key)
    ) {
      continue;
    }
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function installAgentMemoryBenchmarkGuard(): AgentMemoryBenchmarkGuard {
  let credentialReadAttemptCount = 0;
  let networkAttemptCount = 0;
  let providerCallCount = 0;
  let restored = false;

  const originalEnvironment = process.env;
  const guardedNames = new Set<string>(guardedCredentialNames);
  process.env = new Proxy(originalEnvironment, {
    get(target, property, receiver) {
      if (typeof property === "string" && guardedNames.has(property)) {
        credentialReadAttemptCount += 1;
        throw new AgentMemoryBenchmarkGuardError(
          "agent_memory_benchmark_credential_denied",
          `ambient credential ${property} is unavailable to the benchmark`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === "string" && guardedNames.has(property)) {
        credentialReadAttemptCount += 1;
        throw new AgentMemoryBenchmarkGuardError(
          "agent_memory_benchmark_credential_denied",
          `ambient credential ${property} is unavailable to the benchmark`,
        );
      }
      return Reflect.has(target, property);
    },
  });

  const originalFetch = globalThis.fetch;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalUdpSend = dgram.Socket.prototype.send;
  const originalLookup = dns.lookup;
  const originalResolve = dns.resolve;
  const originalReverse = dns.reverse;
  const originalPromisesLookup = dns.promises.lookup;
  const originalPromisesResolve = dns.promises.resolve;
  const originalPromisesReverse = dns.promises.reverse;

  const block = (): never => {
    networkAttemptCount += 1;
    return deniedNetwork();
  };

  globalThis.fetch = block as typeof globalThis.fetch;
  net.Socket.prototype.connect = block as unknown as typeof net.Socket.prototype.connect;
  dgram.Socket.prototype.send = block as unknown as typeof dgram.Socket.prototype.send;
  dns.lookup = block as unknown as typeof dns.lookup;
  dns.resolve = block as unknown as typeof dns.resolve;
  dns.reverse = block as unknown as typeof dns.reverse;
  dns.promises.lookup = block as unknown as typeof dns.promises.lookup;
  dns.promises.resolve = block as unknown as typeof dns.promises.resolve;
  dns.promises.reverse = block as unknown as typeof dns.promises.reverse;

  return Object.freeze({
    get credentialReadAttemptCount() {
      return credentialReadAttemptCount;
    },
    get networkAttemptCount() {
      return networkAttemptCount;
    },
    get providerCallCount() {
      return providerCallCount;
    },
    assertClean() {
      if (networkAttemptCount > 0) deniedNetwork();
      if (credentialReadAttemptCount > 0) {
        throw new AgentMemoryBenchmarkGuardError(
          "agent_memory_benchmark_credential_denied",
          "agent memory benchmark attempted to read an ambient credential",
        );
      }
      if (providerCallCount > 0) {
        throw new AgentMemoryBenchmarkGuardError(
          "agent_memory_benchmark_provider_denied",
          "agent memory benchmark attempted to construct or dispatch a provider",
        );
      }
    },
    denyProviderUse() {
      providerCallCount += 1;
      throw new AgentMemoryBenchmarkGuardError(
        "agent_memory_benchmark_provider_denied",
        "agent memory characterization has no provider port",
      );
    },
    restore() {
      if (restored) return;
      restored = true;
      process.env = originalEnvironment;
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalSocketConnect;
      dgram.Socket.prototype.send = originalUdpSend;
      dns.lookup = originalLookup;
      dns.resolve = originalResolve;
      dns.reverse = originalReverse;
      dns.promises.lookup = originalPromisesLookup;
      dns.promises.resolve = originalPromisesResolve;
      dns.promises.reverse = originalPromisesReverse;
    },
  });
}
