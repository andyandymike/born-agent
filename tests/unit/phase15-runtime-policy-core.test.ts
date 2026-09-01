import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimePolicyRegistry } from "../../src/policy/policy-config-loader.js";
import type { RuntimePolicyError } from "../../src/policy/policy-errors.js";
import {
  assertDockerArtifactAccess,
  assertEvalAccess,
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
} from "../../src/policy/policy-resolver.js";
import { parseStrictJson } from "../../src/policy/strict-json.js";
import {
  credentialSecretsForPolicy,
  ProviderRequestLedger,
} from "../../src/policy/provider-access-policy.js";
import { parseUserPolicyConfig } from "../../src/policy/runtime-policy-schema.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase15-"));
  roots.push(value);
  return value;
}

function remoteConfig(): string {
  return JSON.stringify({
    schema_version: 1,
    profiles: [
      {
        schema_version: 1,
        id: "remote-openai-limited",
        mode: "remote_explicit",
        model_access: {
          kind: "remote_explicit",
          providers: [
            {
              provider: "openai",
              models: ["gpt-5.6-terra"],
              base_urls: ["https://api.openai.com/v1"],
            },
          ],
          credential_access: "selected_provider_only",
          limits: {
            max_provider_requests_per_run: 4,
            max_output_tokens_per_request: 2048,
            max_reported_total_tokens_per_run: 20_000,
          },
        },
        eval_access: {
          allowed_suites: ["targeted", "smoke"],
          max_attempts_per_run: 5,
        },
        docker_acquisition: { kind: "deny" },
      },
    ],
  });
}

function localFullConfig(): string {
  return JSON.stringify({
    schema_version: 1,
    profiles: [
      {
        schema_version: 1,
        id: "local-full-lab",
        mode: "local_free",
        model_access: {
          kind: "local_free",
          allowed_sources: ["in_process_test", "local_ollama"],
          allowed_providers: ["fake", "mock", "ollama"],
          ollama: {
            endpoint: "http://127.0.0.1:11434",
            default_model: "qwen3:1.7b",
            require_installed_digest: true,
          },
          credential_access: "deny",
        },
        eval_access: {
          allowed_suites: ["targeted", "smoke", "full"],
          max_attempts_per_run: 20,
        },
        docker_acquisition: { kind: "deny" },
      },
    ],
  });
}

function deepSeekRemoteConfig(
  baseUrl = "https://api.deepseek.com",
): string {
  return JSON.stringify({
    schema_version: 1,
    profiles: [
      {
        schema_version: 1,
        id: "remote-deepseek-limited",
        mode: "remote_explicit",
        model_access: {
          kind: "remote_explicit",
          providers: [
            {
              provider: "deepseek",
              models: ["deepseek-v4-flash"],
              base_urls: [baseUrl],
            },
          ],
          credential_access: "selected_provider_only",
          limits: {
            max_provider_requests_per_run: 2,
            max_output_tokens_per_request: 2048,
            max_reported_total_tokens_per_run: 20_000,
          },
        },
        eval_access: {
          allowed_suites: ["targeted", "smoke"],
          max_attempts_per_run: 2,
        },
        docker_acquisition: { kind: "deny" },
      },
    ],
  });
}

