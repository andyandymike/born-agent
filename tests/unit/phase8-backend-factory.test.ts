import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackendFactory,
  BackendPreflightError,
  createProductionBackendFactory,
  type AgentCapabilityRequirement,
  type PiRuntimeFactoryInput,
} from "../../src/model/backend-factory.js";
import {
  PI_AI_PACKAGE_NAME,
  PI_AI_PACKAGE_VERSION,
  PiModelCatalog,
  type ModelCatalogEntry,
} from "../../src/providers/pi/pi-model-catalog.js";
import type { PiRuntimePort } from "../../src/providers/pi/pi-runtime-port.js";
import {
  ProviderNetworkGuard,
  ProviderNetworkPolicyError,
} from "../../src/providers/pi/provider-network-guard.js";
import {
  CredentialHandle,
  CredentialResolver,
} from "../../src/security/credential-resolver.js";

const AGENT_REQUIREMENT: AgentCapabilityRequirement = {
  cancellation: true,
  completeUsageForReportedTokenCeiling: true,
  streaming: true,
  tools: true,
};

const emptyRuntime: PiRuntimePort = {
  runTurn: async function* () {
    yield { type: "start" };
    return;
  },
};

afterEach(() => vi.restoreAllMocks());

function createFactory(options: {
  catalog?: PiModelCatalog;
  environment?: Readonly<Record<string, string | undefined>>;
  guard?: ProviderNetworkGuard;
  onRuntime?: (input: PiRuntimeFactoryInput) => void;
} = {}): BackendFactory {
  return new BackendFactory({
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    credentialResolver: new CredentialResolver(options.environment ?? {}),
    ...(options.guard === undefined ? {} : { networkGuard: options.guard }),
    runtimeFactory: (input) => {
      options.onRuntime?.(input);
      return emptyRuntime;
    },
  });
}

describe("BackendFactory preflight", () => {
  it("rejects unknown provider/model without constructing a runtime", () => {
    const onRuntime = vi.fn();
    const factory = createFactory({ onRuntime });

    expect(() =>
      factory.create({
        model: "gpt-5.6-terra",
        provider: "unknown",
        requirement: AGENT_REQUIREMENT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "configuration_provider_unknown",
        exitCode: 2,
      }),
    );
    expect(() =>
      factory.create({
        model: "unknown-model",
        provider: "openai",
        requirement: AGENT_REQUIREMENT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "configuration_model_unknown",
        exitCode: 2,
      }),
    );
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it("fails unsupported capabilities before credential/runtime creation", () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: (target, property, receiver) => {
          reads.push(String(property));
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const incompatible: ModelCatalogEntry = {
      capabilities: {
        cancellation: "unsupported",
        reasoning: "none",
        streaming: true,
        tools: "none",
        usage: "partial",
      },
      credentialVariable: "OPENAI_API_KEY",
      displayName: "Incompatible fixture",
      evidenceStatus: "contract_verified",
      modelId: "incompatible-fixture",
      provider: "openai",
      sourcePackage: PI_AI_PACKAGE_NAME,
      sourcePackageVersion: PI_AI_PACKAGE_VERSION,
    };
    const onRuntime = vi.fn();
    const factory = createFactory({
      catalog: new PiModelCatalog([incompatible]),
      environment,
      onRuntime,
    });

    expect(() =>
      factory.create({
        model: incompatible.modelId,
        provider: incompatible.provider,
        requirement: AGENT_REQUIREMENT,
        transportScope: "in_process_contract",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "configuration_capability_unsupported",
        exitCode: 2,
      }),
    );
    expect(reads).toEqual([]);
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it("fails a missing remote key with exit 4 before runtime/socket", () => {
    const guard = new ProviderNetworkGuard();
    const onRuntime = vi.fn();
    const factory = createFactory({ guard, onRuntime });

    expect(() =>
      factory.create({
        model: "gpt-5.6-terra",
        provider: "openai",
        requirement: AGENT_REQUIREMENT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "configuration_credential_missing",
        exitCode: 4,
      }),
    );
    expect(guard.report().blockedRemoteAttemptCount).toBe(0);
    expect(guard.report().openedRemoteSocketCount).toBe(0);
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it("blocks a configured remote provider before runtime construction", () => {
    const guard = new ProviderNetworkGuard();
    const onRuntime = vi.fn();
    const factory = createFactory({
      environment: { OPENAI_API_KEY: "synthetic-never-network" },
      guard,
      onRuntime,
    });

    expect(() =>
      factory.create({
        model: "gpt-5.6-terra",
        provider: "openai",
        requirement: AGENT_REQUIREMENT,
      }),
    ).toThrowError(ProviderNetworkPolicyError);
    expect(guard.report().blockedRemoteAttemptCount).toBe(1);
    expect(guard.report().openedRemoteSocketCount).toBe(0);
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it("creates one frozen loopback Ollama backend with no credential", () => {
    const runtimeInputs: PiRuntimeFactoryInput[] = [];
    const factory = createFactory({
      onRuntime: (input) => runtimeInputs.push(input),
    });

    const backend = factory.create({
      model: "qwen3:1.7b",
      provider: "ollama",
      requirement: AGENT_REQUIREMENT,
    });

    expect(backend.identity).toMatchObject({
      adapter: "pi-ai",
      adapterVersion: PI_AI_PACKAGE_VERSION,
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    expect(backend.identity.configFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(backend.identity)).toBe(true);
    expect(runtimeInputs).toEqual([
      expect.objectContaining({
        credential: null,
        endpoint: "http://127.0.0.1:11434",
        transportScope: "provider_network",
      }),
    ]);
  });

  it("permits remote-provider contract mapping only through an in-process runtime", () => {
    const sentinel = "synthetic-anthropic-handle";
    const runtimeInputs: PiRuntimeFactoryInput[] = [];
    const factory = createFactory({
      environment: { ANTHROPIC_API_KEY: sentinel },
      onRuntime: (input) => runtimeInputs.push(input),
    });

    const backend = factory.create({
      model: "claude-sonnet-5",
      provider: "anthropic",
      requirement: AGENT_REQUIREMENT,
      transportScope: "in_process_contract",
    });

    expect(backend.identity.provider).toBe("anthropic");
    expect(JSON.stringify(backend.identity)).not.toContain(sentinel);
    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]?.credential?.reveal()).toBe(sentinel);
    expect(runtimeInputs[0]?.transportScope).toBe("in_process_contract");
  });

  it("keeps production runtime construction behind the network guard", () => {
    const reveal = vi.spyOn(CredentialHandle.prototype, "reveal");
    const factory = createProductionBackendFactory({
      OPENAI_API_KEY: "configured-but-never-revealed",
    });

    expect(() =>
      factory.create({
        model: "gpt-5.6-terra",
        provider: "openai",
        requirement: AGENT_REQUIREMENT,
      }),
    ).toThrowError(ProviderNetworkPolicyError);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does not let a production runtime claim the synthetic contract scope", () => {
    const reveal = vi.spyOn(CredentialHandle.prototype, "reveal");
    const factory = createProductionBackendFactory({
      ANTHROPIC_API_KEY: "configured-but-never-revealed",
    });

    expect(() =>
      factory.create({
        model: "claude-sonnet-5",
        provider: "anthropic",
        requirement: AGENT_REQUIREMENT,
        transportScope: "in_process_contract",
      }),
    ).toThrowError("production pi runtime cannot use");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("uses stable local preflight error types", () => {
    const error = new BackendPreflightError(
      "configuration_model_unknown",
      "fixture",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.exitCode).toBe(2);
  });
});
