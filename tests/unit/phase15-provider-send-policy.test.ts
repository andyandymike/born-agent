import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ProviderAccessPolicy } from "../../src/policy/provider-access-policy.js";
import { RuntimePolicyProfileRegistry } from "../../src/policy/policy-profile-registry.js";
import { resolveEffectiveRuntimePolicy } from "../../src/policy/policy-resolver.js";
import {
  canonicalPolicyProfileData,
  parseRuntimePolicyProfile,
} from "../../src/policy/runtime-policy-schema.js";
import {
  ProductionPiRuntimePort,
  type PiRuntimeDriver,
  type PiRuntimeDriverLoader,
} from "../../src/providers/pi/production-pi-runtime-port.js";
import type { PiRuntimeRequest } from "../../src/providers/pi/pi-runtime-port.js";

function remotePolicy(maximumRequests = 1) {
  const profile = parseRuntimePolicyProfile({
    docker_acquisition: { kind: "deny" },
    eval_access: {
      allowed_suites: ["targeted", "smoke"],
      max_attempts_per_run: 2,
    },
    id: "remote-openai-contract",
    mode: "remote_explicit",
    model_access: {
      credential_access: "selected_provider_only",
      kind: "remote_explicit",
      limits: {
        max_output_tokens_per_request: 2,
        max_provider_requests_per_run: maximumRequests,
        max_reported_total_tokens_per_run: 20,
      },
      providers: [
        {
          base_urls: ["https://api.openai.com/v1"],
          models: ["gpt-5.6-terra"],
          provider: "openai",
        },
      ],
    },
    schema_version: 1,
  });
  const profileSha256 = sha256Canonical(canonicalPolicyProfileData(profile));
  return resolveEffectiveRuntimePolicy(
    new RuntimePolicyProfileRegistry([
      {
        profile,
        profileSha256,
        source: "explicit_user_path",
      },
    ]),
    profile.id,
  );
}

const request: PiRuntimeRequest = {
  identity: {
    adapter: "pi-ai",
    adapterVersion: "0.80.7",
    configFingerprint: "a".repeat(64),
    model: "gpt-5.6-terra",
    provider: "openai",
  },
  input: { kind: "user_prompt", text: "contract only" },
  instructions: "contract only",
  timeoutMs: 1_000,
  tools: [],
};

async function drain(runtime: ProductionPiRuntimePort): Promise<void> {
  for await (const event of runtime.runTurn(
    request,
    new AbortController().signal,
  )) {
    // A synthetic throwing transport emits no event.
    void event;
  }
}

async function* noEvents(): AsyncIterable<never> {
  for (const event of [] as never[]) yield event;
}

describe("Phase 15 provider send boundary", () => {
  it("consumes a failed remote send slot and refuses the next send locally", async () => {
    const access = new ProviderAccessPolicy(remotePolicy(1));
    let streamCalls = 0;
    let loaderOptions: Parameters<PiRuntimeDriverLoader>[0] | undefined;
    const driver: PiRuntimeDriver = {
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 100,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.6-terra",
        input: ["text"],
        maxTokens: 8_192,
        name: "contract",
        provider: "openai",
        reasoning: true,
      },
      stream: async function* () {
        streamCalls += 1;
        yield* noEvents();
        throw new Error("synthetic transport failure");
      },
    };
    const runtime = new ProductionPiRuntimePort(
      {
        baseUrl: "https://api.openai.com/v1",
        credential: "sentinel-handle-only",
        maximumOutputTokens: 2,
        model: "gpt-5.6-terra",
        provider: "openai",
        providerAccessPolicy: access,
      },
      async (options) => {
        loaderOptions = options;
        return driver;
      },
    );

    await expect(drain(runtime)).rejects.toThrow("synthetic transport failure");
    expect(access.report()).toEqual({ maximum: 1, reserved: 1 });
    expect(loaderOptions?.maximumOutputTokens).toBe(2);
    await expect(drain(runtime)).rejects.toThrow(
      /policy_request_ceiling_exceeded/u,
    );
    expect(streamCalls).toBe(1);
  });

  it("rejects endpoint drift before the synthetic transport send", async () => {
    const access = new ProviderAccessPolicy(remotePolicy(1));
    let streamCalls = 0;
    const runtime = new ProductionPiRuntimePort(
      {
        baseUrl: "https://example.invalid/v1",
        credential: "sentinel-handle-only",
        model: "gpt-5.6-terra",
        provider: "openai",
        providerAccessPolicy: access,
      },
      async () => ({
        model: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          contextWindow: 100,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "gpt-5.6-terra",
          input: ["text"],
          maxTokens: 8_192,
          name: "contract",
          provider: "openai",
          reasoning: true,
        },
        stream: async function* () {
          streamCalls += 1;
          yield* noEvents();
        },
      }),
    );

    await expect(drain(runtime)).rejects.toThrow(/policy_endpoint_denied/u);
    expect(access.report()).toEqual({ maximum: 1, reserved: 0 });
    expect(streamCalls).toBe(0);
  });

  it("reserves atomically when two synthetic sends race for one slot", async () => {
    const access = new ProviderAccessPolicy(remotePolicy(1));
    let streamCalls = 0;
    const runtime = new ProductionPiRuntimePort(
      {
        baseUrl: "https://api.openai.com/v1",
        credential: "sentinel-handle-only",
        model: "gpt-5.6-terra",
        provider: "openai",
        providerAccessPolicy: access,
      },
      async () => ({
        model: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 100,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "gpt-5.6-terra",
          input: ["text"],
          maxTokens: 8_192,
          name: "contract",
          provider: "openai",
          reasoning: true,
        },
        stream: async function* () {
          streamCalls += 1;
          yield* noEvents();
        },
      }),
    );

    const results = await Promise.allSettled([drain(runtime), drain(runtime)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(String(results.find((result) => result.status === "rejected")?.reason))
      .toContain("policy_request_ceiling_exceeded");
    expect(access.report()).toEqual({ maximum: 1, reserved: 1 });
    expect(streamCalls).toBe(1);
  });

  it("does not reserve or send when cancellation happens during driver preflight", async () => {
    const access = new ProviderAccessPolicy(remotePolicy(1));
    const controller = new AbortController();
    let streamCalls = 0;
    const runtime = new ProductionPiRuntimePort(
      {
        baseUrl: "https://api.openai.com/v1",
        credential: "sentinel-handle-only",
        model: "gpt-5.6-terra",
        provider: "openai",
        providerAccessPolicy: access,
      },
      async () => {
        controller.abort();
        return {
          model: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 100,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "gpt-5.6-terra",
            input: ["text"],
            maxTokens: 8_192,
            name: "contract",
            provider: "openai",
            reasoning: true,
          },
          stream: async function* () {
            streamCalls += 1;
            yield* noEvents();
          },
        };
      },
    );
    const events = [];
    for await (const event of runtime.runTurn(request, controller.signal)) {
      events.push(event);
    }

    expect(events).toMatchObject([{ type: "error", reason: "aborted" }]);
    expect(access.report()).toEqual({ maximum: 1, reserved: 0 });
    expect(streamCalls).toBe(0);
  });
});