describe("Phase 15 runtime policy core", () => {
  it("loads the package local-free asset as the only implicit default", async () => {
    const workspace = await root();
    const registry = await loadRuntimePolicyRegistry({
      env: {},
      platform: "win32",
      workspace,
    });
    const effective = resolveEffectiveRuntimePolicy(registry, undefined);
    const request = resolveProviderPolicyRequest(effective, {});

    expect(registry.list()).toHaveLength(1);
    expect(effective.evidence).toMatchObject({
      credentialAccess: "deny",
      dockerAcquisitionKind: "local_locked",
      explicitSelection: false,
      paidCapable: false,
      profileId: "local-free-v1",
      profileSource: "built_in",
    });
    expect(request).toEqual({
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3:1.7b",
      provider: "ollama",
      source: "local_ollama",
    });
    expect(effective.entry.profileSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects duplicate JSON keys before schema validation", () => {
    expect(() => parseStrictJson('{"schema_version":1,"schema_version":1}')).toThrowError(
      /duplicate object key/u,
    );
  });

  it("does not let ambient remote requests select or widen the default profile", async () => {
    const workspace = await root();
    const config = join(await root(), "policy.json");
    await writeFile(config, remoteConfig(), "utf8");
    const registry = await loadRuntimePolicyRegistry({
      configPath: config,
      env: { BORN_PROVIDER: "openai", OPENAI_API_KEY: "sentinel-do-not-read" },
      platform: "win32",
      workspace,
    });
    const implicit = resolveEffectiveRuntimePolicy(registry, undefined);

    expect(implicit.entry.profile.id).toBe("local-free-v1");
    expect(() =>
      resolveProviderPolicyRequest(implicit, {
        model: "gpt-5.6-terra",
        provider: "openai",
      }),
    ).toThrowError(/policy_provider_denied/u);

    const remote = resolveEffectiveRuntimePolicy(registry, "remote-openai-limited");
    expect(resolveProviderPolicyRequest(remote, {
      model: "gpt-5.6-terra",
      provider: "openai",
    })).toEqual({
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      provider: "openai",
      source: "provider_network",
    });
  });

  it("allows only explicit DeepSeek identity and reads only its selected key", async () => {
    const workspace = await root();
    const config = join(await root(), "policy.json");
    await writeFile(config, deepSeekRemoteConfig(), "utf8");
    const registry = await loadRuntimePolicyRegistry({
      configPath: config,
      env: {},
      platform: "win32",
      workspace,
    });
    const effective = resolveEffectiveRuntimePolicy(
      registry,
      "remote-deepseek-limited",
    );

    expect(
      resolveProviderPolicyRequest(effective, {
        model: "deepseek-v4-flash",
        provider: "deepseek",
      }),
    ).toEqual({
      endpoint: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      source: "provider_network",
    });

    const reads: PropertyKey[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        ANTHROPIC_API_KEY: "must-not-be-read",
        DEEPSEEK_API_KEY: "selected-deepseek-secret",
        OPENAI_API_KEY: "must-not-be-read",
      },
      {
        get: (target, property, receiver) => {
          reads.push(property);
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    expect(
      credentialSecretsForPolicy(effective, "deepseek", environment),
    ).toEqual(["selected-deepseek-secret"]);
    expect(reads).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it.each([
    "https://api.deepseek.com/",
    "https://api.deepseek.com/v1",
    "https://deepseek.example.com",
  ])("rejects non-canonical DeepSeek base URL %s", (baseUrl) => {
    expect(() =>
      parseUserPolicyConfig(JSON.parse(deepSeekRemoteConfig(baseUrl))),
    ).toThrowError(/policy_config_invalid/u);
  });

  it("rejects remote authority stored inside the workspace", async () => {
    const workspace = await root();
    const config = join(workspace, "policy.json");
    await writeFile(config, remoteConfig(), "utf8");
    await expect(loadRuntimePolicyRegistry({
      configPath: config,
      env: {},
      platform: "win32",
      workspace,
    })).rejects.toMatchObject({
      code: "policy_config_untrusted_path",
      exitCode: 2,
    } satisfies Partial<RuntimePolicyError>);
  });

  it("keeps full eval denied by the built-in profile and allows only its locked Docker artifact", async () => {
    const workspace = await root();
    const effective = resolveEffectiveRuntimePolicy(
      await loadRuntimePolicyRegistry({ env: {}, platform: "win32", workspace }),
      undefined,
    );

    expect(() => assertEvalAccess({ attempts: 20, policy: effective, suite: "full" }))
      .toThrowError(/policy_eval_suite_denied/u);
    expect(() => assertDockerArtifactAccess(effective, "bornagent-sandbox-node-v1"))
      .not.toThrow();
    expect(() => assertDockerArtifactAccess(effective, "model-provided-image"))
      .toThrowError(/policy_docker_artifact_denied/u);
  });

  it("lets only an explicitly selected local profile authorize a full plan", async () => {
    const workspace = await root();
    const config = join(await root(), "policy.json");
    await writeFile(config, localFullConfig(), "utf8");
    const registry = await loadRuntimePolicyRegistry({
      configPath: config,
      env: {},
      platform: "win32",
      workspace,
    });
    const effective = resolveEffectiveRuntimePolicy(registry, "local-full-lab");

    expect(effective.evidence).toMatchObject({
      explicitSelection: true,
      paidCapable: false,
      profileMode: "local_free",
    });
    expect(() =>
      assertEvalAccess({ attempts: 20, policy: effective, suite: "full" }),
    ).not.toThrow();
    expect(resolveProviderPolicyRequest(effective, {
      model: "deterministic-v1",
      provider: "fake",
      source: "in_process_test",
    })).toMatchObject({ provider: "fake", source: "in_process_test" });
  });

  it("performs zero secret-property reads under local-free policy", async () => {
    const workspace = await root();
    const effective = resolveEffectiveRuntimePolicy(
      await loadRuntimePolicyRegistry({ env: {}, platform: "win32", workspace }),
      undefined,
    );
    const reads: PropertyKey[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: (_target, property) => {
          reads.push(property);
          throw new Error("a local-free credential property was read");
        },
      },
    );

    expect(credentialSecretsForPolicy(effective, "openai", environment)).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("counts failed send reservations and never silently expands the ceiling", () => {
    const ledger = new ProviderRequestLedger(2);
    expect(ledger.reserve()).toBe(1);
    expect(ledger.reserve()).toBe(2);
    expect(() => ledger.reserve()).toThrowError(/policy_request_ceiling_exceeded/u);
    expect(ledger.report()).toEqual({ maximum: 2, reserved: 2 });
  });
});
